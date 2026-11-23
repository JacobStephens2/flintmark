import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { EditorState } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { decodeUpdates, encodeUpdates } from "../../src/shared/collaboration";
import type { HostMsg, WebviewMsg } from "../../src/shared/protocol";

/** The collaboration state of a Live Preview without an editor window. */
export function livePreviewPeer(clientID: string) {
  const messages: HostMsg[] = [];
  const peer = {
    messages,
    state: EditorState.create(),
    onFlush(_requestId: number): void {},
    webview: { postMessage(message: HostMsg) {
      messages.push(message);
      if (message.type === "init") {
        peer.state = EditorState.create({
          doc: message.text.replace(/\r\n/g, "\n"),
          extensions: [collab({ clientID, startVersion: message.syncVersion })],
        });
      }
      if (message.type === "syncUpdates") {
        peer.state = peer.state.update(receiveUpdates(peer.state, decodeUpdates(message.updates))).state;
      }
      if (message.type === "flush") peer.onFlush(message.requestId);
      return true;
    } },
    edit(version: number, changes: ChangeSpec): Extract<WebviewMsg, { type: "edit" }> {
      peer.state = peer.state.update({ changes }).state;
      return {
        type: "edit", version,
        syncVersion: getSyncedVersion(peer.state),
        updates: encodeUpdates(sendableUpdates(peer.state)),
      };
    },
  };
  return peer;
}
