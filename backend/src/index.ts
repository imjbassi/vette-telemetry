import { handleDash } from "./dash";
import { Env, handleIngest } from "./ingest";
import { handleMcp } from "./mcp";

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ingest" && req.method === "POST") {
      const auth = req.headers.get("Authorization") ?? "";
      if (!env.DEVICE_TOKEN || !safeEqual(auth, `Bearer ${env.DEVICE_TOKEN}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      return handleIngest(req, env);
    }

    // Connector URL: https://<host>/mcp/<MCP_SECRET>. The secret path is the auth.
    if (url.pathname.startsWith("/mcp/")) {
      const secret = url.pathname.slice(5).replace(/\/$/, "");
      if (!env.MCP_SECRET || !safeEqual(secret, env.MCP_SECRET)) return new Response("not found", { status: 404 });
      return handleMcp(req, env);
    }

    // Dashboard URL: https://<host>/dash/<DASH_SECRET>/. Same secret-path scheme as MCP.
    if (url.pathname.startsWith("/dash/")) {
      const after = url.pathname.slice(6);
      const cut = after.indexOf("/");
      const secret = cut < 0 ? after : after.slice(0, cut);
      const rest = cut < 0 ? "" : after.slice(cut);
      if (!env.DASH_SECRET || !safeEqual(secret, env.DASH_SECRET)) return new Response("not found", { status: 404 });
      return handleDash(req, env, rest, `/dash/${secret}`);
    }

    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
