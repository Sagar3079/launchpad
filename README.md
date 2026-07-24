# 🚀 LaunchPad

One startup profile, every startup credit program. LaunchPad is a local dashboard that matches your startup against 12 benefit programs (AWS Activate, Google for Startups Cloud, Microsoft for Startups, MongoDB, Cloudflare, Stripe, Notion, Vercel, HubSpot, Airtable, Anthropic, DigitalOcean) and pairs it with **LaunchPad Agent** — a Chrome extension that scans each application form and drafts truthful, profile-grounded answers with AI, then fills the form for you to review and submit.

## Ground rules

Two rules are enforced in both code and prompts, everywhere:

1. **Never fabricates.** Answers are generated only from your saved profile. A missing fact becomes `[MISSING: ask user]` (flagged amber, never auto-filled); derivable facts are honestly derived from what the profile actually says.
2. **Never clicks Submit.** The agent fills fields only. Submit buttons, terms checkboxes, and consent boxes are always left to you.

## Features

- **Dashboard** (Express + vanilla JS, no build step): save your profile once; programs unlock as profile completeness grows (`requiredProfileFields` per program). Each card shows real benefits, eligibility, and approval tips.
- **LaunchPad Agent** (Chrome MV3 extension, side panel): Scan & Generate reads the open application form, drafts one editable answer card per field, then Fill page writes them in with React/Vue-compatible events. Password/payment/login fields are excluded from scans.
- **One-click fill from the dashboard**: the "⚡ Fill this" button hands the program context to the extension over a postMessage bridge — no copy-pasting.
- **Two model backends**: bring an Anthropic API key (stored in the extension's settings, sent only to `api.anthropic.com`), or a Kiro `ksk_` key kept server-side in `.env` and proxied through `POST /api/agent-generate` (default model `kiro/claude-haiku-4.5`).
- **Program catalog as data**: `data/programs.json` — edit it to add or tune programs.

## Quickstart

```
npm install
npm start
```

Open **http://localhost:3000**, fill in your startup profile, and save. Requires Node >= 20.

## Install the extension

Either use the dashboard's **Add to Chrome** modal, or load it manually:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder.
4. Open the extension's Options page to add an API key and sync your profile from `localhost:3000`.

## Configuration

Copy `.env.example` to `.env`. All keys are optional — without any, the dashboard runs in deterministic template mode.

| Variable | Purpose |
|---|---|
| `KIRO_API_KEY` | Kiro `ksk_` key for the server-side AI proxy (`/api/agent-generate`). Kiro has no public HTTP API, so `server/kiro.js` speaks its native AWS event-stream protocol and the key never leaves the server. |
| `ANTHROPIC_API_KEY` | Anthropic key for the server-side answer engine. (The extension can also use its own Anthropic key, saved in its settings.) |
| `AGENT_TOKEN` | When set, `/api/agent-generate` requires the `x-agent-token` header. Set this in production. |

**Never commit `.env`.** Your profile lives in `data/profile.json`, which is gitignored — nothing personal ships with the repo.

## Deploy to Scalingo

The server runs anywhere Node does; a `Procfile` (`web: node server.js`) and `scalingo.json` are included.

1. Push the repo to GitHub.
2. In the Scalingo dashboard: **New app** → link the GitHub repo.
3. Set env vars `KIRO_API_KEY` and `AGENT_TOKEN` (and optionally `ANTHROPIC_API_KEY`).
4. Deploy — Scalingo picks up the Procfile automatically.

Note: the Chrome-extension bridge (profile sync, "⚡ Fill this") only talks to `http://localhost:3000`, so a deployed instance serves the dashboard and API only.

## Architecture

| Path | Role |
|---|---|
| `server.js` | Express app: profile CRUD, program unlock logic, answer generation, fill payloads, Kiro proxy, extension install helper. |
| `server/answers.js` | Answer engine: Anthropic-backed when a key is set, deterministic template mode otherwise. |
| `server/kiro.js` | Native Kiro client (AWS event-stream framing over `q.us-east-1.amazonaws.com`). |
| `data/programs.json` | The 12-program catalog: benefits, eligibility, form fields, unlock requirements. |
| `data/profile.json` | Your startup profile (created at runtime, gitignored). |
| `public/` | Dashboard UI: `index.html` + `js/app.js` (cards, profile form), `apply.html` + `js/apply.js` (apply flow), `js/snippet-builder.js`. |
| `extension/manifest.json` | MV3 manifest: side panel, options page, content script. |
| `extension/background.js` | Service worker: message router, model API clients, retry/timeout, run history. |
| `extension/content.js` | Form scanning (labels, kinds, exclusions) and filling (native setters, consent/submit guards). |
| `extension/sidepanel.*` | Side-panel UI: Scan & Generate, editable answer cards, Fill page. |
| `extension/options.*` | Settings: API key, model picker, profile editor. |
| `extension/prompts.js` | Prompt builders with per-program reviewer hints, plus the strict JSON answer parser. |
| `Procfile`, `scalingo.json` | Scalingo deployment config. |

More detail in `ARCHITECTURE.md` and `extension/SPEC.md`.

## License

MIT
