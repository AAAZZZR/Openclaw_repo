import { callTool, calcCost, MODEL_PRICING } from "./index";

function parseResult(result: any) {
  if (result?.details) return result.details;
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); } catch {}
  }
  return result;
}

// Fuzzy match model name — strip provider prefix or match suffix
function resolveModel(model: string): string {
  if (!model) return "";
  // Already exact match
  if (MODEL_PRICING[model]) return model;
  // Try matching by suffix (e.g. "claude-sonnet-4-6" → "anthropic/claude-sonnet-4-6")
  for (const key of Object.keys(MODEL_PRICING)) {
    if (key.endsWith(model) || model.endsWith(key.split("/").pop()!)) return key;
  }
  return model;
}

export async function sessions() {
  const raw = await callTool("sessions_list", { limit: 100 });
  const data = parseResult(raw);
  const list = data?.sessions || data || [];

  return list.map((s: any) => {
    const model = resolveModel(s.model || "");
    const totalTokens = s.totalTokens || 0;
    // Rough estimate: 70% input, 30% output
    const cost = calcCost(model, totalTokens * 0.7, totalTokens * 0.3);
    return {
      sessionKey: s.key || s.sessionKey,
      agentId: (s.key || "").split(":")?.[1] || "main",
      model,
      kind: s.kind,
      channel: s.channel,
      displayName: s.displayName,
      lastActivity: s.updatedAt,
      totalTokens,
      contextTokens: s.contextTokens,
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
  const data = parseResult(raw);
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
            steps.push({
              tool: name,
              args: summarizeArgs(name, inp),
            });
          }
        }
      }
    }
  }

  // Also get totalTokens from sessions_list for this session
  const sessionList = await sessions();
  const sessionInfo = sessionList.find(s => s.sessionKey === sessionKey);
  const totalTokens = sessionInfo?.totalTokens || 0;
  const resolvedModel = model || sessionInfo?.model || "";
  const cost = calcCost(resolvedModel, totalTokens * 0.7, totalTokens * 0.3);

  return {
    sessionKey,
    model: resolvedModel,
    displayName: sessionInfo?.displayName,
    steps,
    tokens: { total: totalTokens, note: "Approximate (current context window)" },
    cost: `$${cost.toFixed(6)} USD`,
    messageCount: messages.length,
    stepCount: steps.length,
  };
}

export async function summary() {
  const list = await sessions();

  let totalTokens = 0;
  let totalCost = 0;
  const byModel: Record<string, { sessions: number; tokens: number; cost: number }> = {};

  for (const s of list) {
    totalTokens += s.totalTokens || 0;
    totalCost += s.costRaw || 0;

    if (s.model) {
      byModel[s.model] = byModel[s.model] || { sessions: 0, tokens: 0, cost: 0 };
      byModel[s.model].sessions++;
      byModel[s.model].tokens += s.totalTokens || 0;
      byModel[s.model].cost += s.costRaw || 0;
    }
  }

  return {
    totalSessions: list.length,
    totalTokens,
    totalCost: `$${totalCost.toFixed(6)} USD`,
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [
        k,
        { ...v, costStr: `$${v.cost.toFixed(6)} USD` }
      ])
    ),
    pricing: MODEL_PRICING,
    note: "Token counts reflect current active context windows only. Historical sessions not tracked.",
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
