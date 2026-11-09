// Minimal stateless MCP server over Streamable HTTP (JSON responses, no SSE).
import { Env } from "./ingest";
import { fuelEconomy, latestStatus, listTrips, location, tripSummary } from "./queries";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Live and historical telemetry for the user's 2024 Corvette Stingray (C8, LT2, 8-speed DCT). " +
  "A logger in the car reads OBD-II over BLE and uploads over LTE every ~30 s while the car is on. " +
  "When the car is off, values are the last ones reported before shutdown. A trip is one ignition cycle.";

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run: (env: Env, args: any) => Promise<unknown>;
}

const TOOLS: Tool[] = [
  {
    name: "get_latest_status",
    description: "Current/last-known vehicle state: fuel level and estimated range, battery voltage, coolant temp, location, whether the engine was running, and data freshness.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => latestStatus(env),
  },
  {
    name: "get_location",
    description: "Last GPS position of the car with a map link and how old it is.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => location(env),
  },
  {
    name: "get_trip_summary",
    description: "Summary of one trip (ignition cycle): distance, duration, fuel used, MPG, speeds, RPM, coolant, start/end location and fuel level. Defaults to the most recent trip.",
    inputSchema: {
      type: "object",
      properties: { trip_id: { type: "integer", description: "Trip id from list_trips. Omit for the latest trip." } },
    },
    run: (env, a) => tripSummary(env, a?.trip_id),
  },
  {
    name: "list_trips",
    description: "Recent trips, newest first, with distance, duration and MPG.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
    },
    run: (env, a) => listTrips(env, Math.min(Math.max(a?.limit ?? 10, 1), 50)),
  },
  {
    name: "get_fuel_economy",
    description: "Fuel economy over a time window: combined MPG, miles, gallons, best/worst trip, compared with EPA ratings.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 30 } },
    },
    run: (env, a) => fuelEconomy(env, Math.min(Math.max(a?.days ?? 30, 1), 365)),
  },
];

type Msg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

async function dispatch(env: Env, m: Msg): Promise<object | null> {
  const isNotification = m.id === undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });

  switch (m.method) {
    case "initialize": {
      const want = m.params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vette-telemetry", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return err(-32602, `Unknown tool ${m.params?.name}`);
      try {
        const data = await tool.run(env, m.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, cancelled, etc.
      return err(-32601, `Method not found: ${m.method}`);
  }
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  let body: Msg | Msg[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => dispatch(env, m)))).filter((r): r is object => r !== null);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0]);
}
