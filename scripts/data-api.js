#!/usr/bin/env node
/**
 * data-api.js
 * Lightweight HTTP API that exposes OpenClaw session data to the dashboard.
 * Runs on port 18790. NOT an agent — pure Node.js HTTP server.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.DATA_API_PORT || "18790");
const AGENTS_DIR = "/home/node/.openclaw/agents";
const SNAPSHOT_LOG = "/home/node/.openclaw/workspace/logs/token-snapshots.jsonl";
const PID_FILE = "/home/node/.openclaw/workspace/logs/data-api.pid";

const PRICING = {
  "claude-sonnet-4-6":     { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":      { input: 0.8,  output: 4.0  },
  "claude-opus-4-6":       { input: 15.0, output: 75.0 },
  "gemini-3.1-pro-preview":{ input: 3.5,  output: 10.5 },
  "gemini-2.5-flash-lite": { input: 0.1,  output: 0.4  },
  "gemini-2.5-flash":      { input: 0.15, output: 0.6  },
  "gpt-4o":                { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":           { input: 0.15, output: 0.6  },
};

function resolveModel(model) {
  if (!model) return "";
  if (PRICING[model]) return model;
  for (const key of Object.keys(PRICING)) {
    if (model === key || model.endsWith(key) || key.split("/").pop() === model) return key;
  }
  return model;
}

function calcCost(model, input, output) {
  const p = PRICING[resolveModel(model)];
  if (!p) return 0;
  return (input / 1e6) * p.input + (output / 1e6) * p.output;
}

function getAllSessions() {
  const agents = fs.readdirSync(AGENTS_DIR).filter(a => {
    return fs.existsSync(path.join(AGENTS_DIR, a, "sessions", "sessions.json"));
  });

  const all = [];
  for (const agent of agents) {
    try {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, agent, "sessions", "sessions.json"), "utf8");
      const data = JSON.parse(raw);
      for (const [key, val] of Object.entries(data)) {
        const model = resolveModel(val.model || "");
        const totalTokens = val.totalTokens || 0;
        const cost = calcCost(model, totalTokens * 0.7, totalTokens * 0.3);
        all.push({
          sessionKey: key,
          agentId: agent,
          model,
          totalTokens,
          contextTokens: val.contextTokens || 0,
          cost: parseFloat(cost.toFixed(8)),
          costStr: "$" + cost.toFixed(6) + " USD",
          channel: val.deliveryContext?.channel || val.lastChannel || "",
          displayName: val.origin?.label || val.displayName || key,
          lastActivity: val.updatedAt,
          sessionId: val.sessionId,
        });
      }
    } catch (e) {
      console.error(`Error reading agent ${agent}:`, e.message);
    }
  }
  return all;
}

function getSessionDetail(sessionKey) {
  // Find which agent owns this session
  const agents = fs.readdirSync(AGENTS_DIR).filter(a =>
    fs.existsSync(path.join(AGENTS_DIR, a, "sessions", "sessions.json"))
  );

  let agentId = null, sessionId = null, model = "";
  for (const agent of agents) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, agent, "sessions", "sessions.json"), "utf8"));
      if (data[sessionKey]) {
        agentId = agent;
        sessionId = data[sessionKey].sessionId;
        model = data[sessionKey].model || "";
        break;
      }
    } catch {}
  }

  if (!sessionId) return { sessionKey, steps: [], error: "Session not found" };

  // Read ALL jsonl files for this agent (current + historical)
  const sessionsDir = path.join(AGENTS_DIR, agentId, "sessions");
  const jsonlFiles = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => path.join(sessionsDir, f));

  const lines = [];
  for (const f of jsonlFiles) {
    try { lines.push(...fs.readFileSync(f, "utf8").split("\n").filter(Boolean)); }
    catch {}
  }
  let messageCount = 0;

  // Map toolCall id → tool name
  const callMap = {};
  // tool name → { count, totalChars }
  const toolStats = {};

  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "message") continue;
    const m = msg.message || {};
    messageCount++;

    if (m.role === "assistant" && Array.isArray(m.content)) {
      if (m.model) model = m.model;
      for (const block of m.content) {
        if (block.type === "toolCall") {
          callMap[block.id] = block.name;
          if (!toolStats[block.name]) toolStats[block.name] = { count: 0, totalChars: 0, calls: [] };
          toolStats[block.name].count++;
          // store call detail for label
          const inp = block.arguments || {};
          let label = "";
          const n = block.name;
          if (n === "Read" || n === "read") label = inp.path || inp.file_path || "";
          else if (n === "exec") label = (inp.command || "").slice(0, 60);
          else if (n === "web_search") label = inp.query || "";
          else if (n === "web_fetch") label = inp.url || "";
          else if (n === "memory_search") label = inp.query || "";
          else if (n === "Edit" || n === "Write") label = inp.path || inp.file_path || "";
          else label = JSON.stringify(inp).slice(0, 60);
          toolStats[block.name].calls.push(label);
        }
      }
    }

    // Accumulate chars from tool results
    if (m.role === "toolResult" && m.toolCallId && callMap[m.toolCallId]) {
      const toolName = callMap[m.toolCallId];
      const chars = JSON.stringify(m.content || "").length;
      if (toolStats[toolName]) toolStats[toolName].totalChars += chars;
    }
  }

  // Convert to sorted array (by estimated tokens desc)
  const steps = Object.entries(toolStats)
    .map(([tool, s]) => ({
      tool,
      count: s.count,
      estimatedTokens: Math.round(s.totalChars / 4),
      estimatedCost: parseFloat(calcCost(resolveModel(model), s.totalChars / 4, 0).toFixed(8)),
      topCalls: [...new Set(s.calls.filter(Boolean))].slice(0, 3),
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  const resolvedModel = resolveModel(model);
  const allSessions = getAllSessions();
  const info = allSessions.find(s => s.sessionKey === sessionKey);
  const totalTokens = info?.totalTokens || 0;
  const cost = calcCost(resolvedModel, totalTokens * 0.7, totalTokens * 0.3);

  return {
    sessionKey,
    agentId,
    model: resolvedModel,
    displayName: info?.displayName || sessionKey,
    steps,
    stepCount: steps.length,
    messageCount,
    tokens: { total: totalTokens },
    cost: "$" + cost.toFixed(6) + " USD",
  };
}

function getSnapshotHistory() {
  if (!fs.existsSync(SNAPSHOT_LOG)) return [];
  return fs.readFileSync(SNAPSHOT_LOG, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function getSummary(sessions) {
  let totalTokens = 0, totalCost = 0;
  const byModel = {}, byAgent = {};

  for (const s of sessions) {
    totalTokens += s.totalTokens;
    totalCost += s.cost;

    if (s.model) {
      byModel[s.model] = byModel[s.model] || { sessions: 0, tokens: 0, cost: 0 };
      byModel[s.model].sessions++;
      byModel[s.model].tokens += s.totalTokens;
      byModel[s.model].cost += s.cost;
    }

    byAgent[s.agentId] = byAgent[s.agentId] || { sessions: 0, tokens: 0, cost: 0 };
    byAgent[s.agentId].sessions++;
    byAgent[s.agentId].tokens += s.totalTokens;
    byAgent[s.agentId].cost += s.cost;
  }

  // Format cost strings
  for (const v of Object.values(byModel)) v.costStr = "$" + v.cost.toFixed(6);
  for (const v of Object.values(byAgent)) v.costStr = "$" + v.cost.toFixed(6);

  return {
    totalSessions: sessions.length,
    totalTokens,
    totalCost: "$" + totalCost.toFixed(6) + " USD",
    byModel,
    byAgent,
    pricing: PRICING,
  };
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Auth check (only for API routes)
  if (p.startsWith("/api/")) {
    const auth = req.headers["authorization"] || "";
    const queryToken = url.searchParams.get("token") || "";
    const provided = auth.replace("Bearer ", "").trim() || queryToken;
    if (DASHBOARD_TOKEN && provided !== DASHBOARD_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
  }

  try {
    if (p === "/api/sessions") {
      return json(res, getAllSessions());
    }
    if (p === "/api/summary") {
      return json(res, getSummary(getAllSessions()));
    }
    if (p === "/api/history") {
      return json(res, getSnapshotHistory());
    }
    if (p.startsWith("/api/sessions/")) {
      const key = decodeURIComponent(p.replace("/api/sessions/", ""));
      return json(res, getSessionDetail(key));
    }
    if (p === "/health") {
      return json(res, { ok: true, ts: new Date().toISOString() });
    }
    // Serve dashboard HTML (inject token for API calls)
    if (p === "/" || p === "/index.html") {
      const htmlPath = path.join(__dirname, "../Openclaw_repo/public/index.html");
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, "utf8");
        // Inject token so browser can call API
        html = html.replace("const BASE = \"\";", `const BASE = ""; const API_TOKEN = "${DASHBOARD_TOKEN}";`);
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(html);
      }
    }
    json(res, { error: "Not found" }, 404);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`[data-api] listening on 0.0.0.0:${PORT} PID=${process.pid}`);
});

process.on("SIGTERM", () => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); });
process.on("SIGINT",  () => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); });
// already done above
