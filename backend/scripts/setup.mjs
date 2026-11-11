// One-shot Cloudflare setup. Safe to re-run: it reuses the database, the secrets and the
// Worker it finds. Requires a logged-in wrangler (npx wrangler login).
//
//   node scripts/setup.mjs            full setup + smoke test
//   node scripts/setup.mjs --dry-run  only the local file steps, with a fake URL (for testing)
//
// What it does:
//   1. finds or creates the D1 database and writes wrangler.local.toml (gitignored)
//   2. loads schema.sql into the remote database
//   3. deploys the Worker
//   4. generates DEVICE_TOKEN and MCP_SECRET once (kept in .secrets/, gitignored) and
//      stores them as Worker secrets
//   5. fills INGEST_HOST and DEVICE_TOKEN into firmware/include/secrets.h
//   6. writes the Claude connector URL to .secrets/connector-url.txt
//   7. checks the live Worker
// Secret values are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(backend, "..");
const CONFIG = "wrangler.local.toml";
const DB = "vette";
const secretsDir = path.join(backend, ".secrets");
const dryRun = process.argv.includes("--dry-run");

const step = (m) => console.log(`\n== ${m}`);
const fail = (m) => { console.error(`\nSETUP FAILED: ${m}`); process.exit(1); };

function wr(args, { allowFail = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: backend, encoding: "utf8", shell: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) {
    console.error(out.trim());
    fail(`wrangler ${args.join(" ")} exited with ${r.status}`);
  }
  return { ok: r.status === 0, out, stdout: r.stdout ?? "" };
}

function findDb() {
  const { stdout } = wr(["d1", "list", "--json"]);
  const a = stdout.indexOf("["), b = stdout.lastIndexOf("]");
  if (a < 0 || b < 0) fail(`could not read the D1 list:\n${stdout}`);
  return JSON.parse(stdout.slice(a, b + 1)).find((d) => d.name === DB);
}

// ---- local file steps (also used by --dry-run) -------------------------------------

function writeLocalConfig(databaseId) {
  const toml = fs.readFileSync(path.join(backend, "wrangler.toml"), "utf8");
  if (!/^database_id\s*=.*$/m.test(toml)) fail("wrangler.toml has no database_id line");
  fs.writeFileSync(path.join(backend, CONFIG), toml.replace(/^database_id\s*=.*$/m, `database_id = "${databaseId}"`));
}

function loadOrCreateSecrets() {
  fs.mkdirSync(secretsDir, { recursive: true });
  const file = path.join(secretsDir, "deploy.json");
  let s = {};
  if (fs.existsSync(file)) s = JSON.parse(fs.readFileSync(file, "utf8"));
  let created = false;
  if (!s.DEVICE_TOKEN) { s.DEVICE_TOKEN = randomBytes(16).toString("hex"); created = true; }
  if (!s.MCP_SECRET) { s.MCP_SECRET = randomBytes(24).toString("hex"); created = true; }
  if (!s.DASH_SECRET) { s.DASH_SECRET = randomBytes(24).toString("hex"); created = true; }
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  return { secrets: s, created };
}

function writeFirmwareSecrets(host, deviceToken) {
  const dir = path.join(root, "firmware", "include");
  const file = path.join(dir, "secrets.h");
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(dir, "secrets.example.h"), file);
  let h = fs.readFileSync(file, "utf8");
  const set = (name, value) => {
    const re = new RegExp(`^(#define\\s+${name}\\s+)"[^"]*"`, "m");
    if (!re.test(h)) fail(`${name} not found in firmware/include/secrets.h`);
    h = h.replace(re, `$1"${value}"`);
  };
  set("INGEST_HOST", host);
  set("DEVICE_TOKEN", deviceToken);
  fs.writeFileSync(file, h);
  return file;
}

function writeConnectorUrl(url, mcpSecret) {
  const file = path.join(secretsDir, "connector-url.txt");
  fs.writeFileSync(file, `${url}/mcp/${mcpSecret}\n`);
  return file;
}

function writeDashboardUrl(url, dashSecret) {
  const file = path.join(secretsDir, "dashboard-url.txt");
  fs.writeFileSync(file, `${url}/dash/${dashSecret}/\n`);
  return file;
}

// ---- live checks -------------------------------------------------------------------

async function smoke(url, secrets) {
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
  if (!st.ok || !("latest" in (await st.json()))) fail(`dashboard API did not answer (status ${st.status})`);
  const hidden = await fetch(`${url}/dash/not-the-secret/`);
  if (hidden.status !== 404) fail(`dashboard answered on a wrong secret path (status ${hidden.status})`);
  console.log("dashboard page and API: ok, hidden behind its secret path");
}

// ---- main --------------------------------------------------------------------------

if (dryRun) {
  step("dry run: local file steps only");
  writeLocalConfig("00000000-0000-0000-0000-000000000000");
  const { secrets } = loadOrCreateSecrets();
  console.log("wrote", CONFIG);
  console.log("wrote", writeFirmwareSecrets("example.workers.dev", secrets.DEVICE_TOKEN));
  console.log("wrote", writeConnectorUrl("https://example.workers.dev", secrets.MCP_SECRET));
  process.exit(0);
}

step("checking Cloudflare login");
if (/not authenticated/i.test(wr(["whoami"], { allowFail: true }).out)) {
  fail("wrangler is not logged in. Run:  npx wrangler login   then run this again.");
}

step(`finding D1 database "${DB}"`);
let db = findDb();
if (!db) {
  console.log("not found, creating it");
  wr(["d1", "create", DB]);
  db = findDb();
  if (!db) fail("database was created but does not show up in the list");
}
writeLocalConfig(db.uuid);
console.log(`database ready, wrote ${CONFIG}`);

step("loading schema into the remote database");
wr(["d1", "execute", DB, "--remote", "--file=schema.sql", "--config", CONFIG, "--yes"]);
console.log("schema applied");

step("deploying the Worker");
const deploy = wr(["deploy", "--config", CONFIG]);
const url = deploy.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
if (!url) { console.error(deploy.out.trim()); fail("deployed, but no workers.dev URL in the output"); }
console.log(`deployed to ${url}`);

step("setting Worker secrets");
const { secrets, created } = loadOrCreateSecrets();
const tmp = path.join(secretsDir, "bulk.tmp.json");
fs.writeFileSync(tmp, JSON.stringify({
  DEVICE_TOKEN: secrets.DEVICE_TOKEN, MCP_SECRET: secrets.MCP_SECRET, DASH_SECRET: secrets.DASH_SECRET,
}));
try { wr(["secret", "bulk", path.relative(backend, tmp), "--config", CONFIG]); } finally { fs.rmSync(tmp, { force: true }); }
console.log(created ? "generated new secrets and stored them" : "re-used existing secrets and stored them");

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
