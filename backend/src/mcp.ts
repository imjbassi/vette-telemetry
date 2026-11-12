// Minimal stateless MCP server over Streamable HTTP (JSON responses, no SSE).
import { Env } from "./ingest";
import {
  clampInt, fuelEconomy, history, HISTORY_PERIODS, latestStatus, listTrips, location, MPG30_MIN_MILES, tripSummary,
} from "./queries";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Live and historical telemetry for the user's 2024 Corvette Stingray (C8, LT2, 8-speed DCT). " +
  "A logger in the car reads OBD-II over Bluetooth and uploads over LTE about every 15 s while driving. " +
  "The logger only has power while the car is on, so for a parked car every value is the last one reported before shutdown. " +
  "A trip is one power-up of the logger with the engine running at some point. " +
  "Every trip has a trip_id number and a label such as 173-12, which is the name the dashboard shows. " +
  "Either one works as trip_id. " +
  "Fuel used and MPG are estimates computed from engine airflow, not measured at the pump. " +
  "Dates and times are in the owner's local time zone. Only get_location returns the car's position.";

// Every tool only reads the owner's own database.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const DATE = "Local calendar date as YYYY-MM-DD, for example 2026-11-05.";

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  run: (env: Env, args: any) => Promise<unknown>;
}

const TOOLS: Tool[] = [
  {
    name: "get_latest_status",
    title: "Car status",
    description:
      "Current or last known state of the car. Returns car_state (running, no_signal, parked or unknown, with one sentence " +
      "that explains it and how old the last report is), fuel level in percent with estimated gallons left and estimated range " +
      "in miles, battery voltage with a context word (charging, engine off, low), coolant and intake air temperature in °F, " +
      "last speed in mph and RPM, odometer in miles (null if never read), cell signal, and the logger's firmware build, " +
      "adapter link and last upload time. Each group has its own age because a parked car reports nothing. " +
      "Range is an estimate from the 30-day airflow-based MPG, or the EPA rating when there is too little history. " +
      "Does not return the position, use get_location for that.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => latestStatus(env),
  },
  {
    name: "get_location",
    title: "Car location",
    description:
      "Last GPS position of the car: latitude and longitude in decimal degrees, satellite count, a map link, the time and age " +
      "of the fix, whether the car is parked (null when the engine state is not known), and the same car_state as " +
      "get_latest_status. " +
      "This is the only tool that returns coordinates unless asked. The fix can be older than the last report if the car " +
      "had no sky view, so check its age.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => location(env),
  },
  {
    name: "get_trip_summary",
    title: "Trip summary",
    description:
      "Details of one trip, by default the most recent. Returns trip_id and label, start and end time, " +
      "logger_on_min (how long the logger had power), engine_on_min and moving_min, distance_mi (integrated from speed), odometer_distance_mi (from the car's " +
      "odometer), unlogged_before_mi (odometer miles driven between the previous trip and this one that the logger missed, " +
      "null if none or unknown), fuel_used_gal_est and mpg_est (estimates from engine airflow, not from fill-ups), average " +
      "moving speed and top speed in mph, max and average RPM, max coolant in °F, fuel gauge percent at start and end, " +
      "odometer in miles at start and end, and in_progress (true while the trip is still going). " +
      "Start and end coordinates are left out unless include_locations is true.",
    inputSchema: {
      type: "object",
      properties: {
        trip_id: {
          type: ["integer", "string"],
          description: "Trip id from list_trips or get_history: the trip_id number, or the label the dashboard shows, " +
            "for example \"173-12\". Omit for the latest trip.",
        },
        include_locations: {
          type: "boolean", default: false,
          description: "Set true to add the start and end coordinates with map links. Only when the user asks where the trip went.",
        },
      },
    },
    run: (env, a) => tripSummary(env, a),
  },
  {
    name: "list_trips",
    title: "List trips",
    description:
      "Trips, newest first, optionally limited to a range of local dates. Each trip has its trip_id and label, " +
      "start and end time, logger_on_min, engine_on_min, moving_min, distance_mi, odometer_distance_mi, unlogged_before_mi, fuel_used_gal_est " +
      "and mpg_est (estimates from engine airflow), speeds in mph, RPM, max coolant in °F and in_progress. " +
      "more_trips_exist is true when older trips were cut off by limit. No coordinates. " +
      "For totals over a period use get_history instead of adding trips up.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "How many trips to return." },
        from: { type: "string", description: `Only trips on or after this day. ${DATE}` },
        to: { type: "string", description: `Only trips on or before this day. ${DATE}` },
      },
    },
    run: (env, a) => listTrips(env, a),
  },
  {
    name: "get_fuel_economy",
    title: "Fuel economy",
    description:
      "Fuel economy over the last N days (default 30). Returns trip count, total miles, total_gallons_est, combined_mpg_est, " +
      `combined_mpg_few_miles (true when that figure rests on fewer than ${MPG30_MIN_MILES} logged miles, so it is rough and not a solid average), ` +
      "the best and worst trip MPG among trips of 2 miles or more, the EPA ratings for comparison (16 city, 24 highway, " +
      "19 combined), and the 20 newest trips with distance and MPG. " +
      "Gallons and MPG are estimates from engine airflow, not from fill-ups. Their accuracy has not been checked against a fill-up.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 30, description: "Length of the window in days, counted back from now." } },
    },
    run: (env, a) => fuelEconomy(env, clampInt(a?.days, 30, 1, 365)),
  },
  {
    name: "get_history",
    title: "Driving history",
    description:
      "Driving totals for a period of whole local days. Use it for questions like how far the car went last week, " +
      "which days it was driven, or how this month compares with last month. " +
      "Give either period, or from and to dates (both included, to defaults to today). The window can be 366 days at most. " +
      "Returns the resolved window, totals (distance_mi, fuel_used_gal_est, mpg_est, engine_on_min, moving_min, idle_min, " +
      "max_speed_mph, max_rpm, days_with_driving, trip_count, unlogged_mi), the trips in the window (newest first, 50 at " +
      "most), and with group_by \"day\" one row per day that had driving. " +
      "Totals and day rows count only what happened inside the window, and days follow local midnight. " +
      "Fuel and MPG are estimates from engine airflow. unlogged_mi is odometer distance the logger did not record, " +
      "null when that is not known. " +
      "window.data_starts is only present when the logger's first data is later than the start of the window (null when " +
      "there is no data at all): the days before it are not covered, which is not the same as not driven. " +
      "No coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: [...HISTORY_PERIODS], description: "A named period. Default last_7_days. Do not combine with from and to." },
        from: { type: "string", description: `First day of the window. ${DATE}` },
        to: { type: "string", description: `Last day of the window, included. Defaults to today. ${DATE}` },
        group_by: { type: "string", enum: ["day"], description: "Add one row per local day with driving." },
      },
    },
    run: (env, a) => history(env, a),
  },
];

type Msg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const invalid = () => ({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
const isObject = (m: unknown): m is Msg => typeof m === "object" && m !== null && !Array.isArray(m);

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
      return ok({
        tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: READ_ONLY })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return err(-32602, `Unknown tool ${m.params?.name}`);
      try {
        const args = m.params?.arguments;
        const data = await tool.run(env, isObject(args) ? args : {});
        // Wrong arguments come back as a plain sentence the model can act on.
        if (isObject(data) && (data as { bad_input?: boolean }).bad_input === true) {
          return ok({ content: [{ type: "text", text: `Error: ${(data as { error?: string }).error}` }], isError: true });
        }
        // Compact JSON. Indentation only costs the model context.
        return ok({ content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
      } catch (e) {
        // The model gets the text, and the Worker log keeps a trace for the owner.
        console.error("mcp tool failed", tool.name, e);
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  // A message must be a JSON object. Null, numbers, strings and an empty batch are not requests.
  if (Array.isArray(body) ? body.length === 0 : !isObject(body)) return Response.json(invalid(), { status: 400 });
  const msgs: unknown[] = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => (isObject(m) ? dispatch(env, m) : invalid()))))
    .filter((r): r is object => r !== null);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0]);
}
