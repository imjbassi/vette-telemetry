// Calls every MCP tool against a running Worker. Usage: node scripts/mcp-smoke.mjs [mcpUrl]
// Meant for a local `wrangler dev`. Every call only reads.
const url = process.argv[2] ?? "http://127.0.0.1:8787/mcp/dev-mcp-secret";
let id = 0;
let failed = 0;
async function post(body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const rpc = async (method, params) => (await post({ jsonrpc: "2.0", id: ++id, method, params })).json;
const check = (what, ok) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log("initialize:", init.result.serverInfo, init.result.protocolVersion);

const list = await rpc("tools/list", {});
const tools = list.result.tools;
console.log("\ntools:");
for (const t of tools) {
  const title = typeof t.title === "string" && t.title.length > 0;
  const readOnly = t.annotations?.readOnlyHint === true;
  check(`${t.name}: title ${title ? JSON.stringify(t.title) : "missing"}, readOnlyHint ${readOnly ? "true" : "missing"}`, title && readOnly);
}

// Local dates for the last week, good enough for a smoke call in any zone.
const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

const calls = [
  ["get_latest_status", {}],
  ["get_location", {}],
  ["list_trips", { limit: 5 }],
  ["list_trips", { limit: 5, from: day(7), to: day(0) }],
  ["get_trip_summary", {}],
  ["get_trip_summary", { include_locations: true }],
  ["get_fuel_economy", { days: 7 }],
  ["get_history", {}],
  ["get_history", { period: "this_month", group_by: "day" }],
  ["get_history", { from: day(7), to: day(0), group_by: "day" }],
];
// Tool answers are compact JSON. Indent them here so a person can read the output.
const pretty = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
const called = new Set();
const answers = [];
for (const [name, args] of calls) {
  called.add(name);
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  console.log(`\n=== ${name} ${JSON.stringify(args)}\n${text == null ? JSON.stringify(r) : pretty(text)}`);
  if (!r.result || r.result.isError) failed++;
  answers.push({ name, text: text ?? "" });
}

console.log("\nchecks:");
check("every listed tool was called", tools.every((t) => called.has(t.name)));
check("tool answers are compact JSON", answers.every((a) => !a.text.includes("\n")));
// A trip can be asked for by the label the dashboard shows as well as by its number.
let newest = null;
try {
  newest = JSON.parse(answers.find((a) => a.name === "list_trips").text).trips?.[0] ?? null;
} catch {
  // Already counted as a failed call above.
}
if (newest) {
  const byLabel = await rpc("tools/call", { name: "get_trip_summary", arguments: { trip_id: newest.label } });
  let got = null;
  try {
    got = JSON.parse(byLabel.result?.content?.[0]?.text ?? "null")?.trip_id ?? null;
  } catch {
    // An error text is not JSON. The check below reports it.
  }
  check(`trip label ${JSON.stringify(newest.label)} finds trip ${newest.trip_id} (got ${got})`, typeof newest.label === "string" && got === newest.trip_id);
} else {
  console.log("skip trip label check: no trips in this database");
}
// A figure from a short window must say when it rests on too few miles to be an average.
let econ = null;
try {
  econ = JSON.parse(answers.find((a) => a.name === "get_fuel_economy").text);
} catch {
  // Already counted as a failed call above.
}
check(`get_fuel_economy says whether its figure rests on too few miles (got ${econ?.combined_mpg_few_miles})`,
  typeof econ?.combined_mpg_few_miles === "boolean");
// Wrong arguments must come back as a readable tool error, not as a protocol error.
const bad = await rpc("tools/call", { name: "get_history", arguments: { from: "last tuesday" } });
check(`bad date gives an error text: ${bad.result?.content?.[0]?.text}`, bad.result?.isError === true);
const wide = await rpc("tools/call", { name: "get_history", arguments: { from: "2020-01-01", to: "2026-01-01" } });
check(`window over 366 days gives an error text: ${wide.result?.content?.[0]?.text}`, wide.result?.isError === true);
const notObject = await post(42);
check(`non-object message is rejected with -32600 (got ${notObject.json?.error?.code})`, notObject.json?.error?.code === -32600);

if (failed) {
  console.log(`\n${failed} problem(s)`);
  process.exit(1);
}
