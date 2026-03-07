#!/usr/bin/env node
/**
 * token-watcher.js
 * Background process — snapshots token usage every 15 minutes.
 * Starts itself, never exits. Run with: node token-watcher.js &
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const INTERVAL_MS = 15 * 60 * 1000; // 15 min
const LOG_FILE = path.resolve(__dirname, "../logs/token-snapshots.jsonl");
const PID_FILE = path.resolve(__dirname, "../logs/token-watcher.pid");

const PRICING = {
  "claude-sonnet-4-6":    { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":     { input: 0.8,  output: 4.0  },
  "claude-opus-4-6":      { input: 15.0, output: 75.0 },
  "gemini-2.5-flash-lite":{ input: 0.1,  output: 0.4  },
  "gemini-2.5-flash":     { input: 0.15, output: 0.6  },
  "gpt-4o":               { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":          { input: 0.15, output: 0.6  },
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
      path: "/tools/invoke",
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
        catch { reject(new Error("Invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function snapshot() {
  const res = await post(GATEWAY_URL, GATEWAY_TOKEN, { tool: "sessions_list", args: { limit: 100 } });
  if (!res.ok) throw new Error(res.error?.message);
  const raw = res.result;
  const data = raw?.details || (raw?.content?.[0]?.text ? JSON.parse(raw.content[0].text) : raw);
  const sessions = data?.sessions || [];
  const ts = new Date().toISOString();

  const entry = {
    ts,
    sessions: sessions.map(s => {
      const model = s.model || "";
      const total = s.totalTokens || 0;
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
      cost: 0,
    },
  };
  entry.totals.cost = parseFloat(entry.sessions.reduce((a, s) => a + s.cost, 0).toFixed(8));

  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  console.log(`[${ts}] OK — sessions: ${entry.totals.sessions}, tokens: ${entry.totals.tokens}, cost: $${entry.totals.cost}`);
}

async function run() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`[token-watcher] started PID=${process.pid}, interval=${INTERVAL_MS / 60000}min`);

  // Run immediately, then every interval
  try { await snapshot(); } catch (e) { console.error("snapshot failed:", e.message); }

  setInterval(async () => {
    try { await snapshot(); } catch (e) { console.error("snapshot failed:", e.message); }
  }, INTERVAL_MS);
}

process.on("SIGTERM", () => { fs.unlinkSync(PID_FILE); process.exit(0); });
process.on("SIGINT",  () => { fs.unlinkSync(PID_FILE); process.exit(0); });

run();
