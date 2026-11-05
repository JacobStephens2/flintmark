import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolve, dirname } from "node:path";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

// VM modules keep the real acceptance entrypoints intact while substituting
// only the OS, clock and Electron/Playwright boundaries. Node 20 needs this flag.
if (!SourceTextModule) {
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", process.argv[1]], {
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}

let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

function acceptanceModule(entry: string, globals: object, boundaries: Record<string, object> = {}) {
  const context = createContext({ console, ...globals });
  const modules = new Map();
  function load(file: string): SourceTextModule {
    if (!modules.has(file)) {
      modules.set(file, new SourceTextModule(readFileSync(file, "utf8"), { context, identifier: file }));
    }
    return modules.get(file);
  }
  const module = load(resolve("test/acceptance", entry));
  return {
    module,
    async evaluate() {
      await module.link((specifier, parent) => {
        const boundary = boundaries[specifier];
        if (boundary) {
          return new SyntheticModule(Object.keys(boundary), function () {
            for (const [key, value] of Object.entries(boundary)) this.setExport(key, value);
          }, { context });
        }
        assert.ok(specifier.startsWith("."), `Unexpected system boundary: ${specifier}`);
        return load(resolve(dirname(parent.identifier), specifier));
      });
      await module.evaluate();
    },
  };
}

async function nativeWindow({ platform = "win32", executable = "", sizingErrors = [] as Error[] } = {}) {
  let ready = false;
  let sizes = 0;
  let waits = 0;
  const keys: string[] = [];
  const win = {
    async waitForSelector(selector: string) {
      assert.equal(selector, ".monaco-workbench");
      waits++;
      ready = true;
    },
    locator: () => ({ isVisible: async () => false }),
    keyboard: { press: async (key: string) => { keys.push(key); } },
  };
  const app = {
    async evaluate(callback: (electron: object) => void) {
      if (!ready) throw new Error("electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.");
      const error = sizingErrors.shift();
      if (error) { ready = false; throw error; }
      callback({ BrowserWindow: { getAllWindows: () => [{
        isDestroyed: () => false,
        setSize: (width: number, height: number) => {
          assert.deepEqual([width, height], [1400, 1000]);
          sizes++;
        },
      }] } });
    },
  };
  const entry = acceptanceModule("native-window.mjs", { process: { platform, env: { VSCODE_BIN: executable } } });
  await entry.evaluate();
  return { adapt: () => entry.module.namespace.adaptWindow(win, app), win, keys,
    get sizes() { return sizes; }, get waits() { return waits; } };
}

async function todoStartup({ active = true, mountDelay = 20000, live = true, tabLabel = "alpha.md" } = {}) {
  let now = 0;
  let closed = false;
  let initialFailureAt: number | undefined;
  let query = "";
  let mountAt = 4500 + mountDelay;
  const selected: string[] = [];
  const reachedTodo = new Error("Initial Live Preview ready; reached Todo assertions");
  const choiceName = () => query.startsWith(">") ? query.slice(1) : "alpha.md";
  const row = {
    get innerText() { return choiceName(); },
    querySelector: (selector: string) => ({ textContent: selector === ".label-name" ? choiceName() : "" }),
    getAttribute: () => "",
    getClientRects: () => [1],
  };
  function locator(selector: string): any {
    // Stop at the next functional group: this fixture covers initial open only.
    if (selector === ".pane") throw reachedTodo;
    return {
      locator, first() { return this; }, nth() { return this; },
      async waitFor() {},
      async isVisible() { return selector === ".antigravity-ide-welcome-button" ? false : live && now >= mountAt; },
      async count() {
        if (selector === '.tab.active[data-resource-name="alpha.md"]') return active ? 1 : 0;
        return live && now >= mountAt ? 1 : 0;
      },
      async innerText() { return selector === ".cm-content" ? "alpha tail" : choiceName(); },
      async allInnerTexts() { return []; },
      async allTextContents() { return active ? [tabLabel] : []; },
      async inputValue() { return query; },
      async fill(value: string) { query = value; },
      async evaluateAll(callback: (elements: object[]) => object) { return callback([row]); },
      async click() {
        if (selector === ".monaco-list-row") {
          selected.push(query);
          active = true;
          if (query.startsWith(">")) { live = true; mountAt = now; }
        }
      },
    };
  }
  const frame = { locator, parentFrame: () => null };
  const win = {
    locator,
    async waitForSelector() {},
    async waitForTimeout(ms: number) { now += ms; },
    async bringToFront() {},
    keyboard: { async press() {} },
    frames: () => [frame],
    async evaluate() { return null; },
    async screenshot() {},
  };
  const app = { firstWindow: async () => win, close: async () => { closed = true; } };
  const entry = acceptanceModule("todo-strict.e2e.mjs", {
    console: { log() {}, error() {} },
    process: { platform: "linux", env: { FLINTMARK_DEPS: "/deps", VSCODE_BIN: "/vscode", FLINTMARK_REPO: "/repo" } },
    Date: class extends Date { static now() { return now; } },
    setTimeout, clearTimeout,
    getComputedStyle: () => ({ visibility: "visible" }),
  }, {
    "node:module": { createRequire: () => () => ({ _electron: { launch: async () => app } }) },
    "node:fs": {
      mkdtempSync: (prefix: string) => prefix + "fixture", mkdirSync() {}, readFileSync() {},
      writeFileSync(file: string) {
        if (file.includes("alpha-initial-open-failure")) initialFailureAt = now;
      },
    },
    "node:os": { tmpdir: () => "/tmp" },
    "node:path": { join: path.join, resolve },
    "node:assert": { default: assert },
  });
  let error: unknown;
  try { await entry.evaluate(); } catch (caught) { error = caught; }
  assert.equal(closed, true, "the acceptance entrypoint must close its Electron instance");
  return { error, reachedTodo, selected, initialFailureAt };
}

