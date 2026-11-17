import assert from "node:assert/strict";
import { VaultPublication } from "../../src/extension/vault/vaultPublication";
import type { NoteSnapshot } from "../../src/extension/vault/vaultSnapshot";
import { VaultIndexBuildCancelled } from "../../src/extension/vault/vaultIndex";

function snapshot(entries: readonly [string, string][]): NoteSnapshot<string> {
  return {
    inputs: new Map(entries.map(([path, text]) => [path, { path, text }])),
    uris: new Map(entries.map(([path]) => [path, path])),
  };
}

function harness() {
  const roots = new Map<string, NoteSnapshot<string>>();
  const fallbacks: { root: string; reason: string }[] = [];
  const errors: unknown[] = [];
  const publications: { notes: string[]; tags: string[] }[] = [];
  let onChange = () => {};
  let ticks = 0;
  let nextYield: (() => Promise<void>) | undefined;
  const publication = new VaultPublication({
    snapshot: (root: string) => roots.get(root),
    snapshots: () => roots.values(),
    requestRefresh: (root, reason) => { fallbacks.push({ root, reason }); },
  }, {
    onDidChange: () => {
      publications.push(publication.getVaultData());
      onChange();
    },
    onError: (error) => { errors.push(error); },
    now: () => ticks += 9,
    yieldNow: () => {
      const held = nextYield;
      nextYield = undefined;
      return held ? held() : Promise.resolve();
    },
  });
  return {
    publication, roots, fallbacks, errors, publications,
    observe(callback: () => void) { onChange = callback; },
    hold() {
      assert.equal(nextYield, undefined, "previous yield gate must be reached first");
      let arrive!: () => void;
      let release!: () => void;
      let fail!: (error: unknown) => void;
      const reached = new Promise<void>((resolve) => { arrive = resolve; });
      const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
      nextYield = () => { arrive(); return gate; };
      return { reached, release, fail };
    },
  };
}

