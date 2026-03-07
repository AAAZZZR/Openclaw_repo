import { sessions, summary, sessionDetail } from "./handlers";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

export async function callTool(tool: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tool, args }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error?.message || "Tool call failed");
  return data.result;
}

// Model pricing (USD per 1M tokens)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "anthropic/claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "google/gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    try {
      if (path === "/api/sessions") return Response.json(await sessions(), { headers: cors });
      if (path.startsWith("/api/sessions/")) {
        const id = path.replace("/api/sessions/", "");
        return Response.json(await sessionDetail(id), { headers: cors });
      }
      if (path === "/api/summary") return Response.json(await summary(), { headers: cors });

      // Serve HTML dashboard
      if (path === "/" || path === "/index.html") {
        const html = await Bun.file("./public/index.html").text();
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers: cors });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500, headers: cors });
    }
  },
};
