import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { sendableUpdates } from "@codemirror/collab";
import { livePreviewPeer } from "../../fixtures/livePreviewPeer";
import { livePreviewFixture, waitForSynchronization } from "./livePreviewFixture";
import type { Peer } from "./livePreviewFixture";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("Save barriers with real VS Code disk writes", () => {
  for (const eol of ["LF", "CRLF"]) for (const entry of ["preview-clean", "native-clean", "native-dirty", "api-dirty", "slow-native", "repeated-preview", "typing-during-write", "auto-dirty", "saveall-dirty"]) {
    it(eol + " / " + entry + " flushes both peers including input still in transit", async () => {
      const sep = eol === "CRLF" ? "\r\n" : "\n";
      const initial = "# Save" + sep;
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flintmark-save-barrier-")), "note.md");
      fs.writeFileSync(file, initial);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      const subscriptions: vscode.Disposable[] = [];
      const { host, openPeer, synchronization } = livePreviewFixture(document, subscriptions);
      let receipts = 0;
      const makePanel = (id: string) => {
        const panel = livePreviewPeer(id);
        let buffered = true;
        panel.onFlush = async requestId => {
          // Neither this input nor its receipt is in the host at save entry.
          await sleep(20);
          if (buffered) {
            buffered = false;
            send(panel, id + " answer.\n");
          }
          receipts++;
          synchronization.acknowledgeFlush(panel, requestId);
        };
        return panel;
      };
      function send(panel: ReturnType<typeof livePreviewPeer>, insert: string) {
        synchronization.submitEdit(document, panel, panel.edit(document.version, { from: panel.state.doc.length, insert }));
      }
      const a = makePanel("FIRST"), b = makePanel("SECOND");
      await openPeer(a);
      await openPeer(b);
      const apply = host.apply;
      let first = true;
      host.apply = async (...args) => {
        if (first) { first = false; await sleep(entry === "slow-native" ? 1800 : 80); }
        return apply(...args);
      };
      const config = vscode.workspace.getConfiguration("files", document.uri);
      const oldAutoSave = config.inspect<string>("autoSave")?.globalValue;
      const oldAutoDelay = config.inspect<number>("autoSaveDelay")?.globalValue;
      try {
        if (entry === "auto-dirty") {
          await config.update("autoSaveDelay",100,vscode.ConfigurationTarget.Global);
          await config.update("autoSave","afterDelay",vscode.ConfigurationTarget.Global);
        }
        if (entry.endsWith("dirty")) {
          const change = new vscode.WorkspaceEdit();
          change.insert(document.uri,new vscode.Position(0,0),"Dirty prefix" + sep);
          assert.equal(await vscode.workspace.applyEdit(change),true);
        } else assert.equal(document.isDirty,false);
        if (entry === "typing-during-write") {
          let injected = false;
          subscriptions.push(vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document !== document || injected) return;
            injected = true;
            send(a,"AFTER save barrier.\n");
            event.waitUntil(sleep(60).then(() => []));
          }));
          assert.equal(await synchronization.saveDocument(document), true);
          await waitForSynchronization(() => sendableUpdates(a.state).length === 0, "the edit received during persistence");
          assert.equal(fs.readFileSync(file,"utf8").includes("AFTER save barrier."),false,"later input must not race the earlier disk write");
          assert.equal(document.isDirty,true,"later edits remain visibly unsaved");
          assert.equal(await synchronization.saveDocument(document), true);
        }
        else if (entry === "auto-dirty") { /* Wait below for the actual auto-save. */ }
        else if (entry === "saveall-dirty") await vscode.commands.executeCommand("workbench.action.files.saveFiles");
        else if (entry === "api-dirty") await document.save();
        else if (entry === "preview-clean") assert.equal(await synchronization.saveDocument(document), true);
        else if (entry === "repeated-preview") {
          assert.deepEqual(await Promise.all([synchronization.saveDocument(document), synchronization.saveDocument(document)]), [true, true]);
        }
        else await vscode.commands.executeCommand("workbench.action.files.save", document.uri);
        // Slow native participants return within VS Code's budget, then finish
        // the same save once pending remote input has reached the host.
        await waitForSynchronization(
          () => receipts >= 2 && !document.isDirty && fs.readFileSync(file, "utf8").includes("SECOND answer."),
          "both peers' edits on disk",
        );
        const disk=fs.readFileSync(file,"utf8");
        assert.equal(receipts >= 2,true,"every panel must acknowledge the flush");
        assert.equal(disk,document.getText());
        assert.equal(disk.includes("FIRST answer."),true);
        assert.equal(disk.includes("SECOND answer."),true);
        assert.equal(document.isDirty,false);
        assert.equal(disk.replace(/\r\n/g,"\n"), a.state.doc.toString());
        assert.equal(a.state.doc.toString(), b.state.doc.toString());
        if (eol === "CRLF") assert.equal(/(?<!\r)\n/.test(disk),false);
      } finally {
        if (entry === "auto-dirty") {
          await config.update("autoSave",oldAutoSave,vscode.ConfigurationTarget.Global);
          await config.update("autoSaveDelay",oldAutoDelay,vscode.ConfigurationTarget.Global);
        }
        for (const subscription of subscriptions) subscription.dispose();
      }
    });
  }
});


