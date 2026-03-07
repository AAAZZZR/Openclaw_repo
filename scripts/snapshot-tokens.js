#!/usr/bin/env node
/**
 * snapshot-tokens.js
 * Snapshots token usage from OpenClaw gateway and appends to a JSONL log.
 * Run via cron, NOT as an agent.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const LOG_FILE = path.join(__dirname, "../logs/token-snapshots.jsonl");

// Model pricing USD per 1M tokens
const PRICING = {
  "claude-sonnet-4-6":   { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":    { input: 0.8,  output: 4.0  },
  "claude-opus-4-6":     { input: 15.0, output: 75.0 },
  "gemini-2.5-flash-lite":{ input: 0.1,  output: 0.4  },
  "gemini-2.5-flash":    { input: 0.15, output: 0.6  },
  "gpt-4o":              { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":         { input: 0.15, output: 0.6  },
};

function getPrice(model) {
  if (!model) return null;
  for (const [key, val] of Object.entries(PRICING)) {
    if (model === key || model.endsWith(key) || model.includes(key)) return val;
  }
  return null;
}

function calcCost(model, input, output) {
  const p = getPrice(model);
  if (!p) return 0;
  return (input / 1e6) * p.input + (output / 1e6) * p.output;
}

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error("Invalid JSON: " + raw.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function callTool(tool, args = {}) {
  const res = await post(`${GATEWAY_URL}/tools/invoke`, GATEWAY_TOKEN, { tool, args });
  if (!res.ok) throw new Error(res.error?.message || "Tool call failed");
  const r = res.result;
  if (r?.details) return r.details;
  if (r?.content?.[0]?.text) return JSON.parse(r.content[0].text);
  return r;
}

async function main() {
  // Ensure log dir exists
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  const data = await callTool("sessions_list", { limit: 100 });
  const sessions = data?.sessions || [];
  const ts = new Date().toISOString();

  const snapshot = {
    ts,
    sessions: sessions.map(s => {
      const model = s.model || "";
      const total = s.totalTokens || 0;
      // Estimate 70/30 split since OpenClaw doesn't separate input/output in sessions_list
      const cost = calcCost(model, total * 0.7, total * 0.3);
      return {
        key: s.key || s.sessionKey,
        model,
        totalTokens: total,
        contextTokens: s.contextTokens || 0,
        cost: parseFloat(cost.toFixed(8)),
        channel: s.channel,
        updatedAt: s.updatedAt,
      };
    }),
    totals: {
      sessions: sessions.length,
      tokens: sessions.reduce((a, s) => a + (s.totalTokens || 0), 0),
    },
  };

  snapshot.totals.cost = parseFloat(
    snapshot.sessions.reduce((a, s) => a + s.cost, 0).toFixed(8)
  );

  fs.appendFileSync(LOG_FILE, JSON.stringify(snapshot) + "\n");
  console.log(`[${ts}] Snapshotted ${sessions.length} sessions, total tokens: ${snapshot.totals.tokens}, cost: $${snapshot.totals.cost}`);
}

main().catch(e => {
  console.error("snapshot-tokens error:", e.message);
  process.exit(1);
});
