import { execFileSync } from "node:child_process";

// Fixed on purpose. A caller-supplied ref could name HEAD and pass for every checkout.
const mainRef = "origin/main";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const head = git(["rev-parse", "HEAD"]).trim();
if (gitOrNull(["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`]) === null) {
  console.error(`::error::${mainRef} is not available; refusing a release checkout that is not on main`);
  process.exit(1);
}
if (gitOrNull(["merge-base", "--is-ancestor", "HEAD", mainRef]) === null) {
  console.error(`::error::HEAD ${head} is not an ancestor of ${mainRef}`);
  process.exit(1);
}
console.log(`Release checkout ${head} is an ancestor of ${mainRef}.`);
