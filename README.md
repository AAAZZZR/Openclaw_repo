# Openclaw Repo

Management tools and dashboard for OpenClaw agents.

## Projects

### `/dashboard`
Agent monitoring dashboard — tracks token usage, cost, model, and step-by-step actions per session.

**Stack:** Bun + TypeScript + vanilla HTML

**Env vars required:**
- `OPENCLAW_GATEWAY_URL` — e.g. `http://your-openclaw-service:18789`
- `OPENCLAW_GATEWAY_TOKEN` — your gateway token

**Run locally:**
```bash
cd dashboard
bun run dev
```
