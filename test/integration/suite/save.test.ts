import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { EditorState } from "@codemirror/state";
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { decodeUpdates, encodeUpdates } from "../../../src/shared/collaboration";
import { livePreviewFixture } from "./livePreviewFixture";
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
      const f = livePreviewFixture(document, subscriptions);
      await f.edits.initialize(document, () => {});
      const uri = document.uri.toString();
      const clients = new Map<any, EditorState>();
      let receipts = 0;
      const makePanel = (id: string) => {
        let buffered = true;
        const panel: any = { webview: { postMessage: (message: any) => {
          if (message.type === "syncUpdates") clients.set(panel, clients.get(panel)!.update(receiveUpdates(clients.get(panel)!, decodeUpdates(message.updates))).state);
          if (message.type === "flush") {
            void (async () => {
              // Neither this input nor its receipt is in the host at save entry.
              await sleep(20);
              if (buffered) { buffered = false; send(panel, id + " answer.\n"); }
              receipts++;
              f.saves.acknowledge(panel, message.requestId);
            })();
          }
          return Promise.resolve(true);
        } } };
        clients.set(panel, EditorState.create({doc:initial.replace(/\r\n/g,"\n"),extensions:[collab({clientID:id})]}));
        return panel;
      };
      function send(panel: any, insert: string) {
        const current = clients.get(panel)!;
        const next = current.update({changes:{from:current.doc.length,insert}}).state;
        clients.set(panel,next);
        f.edits.submit(document,panel,{type:"edit",version:document.version,syncVersion:getSyncedVersion(next),updates:encodeUpdates(sendableUpdates(next))});
      }
      const a = makePanel("FIRST"), b = makePanel("SECOND");
      f.addPeer(a); f.addPeer(b);
      const apply = f.host.apply;
      let first = true;
      f.host.apply = async (...args: Parameters<typeof apply>) => {
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
          assert.equal(await f.saves.saveDocument(document),true);
          await f.queue.drain(uri);
          assert.equal(fs.readFileSync(file,"utf8").includes("AFTER save barrier."),false,"later input must not race the earlier disk write");
          assert.equal(document.isDirty,true,"later edits remain visibly unsaved");
          assert.equal(await f.saves.saveDocument(document),true);
        }
        else if (entry === "auto-dirty") { /* Wait below for the actual auto-save. */ }
        else if (entry === "saveall-dirty") await vscode.commands.executeCommand("workbench.action.files.saveFiles");
        else if (entry === "api-dirty") await document.save();
        else if (entry === "preview-clean") assert.equal(await f.saves.saveDocument(document),true);
        else if (entry === "repeated-preview") assert.deepEqual(await Promise.all([f.saves.saveDocument(document),f.saves.saveDocument(document)]),[true,true]);
        else await vscode.commands.executeCommand("workbench.action.files.save", document.uri);
        // Slow native participants return within VS Code's budget, then finish
        // the same save once pending remote input has reached the host.
        for (let i=0;i<100;i++) {
          if (receipts >= 2 && !document.isDirty && fs.readFileSync(file,"utf8").includes("SECOND answer.")) break;
          await sleep(50);
        }
        const disk=fs.readFileSync(file,"utf8");
        assert.equal(receipts >= 2,true,"every panel must acknowledge the flush");
        assert.equal(disk,document.getText());
        assert.equal(disk.includes("FIRST answer."),true);
        assert.equal(disk.includes("SECOND answer."),true);
        assert.equal(document.isDirty,false);
        assert.equal(disk.replace(/\r\n/g,"\n"),clients.get(a)!.doc.toString());
        assert.equal(clients.get(a)!.doc.toString(),clients.get(b)!.doc.toString());
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
      const f = livePreviewFixture(document, subscriptions);
      await f.edits.initialize(document, () => {});
      const panel:any={webview:{postMessage:(message:any)=>{
        if(message.type!=="flush")return Promise.resolve(true);
        if(failure==="undelivered")return Promise.resolve(false);
        if(failure==="timeout")return Promise.resolve(true);
        queueMicrotask(()=>{ f.saves.acknowledge(failure==="wrong-peer"?{webview:{postMessage:()=>true}}:panel,message.requestId); });
        return Promise.resolve(true);
      }}};
      f.addPeer(panel);
      const apply=f.host.apply;
      if(failure==="conflict") {
        f.host.apply=async()=>false;
        const client=EditorState.create({doc:"original\n",extensions:[collab({clientID:"failed-peer"})]})
          .update({changes:{from:9,insert:"pending\n"}}).state;
        f.edits.submit(document,panel,{type:"edit",version:document.version,syncVersion:0,updates:encodeUpdates(sendableUpdates(client))});
      }
      try {
        await assert.rejects(f.saves.saveDocument(document),failure==="conflict"?/unsynchronized/:failure==="undelivered"?/closed/:/did not respond/);
        assert.equal(fs.readFileSync(file,"utf8"),"original\n");
        // Recovery is observable through the same save entry point, rather
        // than by inspecting the coordinator's private request registry.
        f.host.apply=apply;
        if(failure==="conflict")f.edits.retry(document);
        panel.webview.postMessage = (message: any) => {
          queueMicrotask(() => { f.saves.acknowledge(panel, message.requestId); });
          return Promise.resolve(true);
        };
        assert.equal(await f.saves.saveDocument(document),true);
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
    const f = livePreviewFixture(document, subscriptions);
    await f.edits.initialize(document, () => {});
    let sent=false;
    const panel:any={webview:{postMessage:(message:any)=>{
      if(message.type==="flush"){
        if(!sent){sent=true;let client=EditorState.create({doc:document.getText(),extensions:[collab({clientID:"slow-peer"})]});client=client.update({changes:{from:client.doc.length,insert:"Complete pending answer.\n"}}).state;f.edits.submit(document,panel,{type:"edit",version:document.version,syncVersion:getSyncedVersion(client),updates:encodeUpdates(sendableUpdates(client))});}
        queueMicrotask(()=>{f.saves.acknowledge(panel, message.requestId);});
      }
      return Promise.resolve(true);
    }}};
    f.addPeer(panel);
    const apply=f.host.apply;f.host.apply=async (...args:Parameters<typeof apply>)=>{await sleep(1500);return apply(...args);};
    try {
      await vscode.commands.executeCommand("workbench.action.files.save",document.uri);
      for(let i=0;i<100;i++){if(!document.isDirty&&bytes.toString().includes("Complete pending answer."))break;await sleep(50);}
      assert.equal(writes >= 2,true,"a stale completed write requires a forced follow-up even when the host is clean");
      assert.equal(bytes.toString(),"# Slow disk\nComplete pending answer.\n");
      assert.equal(document.isDirty,false);
    } finally {for(const subscription of subscriptions)subscription.dispose();}
  });
 });
