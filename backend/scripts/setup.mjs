// One-shot Cloudflare setup. Safe to re-run on a machine that holds .secrets/deploy.json: it
// reuses the database, the secrets and the Worker it finds. Requires a logged-in wrangler
// (npx wrangler login).
//
//   node scripts/setup.mjs                full setup + smoke test
//   node scripts/setup.mjs --new-secrets  the same, and allowed to replace the secrets of a live
//                                         Worker (see "Second machine" below). It stops when
//                                         it would change nothing.
//   node scripts/setup.mjs --dry-run      only the local file steps, with a fake URL, written
//                                         into a throwaway folder (for testing). Refuses to run
//                                         on a checkout that is already set up.
//
// What it does:
//   1. finds or creates the D1 database and writes wrangler.local.toml (gitignored)
//   2. loads schema.sql into the remote database
//   3. checks that the database has every column the code needs, then deploys the Worker
//      (the same code as npm run deploy, see deploy.mjs)
//   4. generates DEVICE_TOKEN, MCP_SECRET and DASH_SECRET once (kept in .secrets/deploy.json,
//      gitignored) and stores them as Worker secrets
//   5. fills INGEST_HOST and DEVICE_TOKEN into firmware/include/secrets.h
//   6. writes the Claude connector URL to .secrets/connector-url.txt and the dashboard URL
//      to .secrets/dashboard-url.txt
//   7. checks the live Worker
//
// Second machine: when the database already exists and .secrets/deploy.json does not, the
// secrets live on another machine. New ones would replace the live ones, which locks out the
// car until its board is reflashed and changes both private links. The script stops before it
// changes anything. Copy deploy.json over, or pass --new-secrets if new ones are wanted.
// A deploy.json that the live Worker does not accept (a leftover from a test, or an old
// copy) is caught the same way, after the deploy and before any secret is stored.
// Rotating one secret: delete its key from .secrets/deploy.json and run this again.
//
// Schema changes for a database that already exists are run by hand. They live in
// schema-changes/. This script only loads schema.sql, and it refuses to deploy while a
// change is missing.
// Secret values are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployWorker, failureReason, hideIds, renderLocalConfig, storedSecretsVerdict } from "./deploy.mjs";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(backend, "..");
const CONFIG = "wrangler.local.toml";
const DB = "vette";
const FLAGS = ["--dry-run", "--new-secrets"];
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const newSecrets = args.includes("--new-secrets");

// Where the local file steps write. --dry-run points all three at a throwaway folder.
const paths = {
  config: path.join(backend, CONFIG),
  secretsDir: path.join(backend, ".secrets"),
  firmwareSecrets: path.join(root, "firmware", "include", "secrets.h"),
};
// Secret name and its length in random bytes.
const SECRETS = { DEVICE_TOKEN: 16, MCP_SECRET: 24, DASH_SECRET: 24 };

const step = (m) => console.log(`\n== ${m}`);
const fail = (m) => { console.error(`\nSETUP FAILED: ${m}`); process.exit(1); };
const rel = (f) => path.relative(root, f).replaceAll("\\", "/");

// A mistyped flag must not fall through to a full live setup.
const unknown = args.filter((a) => !FLAGS.includes(a));
if (unknown.length) fail(`unknown argument ${unknown.join(" ")}. Known: ${FLAGS.join(", ")}`);

function wr(args, { allowFail = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: backend, encoding: "utf8", shell: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) {
    // The raw output holds the database id, and after an authentication error the login
    // email and the account ids. Only the masked cause is shown.
    console.error(failureReason(r.stdout ?? "", r.stderr ?? ""));
    fail(`wrangler ${args.join(" ")} exited with ${r.status}`);
  }
  return { ok: r.status === 0, out, stdout: r.stdout ?? "" };
}

function findDb() {
  const { stdout } = wr(["d1", "list", "--json"]);
  const a = stdout.indexOf("["), b = stdout.lastIndexOf("]");
  // The list holds every database id of the account, so it is never shown. Nor is the
  // parser's message, which can quote it.
  let list = null;
  try { if (a >= 0 && b > a) list = JSON.parse(stdout.slice(a, b + 1)); } catch { /* reported below */ }
  if (!Array.isArray(list)) fail("could not read the D1 list");
  return list.find((d) => d.name === DB);
}

// ---- local file steps (also used by --dry-run) -------------------------------------

function writeLocalConfig(databaseId) {
  const toml = fs.readFileSync(path.join(backend, "wrangler.toml"), "utf8");
  let local;
  try { local = renderLocalConfig(toml, databaseId); } catch (e) { fail(e.message); }
  fs.writeFileSync(paths.config, local);
}

