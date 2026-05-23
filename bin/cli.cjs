#!/usr/bin/env node
"use strict";

/**
 * Launcher for the npm-distributed `@vigolium/vigolium-audit` (single package).
 *
 * The real CLI is a self-contained `bun build --compile` binary that embeds
 * the Bun runtime and the content bundle — it needs neither Bun nor Node to
 * run. To keep the install to ONE package without shipping ~330 MB of raw
 * binaries, this package carries every platform binary brotli-compressed
 * (`vigolium-audit-<version>-<platform>-<arch>.br`, ~95 MB total). This shim — the
 * only JS that ever runs under the user's Node — picks the one matching the
 * host, decompresses it once into a cache dir, then execs it (passing through
 * argv, stdio, and exit status). Decompression uses Node's built-in zlib, so
 * the package has zero runtime dependencies.
 */

const { spawnSync } = require("child_process");
const { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const SUPPORTED = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

const key = `${process.platform}-${process.arch}`;

if (!SUPPORTED.includes(key)) {
  console.error(
    `vigolium-audit: no prebuilt binary for ${key}.\n` +
      `Supported: ${SUPPORTED.join(", ")}.\n` +
      `(Windows is not supported — build from source with Bun instead: https://github.com)`,
  );
  process.exit(1);
}

const version = String(require(path.join(__dirname, "..", "package.json")).version);
const compressed = path.join(__dirname, `vigolium-audit-${version}-${key}.br`);

if (!existsSync(compressed)) {
  console.error(
    `vigolium-audit: bundled binary "${path.basename(compressed)}" is missing from the package.\n` +
      `Reinstall with: npm install -g @vigolium/vigolium-audit`,
  );
  process.exit(1);
}

/**
 * Candidate cache roots, tried in order. The first writable one wins, so an
 * unwritable / read-only $HOME degrades to a tmpdir rather than failing.
 */
function cacheCandidates() {
  const dirs = [];
  if (process.env.XDG_CACHE_HOME) dirs.push(path.join(process.env.XDG_CACHE_HOME, "vigolium-audit", "bin", version));
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".cache", "vigolium-audit", "bin", version));
  dirs.push(path.join(os.tmpdir(), "vigolium-audit-bin", version));
  return dirs;
}

/** Decompress `compressed` into `<dir>/vigolium-audit-<key>` exactly once; return the path. */
function materialize(dir) {
  const target = path.join(dir, `vigolium-audit-${key}`);
  // Fast path: a prior run already extracted it (rename below is atomic, so a
  // file under this exact name is always complete).
  if (existsSync(target) && statSync(target).size > 0) return target;

  mkdirSync(dir, { recursive: true });
  const buf = zlib.brotliDecompressSync(readFileSync(compressed));
  const tmp = path.join(dir, `.vigolium-audit-${key}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, buf, { mode: 0o755 });
  renameSync(tmp, target); // atomic within the same directory
  return target;
}

let binPath;
let lastErr;
for (const dir of cacheCandidates()) {
  try {
    binPath = materialize(dir);
    break;
  } catch (e) {
    lastErr = e;
  }
}

if (!binPath) {
  console.error(
    `vigolium-audit: could not unpack the binary for ${key}.\n` +
      `Last error: ${lastErr && lastErr.message ? lastErr.message : String(lastErr)}`,
  );
  process.exit(1);
}

// npm preserves no exec bit through brotli; we set 0o755 on write, but a
// defensive chmod removes an entire class of "Permission denied" reports.
try {
  chmodSync(binPath, 0o755);
} catch {
  /* best-effort: already executable, or chmod denied — let spawn surface it */
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`vigolium-audit: failed to launch ${binPath}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  // Re-raise so the parent shell observes the same termination cause.
  process.kill(process.pid, result.signal);
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 1);
