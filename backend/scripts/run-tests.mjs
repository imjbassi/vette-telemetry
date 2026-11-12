// Runs the backend tests. Usage: node scripts/run-tests.mjs [extra "node --test" options]
// The tests are plain test/*.test.mjs files that import the TypeScript sources directly, so
// each one is bundled first with the esbuild that wrangler already installed, then the
// bundles are handed to "node --test". Nothing here talks to Cloudflare.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");
const buildRoot = join(root, ".wrangler", "test-build"); // .wrangler/ is git-ignored
// Every run builds into a folder of its own. Two runs at the same time used to share one
// folder, and the second failed with EPERM when it deleted the bundles the first was running.
// A fresh folder also means a deleted test cannot keep running from an old bundle.
const outDir = join(buildRoot, `run-${Date.now()}-${process.pid}`);

const names = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).sort();
if (!names.length) {
  console.error(`no *.test.mjs files in ${testDir}`);
  process.exit(1);
}

// Cleaning up is best effort and never fails a run. On Windows a folder that is still in use
// cannot be removed, and then it simply stays for a later run to remove.
const remove = (path, olderThanMs = 0) => {
  try {
    if (olderThanMs && Date.now() - statSync(path).mtimeMs < olderThanMs) return;
    rmSync(path, { recursive: true, force: true });
  } catch { /* still in use, or already gone */ }
};
// Leftovers of runs that were killed. Only old ones: a young folder may belong to a run that
// is still going.
let leftovers = [];
try { leftovers = readdirSync(buildRoot); } catch { /* no build folder yet */ }
for (const name of leftovers) remove(join(buildRoot, name), 10 * 60 * 1000);
mkdirSync(outDir, { recursive: true });

try {
  await build({
    entryPoints: names.map((f) => join(testDir, f)),
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    // .html as text like wrangler does for the dashboard page. .sql as text so tests can run
    // schema.sql and the maintenance scripts without caring where the bundle lives.
    loader: { ".html": "text", ".sql": "text" },
    external: ["node:*"],
    sourcemap: "inline",
    logLevel: "warning",
  });
} catch {
  // esbuild has already printed what is wrong.
  remove(outDir);
  process.exit(1);
}

// Plain file names with the build folder as working directory: "node --test" reads its
// arguments as glob patterns, and Windows paths are full of backslashes.
const run = spawnSync(
  process.execPath,
  ["--test", "--enable-source-maps", "--disable-warning=ExperimentalWarning", ...process.argv.slice(2), ...names],
  { cwd: outDir, stdio: "inherit" },
);
remove(outDir);
process.exit(run.status ?? 1);