describe("Save barrier failures", () => {
  for (const failure of ["undelivered", "timeout", "wrong-peer", "conflict"]) {
    it("does not report a successful preview save after " + failure, async () => {
      const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"flintmark-save-failure-")),"note.md");
      fs.writeFileSync(file,"original\n");
      const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const subscriptions: vscode.Disposable[]=[];
      const { host, openPeer, synchronization } = livePreviewFixture(document, subscriptions);
      const wrongPeer: Peer = { webview: { postMessage: () => true } };
      const panel = livePreviewPeer("failed-peer");
      const post = panel.webview.postMessage;
      panel.webview.postMessage = message => {
        if (message.type !== "flush") return post(message);
        if (failure === "undelivered") return false;
        if (failure === "timeout") return true;
        queueMicrotask(() => synchronization.acknowledgeFlush(failure === "wrong-peer" ? wrongPeer : panel, message.requestId));
        return true;
      };
      await openPeer(panel);
      const apply = host.apply;
      if (failure === "conflict") {
        host.apply = async () => false;
        synchronization.submitEdit(document, panel, panel.edit(document.version, { from: 9, insert: "pending\n" }));
      }
      try {
        await assert.rejects(synchronization.saveDocument(document),failure==="conflict"?/unsynchronized/:failure==="undelivered"?/closed/:/did not respond/);
        assert.equal(fs.readFileSync(file,"utf8"),"original\n");
        // Recovery is observable through the same save entry point, rather
        // than by inspecting the coordinator's private request registry.
        host.apply = apply;
        if (failure === "conflict") synchronization.retry(document);
        panel.webview.postMessage = post;
        panel.onFlush = requestId => queueMicrotask(() => synchronization.acknowledgeFlush(panel, requestId));
        assert.equal(await synchronization.saveDocument(document), true);
        assert.equal(fs.readFileSync(file,"utf8"),failure==="conflict"?"original\npending\n":"original\n");
      } finally {for(const subscription of subscriptions)subscription.dispose();}
    });
  }
});

describe("Slow native disk writes", () => {
  it("finishes synchronization that completes during the initial disk write", async () => {
    let bytes=Buffer.from("# Slow disk\n");
    let writes=0;
    const subscriptions:vscode.Disposable[]=[];
    const changed=new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    const scheme="flintmark-slow-save";
    subscriptions.push(changed,vscode.workspace.registerFileSystemProvider(scheme,{
      onDidChangeFile:changed.event,watch:()=>new vscode.Disposable(()=>{}),
      stat:()=>({type:vscode.FileType.File,ctime:0,mtime:0,size:bytes.length}),
      readDirectory:()=>[],createDirectory:()=>{},delete:()=>{},rename:()=>{},
      readFile:()=>bytes,
      writeFile:async (_uri,data)=>{const snapshot=Buffer.from(data);writes++;if(writes===1)await sleep(1800);bytes=snapshot;},
    },{isCaseSensitive:true}));
    const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(scheme+":/note.md"));
    await vscode.window.showTextDocument(document);
    const { host, openPeer, synchronization } = livePreviewFixture(document, subscriptions);
    const panel = livePreviewPeer("slow-peer");
    let buffered = true;
    panel.onFlush = requestId => {
      if (buffered) {
        buffered = false;
        const edit = panel.edit(document.version, { from: panel.state.doc.length, insert: "Complete pending answer.\n" });
        synchronization.submitEdit(document, panel, edit);
      }
      queueMicrotask(() => synchronization.acknowledgeFlush(panel, requestId));
    };
    await openPeer(panel);
    const apply = host.apply;
    host.apply = async (...args) => {
      await sleep(1500);
      return apply(...args);
    };
    try {
      await vscode.commands.executeCommand("workbench.action.files.save",document.uri);
      await waitForSynchronization(
        () => !document.isDirty && bytes.toString().includes("Complete pending answer."),
        "synchronized text on the slow filesystem",
      );
      assert.equal(writes >= 2,true,"a stale completed write requires a forced follow-up even when the host is clean");
      assert.equal(bytes.toString(),"# Slow disk\nComplete pending answer.\n");
      assert.equal(document.isDirty,false);
    } finally {for(const subscription of subscriptions)subscription.dispose();}
  });
 });
