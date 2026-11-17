import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

    const assertChannelAcceptsBoth = (label: string): void => {
      assert.doesNotThrow(() => aiLogForce(`${label} diagnostic`));
      assert.doesNotThrow(() => aiLog(`${label} trace`));
      assert.ok(logState.lines.at(-2)!.endsWith(`  ${label} diagnostic`));
      assert.ok(logState.lines.at(-1)!.endsWith(`  ${label} trace`));
    };

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

      rmSync(LOG_FILE);
      execFileSync("mkfifo", [LOG_FILE]);
      chmodSync(LOG_FILE, 0o600);
      const fifoMode = lstatSync(LOG_FILE).mode & 0o777;
      const readerFd = openSync(LOG_FILE, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        assertChannelAcceptsBoth("refused fifo");
        const buf = Buffer.alloc(1024);
        let bytesRead = 0;
        try {
          bytesRead = readSync(readerFd, buf, 0, buf.length, null);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        }
        assert.equal(bytesRead, 0);
        assert.equal(lstatSync(LOG_FILE).isFIFO(), true);
        assert.equal(lstatSync(LOG_FILE).mode & 0o777, fifoMode);
      } finally {
        closeSync(readerFd);
      }
      assert.doesNotThrow(() => aiLog("refused fifo without reader"));
      assert.match(logState.lines.at(-1)!, /  refused fifo without reader$/);
      console.log("  ✓ non-regular descriptors (FIFO) are refused without writing or modifying permissions");

      for (const mode of [0o640, 0o620, 0o610, 0o604, 0o602, 0o601, 0o644, 0o666]) {
        rmSync(LOG_FILE);
        writeFileSync(LOG_FILE, "existing\n");
        chmodSync(LOG_FILE, mode);
        assertChannelAcceptsBoth(`refused mode ${mode.toString(8)}`);
        assert.equal(readFileSync(LOG_FILE, "utf8"), "existing\n");
        assert.equal(statSync(LOG_FILE).mode & 0o777, mode);
      }
      console.log("  ✓ existing files with group or other permission bits are refused without modifying permissions");

      rmSync(LOG_FILE);
      writeFileSync(LOG_FILE, "prior\n");
      chmodSync(LOG_FILE, 0o600);
      aiLog("recovered into compliant file");
      assert.equal(readFileSync(LOG_FILE, "utf8"), "prior\n" + logState.lines.at(-1) + "\n");
      chmodSync(LOG_FILE, 0o700);
      aiLog("owner-only 700 trace");
      assert.equal(
        readFileSync(LOG_FILE, "utf8"),
        "prior\n" + logState.lines.slice(-2).map(line => line + "\n").join("")
      );
      assert.equal(statSync(LOG_FILE).mode & 0o777, 0o700);
      console.log("  ✓ file logging resumes once replaced by a compliant owner-only file");

      if (typeof process.geteuid === "function") {
        rmSync(LOG_FILE);
        writeFileSync(LOG_FILE, "foreign-owner\n");
        chmodSync(LOG_FILE, 0o600);
        const previousGeteuid = process.geteuid;
        const foreignUid = previousGeteuid() + 1;
        process.geteuid = () => foreignUid;
        try {
          assertChannelAcceptsBoth("refused foreign owner");
        } finally {
          process.geteuid = previousGeteuid;
        }
        assert.equal(readFileSync(LOG_FILE, "utf8"), "foreign-owner\n");
        assert.equal(statSync(LOG_FILE).mode & 0o777, 0o600);
        console.log("  ✓ files not owned by the current user are refused without modifying permissions");

        aiLog("recovered for owner");
        assert.equal(readFileSync(LOG_FILE, "utf8"), "foreign-owner\n" + logState.lines.at(-1) + "\n");
        console.log("  ✓ file logging resumes for a compliant owner-matched file");
      }
    }

    rmSync(LOG_FILE, { force: true });
    mkdirSync(LOG_FILE);
    assertChannelAcceptsBoth("failed file");
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
