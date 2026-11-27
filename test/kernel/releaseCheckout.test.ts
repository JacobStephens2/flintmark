import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).stack);
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Release Check",
      GIT_AUTHOR_EMAIL: "release-check@example.com",
      GIT_COMMITTER_NAME: "Release Check",
      GIT_COMMITTER_EMAIL: "release-check@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return (result.stdout || "").trim();
}

function initRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "flintmark-release-checkout-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "README"), "base\n");
  git(cwd, ["add", "README"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return cwd;
}

function commitFile(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", name]);
}

function checkReleaseCheckout(cwd: string) {
  return spawnSync(process.execPath, [join(process.cwd(), "scripts/check-release-checkout.mjs")], {
    cwd,
    encoding: "utf8",
  });
}

function runScriptBeforeCheckout(workflowPath: string): string {
  const workflow = readFileSync(workflowPath, "utf8");
  const checkoutAt = workflow.search(/-\s+uses:\s+actions\/checkout@/);
  assert.ok(checkoutAt > 0, `${workflowPath} has no actions/checkout step`);
  const beforeCheckout = workflow.slice(0, checkoutAt);
  const runAt = beforeCheckout.lastIndexOf("run: |");
  assert.ok(runAt >= 0, `${workflowPath} does not exit before checkout`);
  assert.equal(
    beforeCheckout.slice(0, runAt).includes("uses:"),
    false,
    "a step runs before the pre-checkout refusal"
  );
  const rest = beforeCheckout.slice(runAt + "run: |".length).replace(/^\n/, "");
  const lines = rest.split("\n");
  const body: string[] = [];
  let indent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const current = line.match(/^( *)/)?.[1].length ?? 0;
    if (indent === null) indent = current;
    if (current < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join("\n").trim();
  assert.ok(script.length > 0, "pre-checkout step is empty");
  return script;
}

function runMarketplaceGuard(script: string, ref: string | undefined) {
  const env = { ...process.env };
  if (ref === undefined) delete env.GITHUB_REF;
  else env.GITHUB_REF = ref;
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env });
}

const policy =
  "does not treat every `v*` tag as a deployment target: a version tag qualifies only when its commit is on `main`, and Marketplace auth check runs only on `main`";

test("release version check passes when HEAD is the tip of origin/main", () => {
  const cwd = initRepo();
  try {
    const result = checkReleaseCheckout(cwd);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release version check passes when HEAD is an older commit on origin/main", () => {
  const cwd = initRepo();
  try {
    const older = git(cwd, ["rev-parse", "HEAD"]);
    commitFile(cwd, "later.txt", "later\n");
    git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(cwd, ["checkout", "--detach", older]);
    const result = checkReleaseCheckout(cwd);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release version check fails when HEAD is not an ancestor of origin/main", () => {
  const cwd = initRepo();
  try {
    git(cwd, ["checkout", "-b", "not-main"]);
    commitFile(cwd, "side.txt", "side\n");
    const result = checkReleaseCheckout(cwd);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /not an ancestor of refs\/remotes\/origin\/main/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release version check fails when a tag named origin/main hides refs/remotes/origin/main", () => {
  const cwd = initRepo();
  try {
    git(cwd, ["checkout", "-b", "not-main"]);
    commitFile(cwd, "side.txt", "side\n");
    // fetch-depth 0 stores every remote tag at refs/tags/*, which git resolves
    // before refs/remotes/origin/main. The real main ref stays where the
    // release step fetched it.
    git(cwd, ["tag", "origin/main"]);
    const result = checkReleaseCheckout(cwd);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /not an ancestor of refs\/remotes\/origin\/main/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release version check fails when origin/main is unavailable", () => {
  const cwd = initRepo();
  try {
    git(cwd, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const result = checkReleaseCheckout(cwd);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /refs\/remotes\/origin\/main/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release workflow version check fetches main and refuses a checkout that is not on it", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const stepAt = workflow.indexOf("Resolve version + assert tag matches package.json");
  assert.ok(stepAt > 0, "release version check step missing");
  const nextStep = workflow.indexOf("\n      - ", stepAt + 1);
  const step = workflow.slice(stepAt, nextStep);
  const fetchAt = step.search(/git fetch[^\n]*refs\/heads\/main:refs\/remotes\/origin\/main/);
  const scriptAt = step.indexOf("node scripts/check-release-checkout.mjs");
  assert.ok(fetchAt >= 0, "version check does not fetch origin/main");
  assert.ok(scriptAt > fetchAt, "version check does not run the ancestor check after fetching main");
});

test("marketplace auth check exits before checkout unless the workflow ref is refs/heads/main", () => {
  const script = runScriptBeforeCheckout(".github/workflows/marketplace-auth.yml");
  assert.equal(runMarketplaceGuard(script, "refs/heads/main").status, 0);
  for (const ref of ["refs/heads/main-evil", "refs/heads/feature", "refs/tags/v1.2.3", "refs/tags/v0", ""]) {
    const result = runMarketplaceGuard(script, ref);
    assert.notEqual(result.status, 0, `ref ${JSON.stringify(ref)} was allowed to continue`);
  }
  assert.notEqual(runMarketplaceGuard(script, undefined).status, 0);
});

function prose(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*#\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

test("releasing notes and the release workflow environment note limit marketplace tags to commits on main", () => {
  const notes = prose(readFileSync(".github/RELEASING.md", "utf8"));
  const workflow = prose(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.ok(notes.includes(policy), "RELEASING.md does not state the marketplace tag rule");
  assert.ok(workflow.includes(policy), "release workflow environment note does not state the marketplace tag rule");
  assert.equal(notes.includes("tags matching `v*`"), false);
  assert.equal(readFileSync(".github/workflows/release.yml", "utf8").includes("version tags"), false);
});

if (failed > 0) {
  console.error(`\n${failed} release checkout test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll release checkout tests passed");
