import { calcCost, MODEL_PRICING } from "./index";

const DATA_API = process.env.DATA_API_URL || "http://localhost:18790";

async function dataFetch(path: string) {
  const res = await fetch(`${DATA_API}${path}`);
  return res.json() as Promise<any>;
}

export async function sessions() {
  const all = await dataFetch("/api/sessions");
  return all.map((s: any) => {
    const model = resolveModel(s.model || "");
    const totalTokens = s.totalTokens || 0;
    const cost = calcCost(model, totalTokens * 0.7, totalTokens * 0.3);
    return {
      sessionKey: s.key,
      agentId: s.agentId,
      model,
      kind: s.kind || "session",
      channel: s.deliveryContext?.channel || s.lastChannel || "",
      displayName: s.origin?.label || s.displayName || s.key,
      lastActivity: s.updatedAt,
      totalTokens,
      contextTokens: s.contextTokens || 0,
      sessionId: s.sessionId,
      cost: `$${cost.toFixed(6)} USD`,
      costRaw: cost,
    };
  });
}

export async function sessionDetail(sessionKey: string) {
  const raw = await callTool("sessions_history", {
    sessionKey,
    includeTools: true,
    limit: 500,
  });

  let data: any = null;
  if (raw?.details) data = raw.details;
  else if (raw?.content?.[0]?.text) {
    try { data = JSON.parse(raw.content[0].text); } catch {}
  }
  const messages = data?.messages || [];

  const steps: any[] = [];
  let model = "";

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (msg.model) model = resolveModel(msg.model);
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" || block.type === "toolCall") {
            const name = block.name;
            const inp = block.input || block.arguments || {};
            steps.push({ tool: name, args: summarizeArgs(name, inp) });
          }
        }
      }
    }
  }

  const allSessions = await dataFetch("/api/sessions");
  const info = allSessions.find((s: any) => s.sessionKey === sessionKey);
  const totalTokens = info?.totalTokens || 0;
  const resolvedModel = model || resolveModel(info?.model || "");
  const cost = calcCost(resolvedModel, totalTokens * 0.7, totalTokens * 0.3);

  return {
    sessionKey,
    agentId: info?.agentId,
    model: resolvedModel,
    displayName: info?.origin?.label || sessionKey,
    steps,
    tokens: { total: totalTokens, note: "Current context window" },
    cost: `$${cost.toFixed(6)} USD`,
    messageCount: messages.length,
    stepCount: steps.length,
  };
}

export async function summary() {
  return dataFetch("/api/summary");
}

function summarizeArgs(tool: string, input: any): string {
  if (!input) return "";
  if (tool === "Read" || tool === "read") return input.path || input.file_path || "";
  if (tool === "exec") return (input.command || "").slice(0, 100);
  if (tool === "web_search") return input.query || "";
  if (tool === "web_fetch") return input.url || "";
  if (tool === "memory_search") return input.query || "";
  if (tool === "Edit" || tool === "Write") return input.path || input.file_path || "";
  if (tool === "message") return `action=${input.action} target=${input.target || ""}`;
  return JSON.stringify(input).slice(0, 100);
}