async function main(): Promise<void> {
  const h = harness();
  const p = h.publication;
  assert.deepEqual(p.getAllNotes(), []);
  assert.deepEqual(p.getBacklinks("missing"), []);
  assert.deepEqual(p.getOutgoingLinks("missing"), []);
  assert.deepEqual(p.getUnresolvedLinks("missing"), []);
  assert.deepEqual(p.getTagged("missing"), []);
  assert.deepEqual(p.getAllTags(), []);
  assert.deepEqual(p.getVaultData(), { notes: [], tags: [] });
  assert.equal(p.resolveLink("missing"), null);
  assert.equal(p.resolveLinkUri("missing"), undefined);
  await p.waitForCurrentBuild();
  console.log("  ✓ queries start empty before any refresh");

  const alpha = "custom://vault/Alpha%20Note.md";
  const beta = "custom://vault/Beta.md";
  h.roots.set("root", snapshot([
    [beta, "[[Alpha Note]] [[Missing]] #Zebra #apple"],
    [alpha, "#apple"],
    ["custom://vault/nested/Alpha%20Note.md", ""],
  ]));
  h.observe(() => {
    assert.equal(p.resolveLink("Alpha Note"), alpha);
    assert.equal(p.resolveLinkUri("Alpha Note"), alpha);
    assert.deepEqual(p.getBacklinks(alpha), [beta]);
    assert.deepEqual(p.getOutgoingLinks(beta), [alpha]);
    assert.deepEqual(p.getUnresolvedLinks(beta), ["Missing"]);
    assert.deepEqual(p.getTagged("APPLE"), [alpha, beta]);
    assert.deepEqual(p.getVaultData(), { notes: ["Alpha Note", "Beta"], tags: ["apple", "zebra"] });
  });
  p.requestRebuild();
  await p.waitForCurrentBuild();
  assert.equal(h.publications.length, 1);
  assert.deepEqual(h.errors, []);
  const data = p.getVaultData();
  data.notes.length = 0;
  data.tags.push("pollution");
  assert.deepEqual(p.getVaultData(), { notes: ["Alpha Note", "Beta"], tags: ["apple", "zebra"] });
  p.dispose();
  console.log("  ✓ observers read a complete graph, original URI lookup, and defensive sorted autocomplete");

  const content = harness();
  const cp = content.publication;
  content.roots.set("root", snapshot([["/Alpha.md", "[[Beta]] #old"], ["/Beta.md", "#keep"]]));
  cp.requestRebuild();
  await cp.waitForCurrentBuild();
  const original = cp.getAllNotes()[0];
  content.roots.set("root", snapshot([["/Alpha.md", "[[Missing]] #new"], ["/Beta.md", "#updated"]]));
  content.observe(() => {
    assert.deepEqual(cp.getBacklinks("/Beta.md"), []);
    assert.deepEqual(cp.getUnresolvedLinks("/Alpha.md"), ["Missing"]);
    assert.deepEqual(cp.getVaultData(), { notes: ["Alpha", "Beta"], tags: ["new", "updated"] });
  });
  cp.refreshContent("root", ["/Alpha.md", "/Beta.md"]);
  assert.equal(content.publications.length, 2, "idle content publishes synchronously");
  assert.equal(cp.getAllNotes()[0], original, "content preserves existing note references");
  assert.deepEqual(content.errors, []);
  cp.dispose();
  console.log("  ✓ idle content updates the existing graph and autocomplete atomically without rebuilding");

  {
    const h = harness();
    const p = h.publication;
    const initial = snapshot([["/Alpha.md", "#initial"]]);
    h.roots.set("root", initial);
    const first = h.hold();
    let followUp: ReturnType<typeof h.hold> | undefined;
    h.observe(() => {
      if (h.publications.length === 1) {
        assert.equal(p.resolveLinkUri("Alpha"), "/Alpha.md");
        assert.deepEqual(p.getVaultData(), { notes: ["Alpha"], tags: ["initial"] });
        followUp = h.hold();
      } else {
        assert.equal(p.resolveLinkUri("Alpha"), undefined);
        assert.equal(p.resolveLinkUri("Beta"), "/Beta.md");
        assert.deepEqual(p.getBacklinks("/Beta.md"), ["/Gamma.md"]);
        assert.deepEqual(p.getVaultData(), { notes: ["Beta", "Gamma"], tags: ["latest"] });
      }
    });
    p.requestRebuild();
    const firstBuild = p.waitForCurrentBuild();
    await first.reached;
    // Mutating the source maps cannot change the inputs/URI entries already
    // captured by the held build.
    initial.inputs.clear();
    initial.uris.clear();
    h.roots.set("root", snapshot([["/Alpha.md", "#middle"], ["/Beta.md", "#middle"]]));
    p.requestRebuild();
    p.refreshContent("root", ["/Beta.md"]);
    p.requestRebuild();
    h.roots.set("root", snapshot([["/Beta.md", "#latest"], ["/Gamma.md", "[[Beta]]"]]));
    p.refreshContent("root", ["/Beta.md", "/Gamma.md"]);
    assert.deepEqual(p.getAllNotes(), []);
    assert.deepEqual(h.fallbacks, []);
    first.release();
    await firstBuild;
    assert.ok(followUp);
    await followUp.reached;
    assert.equal(h.publications.length, 1, "first publication does not wait for reconciliation");
    assert.deepEqual(p.getVaultData(), { notes: ["Alpha"], tags: ["initial"] });
    const latestBuild = p.waitForCurrentBuild();
    assert.notEqual(latestBuild, firstBuild, "waiter captures one current build");
    followUp.release();
    await latestBuild;
    assert.equal(h.publications.length, 2, "overlapping refreshes coalesce into one follow-up");
    assert.deepEqual(h.errors, []);
    p.dispose();
    console.log("  ✓ full/content traffic finishes the first build then publishes latest snapshots in one follow-up");
  }

  {
    const h = harness();
    const p = h.publication;
    h.roots.set("root", snapshot([["/Alpha.md", "#old"], ["/Beta.md", "#old"]]));
    p.requestRebuild();
    await p.waitForCurrentBuild();
    const missingInput = snapshot([["/Alpha.md", "#partial"]]);
    h.roots.set("root", missingInput);
    p.refreshContent("root", ["/Alpha.md", "/Beta.md"]);
    p.refreshContent("absent-root", ["/Alpha.md"]);
    assert.deepEqual(h.fallbacks, [
      { root: "root", reason: "content-patch-missing" },
      { root: "absent-root", reason: "content-patch-missing" },
    ]);
    assert.deepEqual(p.getVaultData(), { notes: ["Alpha", "Beta"], tags: ["old"] });
    assert.equal(h.publications.length, 1, "missing input batches never partially publish");
    h.roots.set("root", snapshot([["/Alpha.md", "#partial"], ["/New.md", "#new"]]));
    p.refreshContent("root", ["/Alpha.md", "/New.md"]);
    assert.deepEqual(h.fallbacks[2], { root: "root", reason: "content-patch-index-missing" });
    assert.deepEqual(p.getVaultData(), { notes: ["Alpha", "Beta"], tags: ["old"] });
    assert.equal(h.publications.length, 1);
    p.dispose();
    console.log("  ✓ idle missing-root/input and missing-index fallbacks retain the whole publication");
  }

  {
    const h = harness();
    const p = h.publication;
    h.roots.set("root", snapshot([["/Alpha.md", "#first"]]));
    const gate = h.hold();
    p.requestRebuild();
    const build = p.waitForCurrentBuild();
    await gate.reached;
    h.roots.set("root", snapshot([["/Alpha.md", "#partial"]]));
    p.refreshContent("root", ["/Alpha.md", "/Missing.md"]);
    p.refreshContent("absent-root", ["/Alpha.md"]);
    assert.deepEqual(h.fallbacks, [
      { root: "root", reason: "content-patch-missing" },
      { root: "absent-root", reason: "content-patch-missing" },
    ], "missing data is reported immediately during a full build");
    gate.release();
    await build;
    assert.equal(h.publications.length, 1, "invalid content does not schedule a partial follow-up");
    assert.deepEqual(p.getVaultData(), { notes: ["Alpha"], tags: ["first"] });
    p.dispose();
    console.log("  ✓ missing content data requests fallback immediately even during a held full build");
  }

  {
    const h = harness();
    const p = h.publication;
    h.roots.set("root", snapshot([["/Retained.md", "#retained"]]));
    p.requestRebuild();
    await p.waitForCurrentBuild();
    const failure = new Error("controlled cooperative failure");
    h.roots.set("root", snapshot([["/Failed.md", "#failed"]]));
    const gate = h.hold();
    p.requestRebuild();
    const failedBuild = p.waitForCurrentBuild();
    await gate.reached;
    h.roots.set("root", snapshot([["/Recovered.md", "#recovered"]]));
    p.requestRebuild();
    const followUp = h.hold();
    gate.fail(failure);
    await failedBuild;
    await followUp.reached;
    assert.deepEqual(h.errors, [failure], "ordinary failure reports once");
    assert.equal(h.publications.length, 1);
    assert.equal(p.resolveLinkUri("Retained"), "/Retained.md");
    assert.deepEqual(p.getVaultData(), { notes: ["Retained"], tags: ["retained"] });
    followUp.release();
    await p.waitForCurrentBuild();
    assert.deepEqual(p.getVaultData(), { notes: ["Recovered"], tags: ["recovered"] });
    const retryGate = h.hold();
    p.requestRebuild();
    const retry = p.waitForCurrentBuild();
    await retryGate.reached;
    retryGate.fail(failure);
    await retry;
    assert.deepEqual(h.errors, [failure, failure]);
    assert.equal(h.publications.length, 2);
    h.roots.set("root", snapshot([["/Retry.md", "#retry"]]));
    p.requestRebuild();
    await p.waitForCurrentBuild();
    assert.deepEqual(p.getVaultData(), { notes: ["Retry"], tags: ["retry"] });
    p.dispose();
    console.log("  ✓ failures retain complete data, report once, run pending work, and allow later retries");
  }

  {
    const h = harness();
    const p = h.publication;
    h.roots.set("root", snapshot([["/Retained.md", "#retained"]]));
    p.requestRebuild();
    await p.waitForCurrentBuild();
    h.roots.set("root", snapshot([["/Late.md", "#late"]]));
    const gate = h.hold();
    p.requestRebuild();
    const build = p.waitForCurrentBuild();
    await gate.reached;
    p.requestRebuild();
    p.dispose();
    gate.release();
    await build;
    p.requestRebuild();
    p.refreshContent("missing", ["/Late.md"]);
    await p.waitForCurrentBuild();
    assert.equal(h.publications.length, 1);
    assert.deepEqual(p.getVaultData(), { notes: ["Retained"], tags: ["retained"] });
    assert.deepEqual(h.errors, [], "disposal cancellation is silent");
    assert.deepEqual(h.fallbacks, []);
    p.dispose();
    console.log("  ✓ disposal during a yield cancels silently and prevents late publication, follow-ups, and refreshes");
  }

  {
    const h = harness();
    const p = h.publication;
    h.roots.set("root", snapshot([["/Cancelled.md", "#cancelled"]]));
    const gate = h.hold();
    p.requestRebuild();
    const build = p.waitForCurrentBuild();
    await gate.reached;
    h.roots.set("root", snapshot([["/Follow.md", "#follow"]]));
    p.requestRebuild();
    gate.fail(new VaultIndexBuildCancelled());
    await build;
    await p.waitForCurrentBuild();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.publications, [{ notes: ["Follow"], tags: ["follow"] }]);
    p.dispose();
    console.log("  ✓ cooperative cancellation is silent and still permits the pending follow-up");
  }

  {
    const h = harness();
    const p = h.publication;
    const first = snapshot([["/Same.md", "#first"]]);
    const last = snapshot([["/Same.md", "#last"]]);
    first.uris.set("/Same.md", "custom://original/first%20token");
    last.uris.set("/Same.md", "custom://original/last%2520token");
    h.roots.set("first", first);
    h.roots.set("last", last);
    p.requestRebuild();
    await p.waitForCurrentBuild();
    assert.deepEqual(p.getAllNotes().map((note) => note.tags), [["first"], ["last"]]);
    assert.equal(p.resolveLinkUri("Same"), "custom://original/last%2520token");
    assert.deepEqual(p.getVaultData(), { notes: ["Same"], tags: ["first", "last"] });
    p.dispose();
    console.log("  ✓ root order and duplicate inputs survive while duplicate URI keys use the last original token");
  }
}

const timeout = setTimeout(() => {
  console.error("  ✗ Vault index publication tests did not complete");
  process.exitCode = 1;
}, 5000);
void main()
  .catch((error) => { console.error("  ✗ Vault index publication", error); process.exitCode = 1; })
  .finally(() => clearTimeout(timeout));
