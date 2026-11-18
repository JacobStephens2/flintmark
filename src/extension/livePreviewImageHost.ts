import * as vscode from "vscode";
import { LivePreviewImagePublication } from "./livePreviewImagePublication";
import type { ImageIndexService } from "./vault/imageIndexService";
import type { HostMsg } from "../shared/protocol";

/** Capture the live document and this panel's URI/message boundary once. */
export function createLivePreviewImagePublication(
  document: vscode.TextDocument,
  webview: vscode.Webview,
  imageIndex?: ImageIndexService,
): LivePreviewImagePublication {
  return new LivePreviewImagePublication({
    readText: () => document.getText(),
    resolveIndexed: (reference, requireImageExt) => {
      const hit = imageIndex?.resolveImage(document.uri, reference, requireImageExt);
      return hit ? webview.asWebviewUri(hit).toString() : undefined;
    },
    resolveLegacy: reference => {
      const uri = reference.startsWith("/")
        ? vscode.Uri.file(reference)
        : vscode.Uri.joinPath(vscode.Uri.joinPath(document.uri, ".."), reference);
      return webview.asWebviewUri(uri).toString();
    },
    postMap: map => {
      const message: HostMsg = { type: "imageMap", map };
      webview.postMessage(message);
    },
  });
}
