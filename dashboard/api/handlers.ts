import { callTool, calcCost, MODEL_PRICING } from "./index";

export async function sessions() {
  const result = await callTool("sessions_list", { limit: 50, messageLimit: 1 });
  const list = result?.sessions || result || [];

  return list.map((s: any) => ({
    sessionKey: s.sessionKey,
    agentId: s.agentId,
    model: s.model,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    kind: s.kind,
  }));
}

export async function sessionDetail(sessionKey: string) {
  const result = await callTool("sessions_history", {
    sessionKey,
    includeTools: true,
    limit: 200,
  });

  const messages = result?.messages || result || [];

  // Extract tool calls and file reads
  const steps: any[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model = "";

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.usage) {
      inputTokens += msg.usage.inputTokens || 0;
      outputTokens += msg.usage.outputTokens || 0;
      if (msg.model) model = msg.model;
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        steps.push({
          type: "tool_call",
          tool: tc.name,
          args: summarizeArgs(tc.name, tc.input),
          timestamp: msg.createdAt,
        });
      }
    }
  }

  const cost = calcCost(model, inputTokens, outputTokens);

  return {
    sessionKey,
    model,
    steps,
    tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    cost: `$${cost.toFixed(6)} USD`,
    messageCount: messages.length,
  };
}

export async function summary() {
  const list = await sessions();
  const details = await Promise.allSettled(
    list.slice(0, 20).map((s: any) => sessionDetail(s.sessionKey))
  );

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const byModel: Record<string, { sessions: number; cost: number }> = {};

  for (const d of details) {
    if (d.status !== "fulfilled") continue;
    const v = d.value;
    totalInput += v.tokens.input;
    totalOutput += v.tokens.output;
    const cost = parseFloat(v.cost.replace("$", "").replace(" USD", ""));
    totalCost += cost;
    if (v.model) {
      byModel[v.model] = byModel[v.model] || { sessions: 0, cost: 0 };
      byModel[v.model].sessions++;
      byModel[v.model].cost += cost;
    }
  }

  return {
    totalSessions: list.length,
    totalTokens: { input: totalInput, output: totalOutput },
    totalCost: `$${totalCost.toFixed(6)} USD`,
    byModel,
    pricing: MODEL_PRICING,
  };
}

function summarizeArgs(tool: string, input: any): string {
  if (!input) return "";
  if (tool === "Read" || tool === "read") return input.path || input.file_path || "";
  if (tool === "exec") return (input.command || "").slice(0, 80);
  if (tool === "web_search") return input.query || "";
  if (tool === "web_fetch") return input.url || "";
  if (tool === "memory_search") return input.query || "";
  return JSON.stringify(input).slice(0, 80);
}