// The stored secrets, or null when the file does not exist.
function readSecretsFile() {
  const file = path.join(paths.secretsDir, "deploy.json");
  if (!fs.existsSync(file)) return null;
  let s = null;
  // The parser's own error message can quote the file, so it is never shown.
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* reported below */ }
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    fail(`${rel(file)} is not a JSON object. Repair it by hand or restore it from your backup.`);
  }
  return s;
}

// `created` lists the names (never the values) of the secrets generated by this call.
function loadOrCreateSecrets() {
  fs.mkdirSync(paths.secretsDir, { recursive: true });
  const file = path.join(paths.secretsDir, "deploy.json");
  const s = readSecretsFile() ?? {};
  const created = [];
  for (const [name, bytes] of Object.entries(SECRETS)) {
    if (!s[name]) { s[name] = randomBytes(bytes).toString("hex"); created.push(name); }
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  return { secrets: s, created };
}

function writeFirmwareSecrets(host, deviceToken) {
  const file = paths.firmwareSecrets;
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(root, "firmware", "include", "secrets.example.h"), file);
  let h = fs.readFileSync(file, "utf8");
  const set = (name, value) => {
    const re = new RegExp(`^(#define\\s+${name}\\s+)"[^"]*"`, "m");
    if (!re.test(h)) fail(`${name} not found in ${rel(file)}`);
    h = h.replace(re, `$1"${value}"`);
  };
  set("INGEST_HOST", host);
  set("DEVICE_TOKEN", deviceToken);
  fs.writeFileSync(file, h);
  return file;
}

function writeConnectorUrl(url, mcpSecret) {
  const file = path.join(paths.secretsDir, "connector-url.txt");
  fs.writeFileSync(file, `${url}/mcp/${mcpSecret}\n`);
  return file;
}

function writeDashboardUrl(url, dashSecret) {
  const file = path.join(paths.secretsDir, "dashboard-url.txt");
  fs.writeFileSync(file, `${url}/dash/${dashSecret}/\n`);
  return file;
}

// ---- live checks -------------------------------------------------------------------

// One harmless request per secret that tells whether the live Worker accepts a value.
// A wrong path secret gets 404 and a wrong device token gets 401.
const PROBES = [
  { name: "DASH_SECRET", accepted: async (url, v) => (await fetch(`${url}/dash/${v}/`)).status !== 404 },
  { name: "MCP_SECRET", accepted: async (url, v) => (await fetch(`${url}/mcp/${v}`, { method: "POST", body: "{}" })).status !== 404 },
  {
    name: "DEVICE_TOKEN",
    accepted: async (url, v) => (await fetch(`${url}/ingest`, {
      method: "POST", headers: { Authorization: `Bearer ${v}` }, body: new Uint8Array(0),
    })).status !== 401,
  },
];

