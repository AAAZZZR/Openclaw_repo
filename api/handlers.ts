import { callTool, calcCost, MODEL_PRICING } from "./index";

function parseResult(result: any) {
  // result can be { details: ... } or { content: [{text: "..."}] }
  if (result?.details) return result.details;
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); } catch {}
  }
  return result;
}

export async function sessions() {
  const raw = await callTool("sessions_list", { limit: 100 });
  const data = parseResult(raw);
  const list = data?.sessions || data || [];

  return list.map((s: any) => ({
    sessionKey: s.key || s.sessionKey,
    agentId: s.key?.split(":")?.[1] || "main",
    model: s.model,
    kind: s.kind,
    channel: s.channel,
    displayName: s.displayName,
    lastActivity: s.updatedAt,
    totalTokens: s.totalTokens,
    contextTokens: s.contextTokens,
    sessionId: s.sessionId,
  }));
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
  let inputTokens = 0;
  let outputTokens = 0;
  let model = "";

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (msg.model) model = msg.model;
      if (msg.usage) {
        inputTokens += msg.usage.input_tokens || msg.usage.inputTokens || 0;
        outputTokens += msg.usage.output_tokens || msg.usage.outputTokens || 0;
      }
      // Tool calls in content
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            steps.push({
              type: "tool_call",
              tool: block.name,
              args: summarizeArgs(block.name, block.input),
              timestamp: msg.timestamp,
            });
          }
        }
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

  // Use totalTokens from sessions_list directly (more efficient)
  let totalTokens = 0;
  const byModel: Record<string, { sessions: number; tokens: number; cost: number }> = {};

  for (const s of list) {
    const tokens = s.totalTokens || 0;
    totalTokens += tokens;

    if (s.model) {
      const m = s.model;
      byModel[m] = byModel[m] || { sessions: 0, tokens: 0, cost: 0 };
      byModel[m].sessions++;
      byModel[m].tokens += tokens;
      // Rough estimate: 80% input 20% output
      byModel[m].cost += calcCost(m, tokens * 0.8, tokens * 0.2);
    }
  }

  const totalCost = Object.values(byModel).reduce((acc, v) => acc + v.cost, 0);

  return {
    totalSessions: list.length,
    totalTokens,
    totalCost: `$${totalCost.toFixed(6)} USD`,
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [k, { ...v, cost: `$${v.cost.toFixed(6)}` }])
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
  return JSON.stringify(input).slice(0, 100);
}
