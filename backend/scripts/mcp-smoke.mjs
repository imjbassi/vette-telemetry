// Calls every MCP tool against a running Worker. Usage: node scripts/mcp-smoke.mjs [mcpUrl]
const url = process.argv[2] ?? "http://127.0.0.1:8787/mcp/dev-mcp-secret";
let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return res.json();
}
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log("initialize:", init.result.serverInfo, init.result.protocolVersion);
const list = await rpc("tools/list", {});
console.log("tools:", list.result.tools.map((t) => t.name).join(", "));
for (const [name, args] of [
  ["get_latest_status", {}], ["get_location", {}], ["list_trips", { limit: 5 }],
  ["get_trip_summary", {}], ["get_fuel_economy", { days: 7 }],
]) {
  const r = await rpc("tools/call", { name, arguments: args });
  console.log(`\n=== ${name}\n${r.result?.content?.[0]?.text ?? JSON.stringify(r)}`);
}