async function waitHealthy(url) {
  // On a brand new workers.dev subdomain, DNS resolves quickly but the TLS certificate
  // can take several minutes. Until then every HTTPS handshake fails.
  let healthy = false;
  for (let i = 0; i < 90 && !healthy; i++) {
    try { healthy = (await fetch(`${url}/health`)).ok; } catch { /* not up yet */ }
    if (!healthy) {
      if (i === 3) console.log("not answering yet (normal for a new subdomain), waiting up to 15 minutes");
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  if (!healthy) fail(`${url}/health did not answer within 15 minutes. Everything is deployed, so just run this again later.`);
}

async function smoke(url, secrets) {
  await waitHealthy(url);
  console.log("health: ok");

  const bad = await fetch(`${url}/ingest`, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: new Uint8Array(48) });
  if (bad.status !== 401) fail(`/ingest accepted a wrong token (status ${bad.status})`);
  console.log("ingest rejects a wrong token: ok");

  const good = await fetch(`${url}/ingest`, {
    method: "POST", headers: { Authorization: `Bearer ${secrets.DEVICE_TOKEN}` }, body: new Uint8Array(0),
  });
  if (!good.ok) fail(`/ingest refused the real device token (status ${good.status}): ${await good.text()}`);
  console.log("ingest accepts the device token and reaches the database: ok");

  const mcp = await fetch(`${url}/mcp/${secrets.MCP_SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const tools = mcp.ok ? (await mcp.json()).result?.tools?.map((t) => t.name) : null;
  if (!tools?.length) fail(`MCP endpoint did not list tools (status ${mcp.status})`);
  console.log(`mcp tools: ${tools.join(", ")}`);

  const wrong = await fetch(`${url}/mcp/not-the-secret`, { method: "POST", body: "{}" });
  if (wrong.status !== 404) fail(`MCP answered on a wrong secret path (status ${wrong.status})`);
  console.log("mcp hides behind the secret path: ok");

  // A secret stored a moment ago can take a few seconds to reach every Cloudflare location.
  let page, html = "";
  for (let i = 0; i < 12 && !html.includes("<title>Corvette</title>"); i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000));
    page = await fetch(`${url}/dash/${secrets.DASH_SECRET}/`);
    html = page.ok ? await page.text() : "";
  }
  if (!html.includes("<title>Corvette</title>")) fail(`dashboard page did not load (status ${page.status})`);
  const st = await fetch(`${url}/dash/${secrets.DASH_SECRET}/api/status`);
  const body = await st.text();
  let answered = false;
  try { answered = st.ok && "latest" in JSON.parse(body); } catch { /* not JSON */ }
  // An error answer carries the database's own message (for example a missing column).
  // A good answer holds car data and is never shown.
  if (!answered) fail(`dashboard API did not answer (status ${st.status})${st.ok ? "" : `: ${body.slice(0, 300)}`}`);
  const hidden = await fetch(`${url}/dash/not-the-secret/`);
  if (hidden.status !== 404) fail(`dashboard answered on a wrong secret path (status ${hidden.status})`);
  console.log("dashboard page and API: ok, hidden behind its secret path");
}

// ---- main --------------------------------------------------------------------------

if (dryRun) {
  step("dry run: local file steps only");
  // A set-up checkout holds the real config and the real secrets. The dry run has no reason
  // to be near them, so it refuses instead of relying on every write being redirected.
  const real = [paths.config, path.join(paths.secretsDir, "deploy.json")].filter((f) => fs.existsSync(f));
  if (real.length) {
    fail(`--dry-run only runs on a checkout that was never set up. Found ${real.map(rel).join(" and ")}. Nothing was written.`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vette-setup-dry-run-"));
  paths.config = path.join(tmp, CONFIG);
  paths.secretsDir = path.join(tmp, ".secrets");
  paths.firmwareSecrets = path.join(tmp, "secrets.h");
  writeLocalConfig("00000000-0000-0000-0000-000000000000");
  const { secrets } = loadOrCreateSecrets();
  console.log("wrote", paths.config);
  console.log("wrote", writeFirmwareSecrets("example.workers.dev", secrets.DEVICE_TOKEN));
  console.log("wrote", writeConnectorUrl("https://example.workers.dev", secrets.MCP_SECRET));
  console.log("wrote", writeDashboardUrl("https://example.workers.dev", secrets.DASH_SECRET));
  console.log(`\nNothing in the repository was touched. The secrets in ${tmp} are throwaway values.`);
  console.log("Delete that folder when you are done.");
  process.exit(0);
}

step("checking Cloudflare login");
if (/not authenticated/i.test(wr(["whoami"], { allowFail: true }).out)) {
  fail("wrangler is not logged in. Run:  npx wrangler login   then run this again.");
}

step(`finding D1 database "${DB}"`);
let db = findDb();
const dbExisted = Boolean(db);
const stored = readSecretsFile();
const haveSecrets = Boolean(stored) && Object.keys(SECRETS).some((k) => stored[k]);
// An existing database with no stored secrets means the live Worker's secrets are somewhere
// else. Generating new ones here would replace them. Stop before anything is changed.
if (dbExisted && !haveSecrets && !newSecrets) {
  fail([
    `the database "${DB}" already exists, but ${rel(path.join(paths.secretsDir, "deploy.json"))} is missing or holds no secrets.`,
    "That file holds the three secrets of the live Worker. Going on would generate new ones and",
    "store them on the live Worker:",
    "  DEVICE_TOKEN  the car is locked out until its board is reflashed with the new token",
    "  MCP_SECRET    the Claude connector URL changes and the old one stops working",
    "  DASH_SECRET   the dashboard link changes and the old one stops working",
    "Nothing was changed.",
    "",
    "Second machine: copy backend/.secrets/deploy.json from the first machine or from your",
    "backup into the same place here, then run this again.",
    "If the old secrets are lost, if you want new ones, or if a first setup stopped before it",
    "stored any, run:  npm run setup -- --new-secrets",
  ].join("\n"));
}
if (dbExisted && !haveSecrets) console.log("--new-secrets given: new secrets will replace the ones on the live Worker");

// Secrets created together with the database, see below.
let early = null;
if (!db) {
  console.log("not found, creating it");
  // Write the secrets file before the database exists. If any later step fails, the re-run
  // finds the database and the file together and does not mistake this checkout for a
  // second machine.
  early = loadOrCreateSecrets();
  wr(["d1", "create", DB]);
  db = findDb();
  if (!db) fail("database was created but does not show up in the list");
}
writeLocalConfig(db.uuid);
console.log(`database ready, wrote ${CONFIG}`);

step("loading schema into the remote database");
wr(["d1", "execute", DB, "--remote", "--file=schema.sql", "--config", CONFIG, "--yes"]);
console.log("schema applied");

// schema.sql only creates what is missing. Columns added to an existing table come from the
// files in schema-changes/, run by hand. deployWorker refuses to deploy without them.
step("checking the remote database, then deploying the Worker");
let deployOut;
try { deployOut = deployWorker(); } catch (e) { fail(e.message); }
const url = deployOut.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
if (!url) { console.error(hideIds(deployOut).trim()); fail("deployed, but no workers.dev URL in the output"); }
console.log(`deployed to ${url}`);

step("setting Worker secrets");
const { secrets, created } = early ?? loadOrCreateSecrets();
// Secrets that deploy.json held before this run must be the ones the live Worker uses.
// A leftover or outdated file would otherwise replace the live secrets without a word.
const probe = dbExisted ? PROBES.find((p) => !created.includes(p.name)) : null;
if (probe) {
  await waitHealthy(url);
  let live;
  try { live = await probe.accepted(url, secrets[probe.name]); }
  catch { fail("could not reach the Worker to check the stored secrets. Nothing was stored. Run this again."); }
  const verdict = storedSecretsVerdict({
    newSecrets, created: created.length, live,
    workerHasIt: () => {
      const list = wr(["secret", "list", "--config", CONFIG], { allowFail: true });
      // When the list cannot be read, assume the Worker has secrets and stop.
      return !list.ok || list.out.includes(`"${probe.name}"`);
    },
  });
  const file = rel(path.join(paths.secretsDir, "deploy.json"));
  if (verdict === "mismatch") {
    fail([
      `${file} does not match the live Worker, which refused the stored ${probe.name}.`,
      "The code was deployed. No secret was stored, the Worker keeps the ones it has.",
      "Copy the right deploy.json from the first machine or from your backup and run this again.",
      "If the stored values are the ones you want live, run:  npm run setup -- --new-secrets",
      "For new values, delete the keys from the file first.",
    ].join("\n"));
  }
  if (verdict === "nothing-new") {
    fail([
      `--new-secrets has nothing to do: ${file} holds all three secrets and the live Worker uses them.`,
      "The code was deployed. No secret changed.",
      "To rotate a secret, delete its key from the file and run:  npm run setup",
    ].join("\n"));
  }
  if (!live) {
    console.log(newSecrets
      ? "--new-secrets given: the stored secrets replace the ones on the live Worker"
      : "the Worker has no secrets yet, storing them");
  }
}
const tmp = path.join(paths.secretsDir, "bulk.tmp.json");
fs.writeFileSync(tmp, JSON.stringify({
  DEVICE_TOKEN: secrets.DEVICE_TOKEN, MCP_SECRET: secrets.MCP_SECRET, DASH_SECRET: secrets.DASH_SECRET,
}));
try { wr(["secret", "bulk", path.relative(backend, tmp), "--config", CONFIG]); } finally { fs.rmSync(tmp, { force: true }); }
console.log(created.length
  ? `generated ${created.join(", ")} and stored all three secrets`
  : "re-used existing secrets and stored them");

step("writing device and connector settings");
const fw = writeFirmwareSecrets(new URL(url).host, secrets.DEVICE_TOKEN);
const conn = writeConnectorUrl(url, secrets.MCP_SECRET);
const dash = writeDashboardUrl(url, secrets.DASH_SECRET);
console.log(`firmware settings: ${fw}`);
console.log(`connector URL:     ${conn}`);
console.log(`dashboard URL:     ${dash}`);

step("checking the live Worker");
await smoke(url, secrets);

console.log(`\nDone. Worker: ${url}`);
console.log("Next: set WIFI_SSID / WIFI_PASS in firmware/include/secrets.h, flash, and add the");
console.log("URL from .secrets/connector-url.txt as a custom connector in Claude.");
console.log("Dashboard: open the URL in .secrets/dashboard-url.txt on any device.");
console.log("Schema: this script only loads schema.sql. Changes to a database that already exists");
console.log("live in backend/schema-changes/ and are run by hand. Setup and npm run deploy stop when one is missing.");
console.log("Keep a copy of .secrets/deploy.json somewhere safe. A second machine needs it.");
if (dbExisted && created.length) {
  // The live Worker already uses the new values. Say what still holds an old one.
  console.log("\nNew secrets are live. What still has to change:");
  if (created.includes("DEVICE_TOKEN")) {
    console.log("  DEVICE_TOKEN  flash the board with the updated secrets.h. Until then the car cannot upload.");
  }
  if (created.includes("MCP_SECRET")) {
    console.log("  MCP_SECRET    replace the custom connector in Claude with the URL in .secrets/connector-url.txt.");
  }
  if (created.includes("DASH_SECRET")) {
    console.log("  DASH_SECRET   open the new link in .secrets/dashboard-url.txt and replace bookmarks and home screen icons.");
  }
}
