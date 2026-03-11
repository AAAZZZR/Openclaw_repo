/**
 * OpenClaw Cost Dashboard
 * Reads session data from /home/node/.openclaw/agents/
 * Calculates REAL cumulative costs from per-message usage in .jsonl files.
 * Password-protected via cookie auth.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || "18790");
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const AGENTS_DIR = "/home/node/.openclaw/agents";

function resolveModel(raw: string): string {
  if (!raw) return "";
  // Strip provider prefix
  const parts = raw.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : raw;
}

// ─── Read REAL cumulative costs from .jsonl files ───
interface SessionData {
  key: string;
  agent: string;
  model: string;
  label: string;
  channel: string;
  updated: string;
  // Cumulative from jsonl
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  messageCount: number;
}

// Cache to avoid re-parsing huge jsonl files every request
let dataCache: { sessions: SessionData[]; ts: number } | null = null;
const CACHE_TTL = 15000; // 15s

function loadAll(): SessionData[] {
  if (dataCache && Date.now() - dataCache.ts < CACHE_TTL) return dataCache.sessions;

  const results: SessionData[] = [];
  let agents: string[];
  try { agents = readdirSync(AGENTS_DIR); } catch { return results; }

  for (const agent of agents) {
    const sessionsFile = join(AGENTS_DIR, agent, "sessions", "sessions.json");
    if (!existsSync(sessionsFile)) continue;

    let sessionsData: Record<string, any>;
    try { sessionsData = JSON.parse(readFileSync(sessionsFile, "utf8")); } catch { continue; }

    // Map sessionId → sessionKey for linking jsonl data
    const idToKey: Record<string, string> = {};
    for (const [key, val] of Object.entries(sessionsData)) {
      if (val.sessionId) idToKey[val.sessionId] = key;
    }

    // Parse all jsonl files for cumulative usage
    const sessDir = join(AGENTS_DIR, agent, "sessions");
    const jsonlFiles = readdirSync(sessDir).filter(f => f.endsWith(".jsonl"));

    // Accumulate per sessionId
    const usage: Record<string, {
      inp: number; out: number; cr: number; cw: number; cost: number; msgs: number; model: string;
    }> = {};

    for (const jf of jsonlFiles) {
      const sessionId = jf.replace(".jsonl", "");
      if (!usage[sessionId]) usage[sessionId] = { inp: 0, out: 0, cr: 0, cw: 0, cost: 0, msgs: 0, model: "" };
      const acc = usage[sessionId];

      try {
        const lines = readFileSync(join(sessDir, jf), "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type !== "message") continue;
          const m = msg.message;
          if (!m || m.role !== "assistant") continue;

          if (m.model) acc.model = m.model;
          if (m.usage) {
            acc.inp += m.usage.input || 0;
            acc.out += m.usage.output || 0;
            acc.cr += m.usage.cacheRead || 0;
            acc.cw += m.usage.cacheWrite || 0;
            acc.cost += m.usage.cost?.total || 0;
            acc.msgs++;
          }
        }
      } catch {}
    }

    // Build results
    for (const [key, val] of Object.entries(sessionsData)) {
      const sid = val.sessionId || "";
      const u = usage[sid] || { inp: 0, out: 0, cr: 0, cw: 0, cost: 0, msgs: 0, model: "" };
      results.push({
        key,
        agent,
        model: resolveModel(u.model || val.model || ""),
        label: val.origin?.label || val.deliveryContext?.to || key,
        channel: val.deliveryContext?.channel || val.lastChannel || "",
        updated: val.updatedAt ? new Date(val.updatedAt).toISOString() : "",
        totalInput: u.inp,
        totalOutput: u.out,
        totalCacheRead: u.cr,
        totalCacheWrite: u.cw,
        totalCost: u.cost,
        messageCount: u.msgs,
      });
    }
  }

  results.sort((a, b) => b.totalCost - a.totalCost);
  dataCache = { sessions: results, ts: Date.now() };
  return results;
}

// ─── Auth ───
function ok(req: Request): boolean {
  if (!DASHBOARD_PASSWORD) return true;
  const c = req.headers.get("cookie") || "";
  const m = c.match(/dash_auth=([^;]+)/);
  return m?.[1] === Buffer.from(DASHBOARD_PASSWORD).toString("base64");
}

const TOKEN_B64 = Buffer.from(DASHBOARD_PASSWORD || "x").toString("base64");

// ─── Server ───
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") return Response.json({ ok: true });

    if (p === "/login") {
      if (req.method === "POST") {
        const fd = await req.formData();
        if (fd.get("password")?.toString() === DASHBOARD_PASSWORD) {
          return new Response(null, { status: 302, headers: {
            "Location": "/",
            "Set-Cookie": `dash_auth=${TOKEN_B64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          }});
        }
        return new Response(LOGIN_HTML("Wrong password"), { headers: { "Content-Type": "text/html" } });
      }
      return new Response(LOGIN_HTML(), { headers: { "Content-Type": "text/html" } });
    }

    if (!ok(req)) return new Response(null, { status: 302, headers: { "Location": "/login" } });

    if (p === "/logout") return new Response(null, { status: 302, headers: {
      "Location": "/login", "Set-Cookie": "dash_auth=; Path=/; Max-Age=0",
    }});

    if (p === "/api/data") {
      const sessions = loadAll();
      let tI = 0, tO = 0, tCR = 0, tCW = 0, tCost = 0;
      const byModel: Record<string, any> = {};
      const byAgent: Record<string, any> = {};
      for (const s of sessions) {
        tI += s.totalInput; tO += s.totalOutput; tCR += s.totalCacheRead; tCW += s.totalCacheWrite; tCost += s.totalCost;
        const mk = s.model || "unknown";
        const bm = byModel[mk] ??= { n: 0, i: 0, o: 0, c: 0 };
        bm.n++; bm.i += s.totalInput; bm.o += s.totalOutput; bm.c += s.totalCost;
        const ba = byAgent[s.agent] ??= { n: 0, i: 0, o: 0, c: 0 };
        ba.n++; ba.i += s.totalInput; ba.o += s.totalOutput; ba.c += s.totalCost;
      }
      return Response.json({
        sessions, totalInput: tI, totalOutput: tO, totalCacheRead: tCR, totalCacheWrite: tCW,
        totalCost: tCost, byModel, byAgent,
      });
    }

    if (p === "/") return new Response(DASH_HTML, { headers: { "Content-Type": "text/html" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(`🐾 Dashboard on :${PORT}`);

// ─── Templates ───
function LOGIN_HTML(err?: string) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
form{background:#111118;border:1px solid #1e1e30;border-radius:16px;padding:40px;width:300px;text-align:center}
h1{font-size:22px;margin-bottom:24px;color:#7c83fd}
input{width:100%;padding:12px;border:1px solid #2a2a3a;border-radius:8px;background:#1a1a2e;color:#fff;font-size:14px;margin-bottom:16px;outline:none}
input:focus{border-color:#7c83fd}button{width:100%;padding:12px;border:none;border-radius:8px;background:#7c83fd;color:#fff;font-weight:600;cursor:pointer}
button:hover{background:#6a72e8}.err{color:#f87171;font-size:13px;margin-bottom:12px}
</style></head><body><form method="POST" action="/login"><h1>🐾</h1>${err ? `<div class="err">${err}</div>` : ""}
<input type="password" name="password" placeholder="Password" autofocus><button>Login</button></form></body></html>`;
}

const DASH_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Costs</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui;min-height:100vh}
header{background:#111118;padding:12px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1e1e30;position:sticky;top:0;z-index:10}
header h1{font-size:16px;color:#7c83fd}
.sp{flex:1}.ts{font-size:11px;color:#444}
.btn{background:#1a1a2e;border:1px solid #2a2a3a;color:#888;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:11px;text-decoration:none}
.btn:hover{background:#2a2a3a;color:#ccc}
.wrap{max-width:1000px;margin:0 auto;padding:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:24px}
.c{background:#111118;border:1px solid #1e1e30;border-radius:10px;padding:14px}
.c .l{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px}
.c .v{font-size:22px;font-weight:700;color:#7c83fd}
.c .v.g{color:#4ade80}
.c .s{font-size:9px;color:#444;margin-top:2px}
h2{font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px}
.sec{margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
.it{background:#111118;border:1px solid #1e1e30;border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center}
.it .n{font-size:12px;color:#bbb}.it .d{font-size:10px;color:#555;margin-top:2px}
.it .p{font-size:14px;font-weight:700;color:#4ade80;text-align:right}
table{width:100%;border-collapse:collapse;background:#111118;border-radius:10px;overflow:hidden;border:1px solid #1e1e30}
th{text-align:left;padding:8px 12px;font-size:9px;color:#444;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #1e1e30;background:#0d0d15}
td{padding:8px 12px;font-size:11px;border-bottom:1px solid #0f0f1a}
tr:last-child td{border-bottom:none}tr:hover td{background:#141420}
.m{color:#666;font-family:monospace;font-size:10px}
.gc{color:#4ade80;font-weight:600;font-family:monospace}
.ch{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;background:#1a1a2e;color:#7c83fd;border:1px solid #2a2a3a}
.note{font-size:10px;color:#444;margin-top:8px;text-align:right}
@media(max-width:600px){.cards{grid-template-columns:1fr 1fr}.c .v{font-size:18px}th,td{padding:6px 8px;font-size:10px}.grid{grid-template-columns:1fr}}
</style></head><body>
<header><h1>🐾 OpenClaw</h1><div class="sp"></div><span class="ts" id="ts"></span><button class="btn" onclick="R()">↻</button><a class="btn" href="/logout">Logout</a></header>
<div class="wrap">
<div class="cards" id="tc"></div>
<div class="sec"><h2>By Agent</h2><div class="grid" id="ba"></div></div>
<div class="sec"><h2>By Model</h2><div class="grid" id="bm"></div></div>
<div class="sec"><h2>Sessions</h2><table><thead><tr><th>Session</th><th>Agent</th><th>Model</th><th>Channel</th><th>Messages</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead><tbody id="tb"></tbody></table>
<div class="note">Costs calculated from per-message API usage. Auto-refreshes every 60s.</div></div>
</div>
<script>
const $=id=>document.getElementById(id),F=n=>n?n.toLocaleString():"0",E=s=>{const d=document.createElement("div");d.textContent=s;return d.innerHTML};
async function R(){
$("ts").textContent=new Date().toLocaleTimeString();
const d=await fetch("/api/data").then(r=>r.json());
$("tc").innerHTML=\`<div class="c"><div class="l">Total Cost</div><div class="v g">$\${d.totalCost.toFixed(4)}</div></div>
<div class="c"><div class="l">Sessions</div><div class="v">\${d.sessions.length}</div></div>
<div class="c"><div class="l">Input</div><div class="v">\${F(d.totalInput)}</div><div class="s">tokens</div></div>
<div class="c"><div class="l">Output</div><div class="v">\${F(d.totalOutput)}</div><div class="s">tokens</div></div>
<div class="c"><div class="l">Cache Read</div><div class="v">\${F(d.totalCacheRead)}</div><div class="s">tokens</div></div>\`;
$("ba").innerHTML=Object.entries(d.byAgent).sort((a,b)=>b[1].c-a[1].c).map(([k,v])=>\`<div class="it"><div><div class="n">🤖 \${k}</div><div class="d">\${v.n} sessions · \${F(v.i+v.o)} tokens</div></div><div class="p">$\${v.c.toFixed(4)}</div></div>\`).join("");
$("bm").innerHTML=Object.entries(d.byModel).filter(([k])=>k!=="unknown"&&k).sort((a,b)=>b[1].c-a[1].c).map(([k,v])=>\`<div class="it"><div><div class="n">\${k}</div><div class="d">\${v.n} sessions</div></div><div class="p">$\${v.c.toFixed(4)}</div></div>\`).join("")||"<div style='color:#444'>—</div>";
$("tb").innerHTML=d.sessions.map(s=>\`<tr>
<td>\${E(s.label)}</td><td>\${s.agent}</td><td class="m">\${s.model||"—"}</td>
<td>\${s.channel?\`<span class="ch">\${s.channel}</span>\`:""}</td>
<td style="text-align:center">\${s.messageCount}</td>
<td class="m">\${F(s.totalInput)}</td><td class="m">\${F(s.totalOutput)}</td>
<td class="m">\${F(s.totalCacheRead)}</td>
<td class="gc">$\${s.totalCost.toFixed(4)}</td></tr>\`).join("");
}
R();setInterval(R,60000);
</script></body></html>`;