async function run() {
  await test("cold Windows window can finish navigation before sizing", async () => {
    const fixture = await nativeWindow();
    assert.equal(await fixture.adapt(), fixture.win);
    assert.equal(fixture.sizes, 1);
  });

  await test("window sizing survives one navigation after workbench readiness", async () => {
    const fixture = await nativeWindow({ sizingErrors: [new Error("Execution context was destroyed, most likely because of a navigation.")] });
    await fixture.adapt();
    assert.equal(fixture.sizes, 1);
    assert.equal(fixture.waits, 2);
  });

  await test("window sizing propagates a second navigation failure", async () => {
    const second = new Error("Execution context was destroyed, most likely because of a navigation.");
    const fixture = await nativeWindow({ sizingErrors: [new Error(second.message), second] });
    await assert.rejects(fixture.adapt(), error => error === second);
    assert.equal(fixture.waits, 2);
    assert.equal(fixture.sizes, 0);
  });

  await test("window sizing propagates unrelated errors without retry", async () => {
    const error = new Error("Electron application has been closed");
    const fixture = await nativeWindow({ sizingErrors: [error] });
    await assert.rejects(fixture.adapt(), caught => caught === error);
    assert.equal(fixture.waits, 1);
  });

  await test("Cursor still resizes on Linux and macOS keyboard adaptation is preserved", async () => {
    const cursor = await nativeWindow({ platform: "linux", executable: "/opt/cursor/cursor" });
    await cursor.adapt();
    assert.equal(cursor.sizes, 1);
    const mac = await nativeWindow({ platform: "darwin" });
    await mac.adapt();
    for (const key of ["Control+y", "Control+Shift+BracketLeft", "Control+Home", "End", "Control+s"]) {
      await mac.win.keyboard.press(key);
    }
    assert.deepEqual(mac.keys, ["Meta+Shift+z", "Meta+Alt+BracketLeft", "Meta+ArrowUp", "Meta+ArrowRight", "Meta+s"]);
    assert.equal(mac.sizes, 0);
  });

  await test("CLI-opened alpha can mount after 20 seconds without redundant Quick Open", async () => {
    const result = await todoStartup();
    assert.ok(result.error === result.reachedTodo, String(result.error));
    assert.deepEqual(result.selected, []);
  });

  await test("initial alpha mounting near 30 seconds is still accepted", async () => {
    const result = await todoStartup({ mountDelay: 29750 });
    assert.ok(result.error === result.reachedTodo, String(result.error));
    assert.deepEqual(result.selected, []);
  });

  await test("CLI alpha with a separate extension suffix is not reopened", async () => {
    const result = await todoStartup({ tabLabel: "alpha" });
    assert.ok(result.error === result.reachedTodo, String(result.error));
    assert.deepEqual(result.selected, [], "active alpha.md must not be reopened when its label-name is alpha");
  });

  await test("Quick Open still selects alpha when the CLI editor is not active", async () => {
    const result = await todoStartup({ active: false, mountDelay: 20000 });
    assert.ok(result.error === result.reachedTodo, String(result.error));
    assert.deepEqual(result.selected, ["alpha.md"]);
  });

  await test("wrong editor association still fails even when diagnostic switching repairs it", async () => {
    const result = await todoStartup({ live: false });
    assert.match(String(result.error), /alpha.md did not open in Live Preview on initial open.*repaired=true/);
    assert.equal(result.initialFailureAt, 34500);
    assert.deepEqual(result.selected, [">Flintmark: Switch to Live View"]);
  });

  await test("initial alpha mount beyond 30 seconds still fails", async () => {
    const result = await todoStartup({ mountDelay: 35000 });
    assert.match(String(result.error), /alpha.md did not open in Live Preview on initial open/);
    assert.equal(result.initialFailureAt, 34500);
  });

  if (failed) process.exitCode = 1;
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
