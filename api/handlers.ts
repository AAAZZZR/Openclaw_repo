import { callTool, calcCost, MODEL_PRICING } from "./index";

const AGENTS_DIR = "/home/node/.openclaw/agents";

function resolveModel(model: string): string {
  if (!model) return "";
  if (MODEL_PRICING[model]) return model;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (key.endsWith(model) || model.endsWith(key.split("/").pop()!)) return key;
  }
  return model;
}

// Read all agents' sessions.json via exec
async function getAllSessions(): Promise<any[]> {
  const result = await callTool("exec", {
    command: `node -e "
const fs = require('fs'), path = require('path');
const base = '${AGENTS_DIR}';
const agents = fs.readdirSync(base).filter(a => fs.existsSync(path.join(base,a,'sessions','sessions.json')));
const all = [];
for (const agent of agents) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(base,agent,'sessions','sessions.json'),'utf8'));
    for (const [key, val] of Object.entries(data)) {
      all.push({ agentId: agent, key, ...val });
    }
  } catch(e) {}
}
console.log(JSON.stringify(all));
"`
  });

  const text = result?.stdout || result?.output || (typeof result === "string" ? result : "");
  try {
    const lines = text.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } catch { return []; }
}

export async function sessions() {
  const all = await getAllSessions();
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

  const allSessions = await getAllSessions();
  const info = allSessions.find(s => s.key === sessionKey);
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
  const list = await sessions();
  let totalTokens = 0, totalCost = 0;
  const byModel: Record<string, { sessions: number; tokens: number; cost: number }> = {};
  const byAgent: Record<string, { sessions: number; tokens: number; cost: number }> = {};

  for (const s of list) {
    totalTokens += s.totalTokens;
    totalCost += s.costRaw;

    if (s.model) {
      byModel[s.model] = byModel[s.model] || { sessions: 0, tokens: 0, cost: 0 };
      byModel[s.model].sessions++;
      byModel[s.model].tokens += s.totalTokens;
      byModel[s.model].cost += s.costRaw;
    }

    const aid = s.agentId || "unknown";
    byAgent[aid] = byAgent[aid] || { sessions: 0, tokens: 0, cost: 0 };
    byAgent[aid].sessions++;
    byAgent[aid].tokens += s.totalTokens;
    byAgent[aid].cost += s.costRaw;
  }

  return {
    totalSessions: list.length,
    totalTokens,
    totalCost: `$${totalCost.toFixed(6)} USD`,
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [k, { ...v, costStr: `$${v.cost.toFixed(6)}` }])
    ),
    byAgent: Object.fromEntries(
      Object.entries(byAgent).map(([k, v]) => [k, { ...v, costStr: `$${v.cost.toFixed(6)}` }])
    ),
    pricing: MODEL_PRICING,
  };
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
