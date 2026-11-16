import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logState } from "../fixtures/aiLogVscode";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "flintmark-ai-log-"));
  const tempVariables = ["TMPDIR", "TMP", "TEMP"];
  const previousTemp = tempVariables.map(key => process.env[key]);
  const previousUmask = process.umask(0);
  for (const key of tempVariables) process.env[key] = root;
  try {
    const { aiLog, aiLogForce, showAiLog, LOG_FILE } = await import("../../src/extension/ai/aiLog");
    assert.equal(LOG_FILE, join(root, "flintmark-ai.log"));
    aiLog("disabled trace");
    assert.equal(existsSync(LOG_FILE), false);
    assert.deepEqual(logState.lines, []);
    showAiLog();
    assert.match(logState.lines.at(-1)!, /AI debug logging is OFF/);
    assert.equal(logState.shown, true);
    assert.equal(existsSync(LOG_FILE), false);
    console.log("  ✓ automatic tracing stays off by default and showing the channel does not create a file");

    aiLogForce("forced diagnostic");
    logState.enabled = true;
    aiLog("enabled trace");
    const expected = logState.lines.slice(-2).map(line => line + "\n").join("");
    assert.match(expected, /^\d{2}:\d{2}:\d{2}\.\d{3}  forced diagnostic\n\d{2}:\d{2}:\d{2}\.\d{3}  enabled trace\n$/);
    assert.equal(readFileSync(LOG_FILE, "utf8"), expected);
    console.log("  ✓ forced diagnostics bypass the setting and enabled tracing appends the same timestamped lines as the channel");

    if (process.platform !== "win32") {
      assert.equal(statSync(LOG_FILE).mode & 0o777, 0o600);
      console.log("  ✓ new AI log files are readable and writable only by their owner, even with a permissive umask");

      rmSync(LOG_FILE);
      const target = join(root, "existing-target");
      writeFileSync(target, "untouched");
      symlinkSync(target, LOG_FILE);
      assert.doesNotThrow(() => aiLogForce("refused symlink diagnostic"));
      assert.equal(readFileSync(target, "utf8"), "untouched");
      assert.equal(lstatSync(LOG_FILE).isSymbolicLink(), true);
      assert.match(logState.lines.at(-1)!, /  refused symlink diagnostic$/);
      console.log("  ✓ symlink destinations retain their target while forced diagnostics still reach the output channel");

      rmSync(LOG_FILE);
      const absentTarget = join(root, "absent-target");
      symlinkSync(absentTarget, LOG_FILE);
      assert.doesNotThrow(() => aiLog("refused dangling symlink trace"));
      assert.equal(existsSync(absentTarget), false);
      assert.equal(lstatSync(LOG_FILE).isSymbolicLink(), true);
      assert.match(logState.lines.at(-1)!, /  refused dangling symlink trace$/);
      console.log("  ✓ dangling symlinks cannot create a target and enabled tracing still reaches the output channel");
    }

    rmSync(LOG_FILE, { force: true });
    mkdirSync(LOG_FILE);
    assert.doesNotThrow(() => aiLogForce("failed file diagnostic"));
    assert.match(logState.lines.at(-1)!, /  failed file diagnostic$/);
    assert.doesNotThrow(() => aiLog("failed file trace"));
    assert.match(logState.lines.at(-1)!, /  failed file trace$/);
    console.log("  ✓ file failures remain best-effort for both forced and automatic logging");

    rmSync(LOG_FILE, { recursive: true });
    aiLog("recovered trace");
    assert.equal(readFileSync(LOG_FILE, "utf8"), logState.lines.at(-1) + "\n");
    console.log("  ✓ file logging recovers on the next call after a refused destination is removed");
  } finally {
    process.umask(previousUmask);
    tempVariables.forEach((key, i) => {
      if (previousTemp[i] === undefined) delete process.env[key];
      else process.env[key] = previousTemp[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error("  ✗ AI logging", error); process.exitCode = 1; });
