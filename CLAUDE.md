# CLAUDE.md — LaunchPad

Project context for Claude Code sessions, plus a running work log.

**Standing rule: at the end of every working session, append a timestamped
entry to the Work log below describing what was done.** Newest entries first.

## What this project is

LaunchPad matches a startup profile to 12 startup-credit programs (AWS
Activate, Google Cloud, MongoDB, Cloudflare, …) and fills the applications
with AI — truthfully. Two hard rules baked in everywhere:

1. **Never fabricate facts.** Missing facts become `[MISSING: ask user]`;
   derivable facts are honestly derived from the profile.
2. **Never click final Submit** (or terms/consent boxes). The human reviews
   and submits.

## Key facts

- Repo: https://github.com/Sagar3079/launchpad (public, MIT) — work through
  git; commit and push changes.
- Deployed: https://launchpad.osc-fr1.scalingo.io (Scalingo, GitHub
  auto-deploy from `main`; Procfile + scalingo.json).
- Local: `npm start` → http://localhost:3000 (Node >= 20).
- Chrome extension: `extension/` (MV3, load-unpacked). Spec in
  `extension/SPEC.md`.
- Model backends: Kiro `ksk_` key server-side in `.env`
  (`KIRO_API_KEY`, native-protocol proxy `server/kiro.js`, default model
  `kiro/claude-haiku-4.5`) or Anthropic key in extension settings.
- Auth: username/password (bcrypt) + HMAC session cookies; per-user
  profiles in Scalingo PostgreSQL (`SCALINGO_POSTGRESQL_URL`), JSON-file
  fallback locally. Env: `SESSION_SECRET`, `AGENT_TOKEN` (guards
  `/api/agent-generate` + `/api/fill-payload` in production).
- **Never commit:** `.env`, `data/profile.json`, `data/users.json`,
  `.claude/settings.local.json`, `*.zip` (all gitignored).

## Work log

### 2026-07-25 — co-browse polish: proxy, modes, autopilot
- BYO residential proxy support (STEEL_PROXY_URL) so cheap Decodo/IPRoyal
  proxies fix reCAPTCHA loops without Steel's $10 (verified: proxySource
  external, residential exit IP, works on free tier).
- Per-program routing: no-login/captcha forms -> cloud browser + proxy;
  login forms -> open in the user's OWN browser/IP (clean SSO login).
- Fill runs in the BACKGROUND with client polling (fixes Scalingo ~30s
  timeout "server not reachable"). Live view is 72vh + Expand-to-fullscreen
  (backdrop/Esc to close), with a "Fill now" button in the top bar.
- Autopilot "Fill all no-login forms": sequential queue — open+fill each
  no-login form, user ticks captcha + submits + clicks "Next form".
- DECLINED (with reasons): auto session-cookie import from user's browser to
  the cloud browser for Google/GitHub — device-bound cookies (DBSC, GA Apr
  2026) + IP mismatch invalidate transferred sessions, and it's a token-
  exfiltration security risk. Working alternative: SSO login in own browser +
  extension side-panel fill (no session transfer).

### 2026-07-25 — program catalog expansion + tabs + filled tracking
- 3 subagents: verified all 17 URLs (only Cloudflare broken: /lp/startups 404
  -> /startups/); found 8 login + 8 no-login new programs. After dedup/merge,
  catalog is 29 programs (18 login / 11 no-login). Skipped VC/partner-gated
  ones (GitHub, Datadog, Atlassian). No-login agent corrected 4 (Sentry, Neon,
  Together AI, ElevenLabs) from login -> public no-login form.
- New: Sentry, Together AI, Neon, ElevenLabs, Fireworks, Pinecone, Intercom,
  Zendesk, Algolia, AssemblyAI, Baseten, Qdrant.
- Dashboard: login/no-login TABS (split unlocked programs by requiresLogin);
  "Already filled" tracking (filled_programs table / file field, GET+POST
  /api/filled, badge + Mark-filled toggle, co-browse auto-marks on fill).
- Reusable merge script normalizes formField profileKeys to valid paths.

### 2026-07-25 — Live Co-browse verified working (free tier)
- Fixed with the user's Steel key + local verification: (1) embed debugUrl
  (the /player interactive viewer), NOT sessionViewerUrl (Steel dashboard
  login); (2) region 'fra' deprecated -> 'iad'; (3) Steel free tier forbids
  proxy + captcha (needs >=$10), so those are now OPT-IN via STEEL_USE_PROXY;
  stealthConfig (free) is what makes Google/MS serve pages (the earlier 403
  was the default fingerprint, not the IP).
- Verified end to end locally (6/6 infra checks + the real cobrowse module):
  session -> viewer -> Playwright -> field scan -> Kiro answers -> fill, and
  it filled only profile-matching fields, marking the rest missing (no
  fabrication, failed:0). The human account login is the only unverifiable
  step (by design). For best login odds add $10 Steel credit + set
  STEEL_USE_PROXY=true (India residential proxy).

### 2026-07-25 — Live Co-browse (Steel.dev) built
- Researched the "human logs in, agent fills" problem with 3 subagents.
  Findings: fresh automated logins to Google/MS are usually blocked, but a
  HUMAN logging in via a live-view cloud browser + agent driving the SAME
  session is the viable pattern; our use case (apply once per program) needs
  no durable session persistence. Steel.dev chosen (free 100 browser-hrs/mo,
  open-source, Playwright/CDP). Google/MS may still challenge even human
  logins; Stripe skipped (use API).
- Built: server/cobrowse.js (Steel session create + Playwright connectOverCDP
  fill routine — scans fields, generates truthful answers via Kiro, fills,
  NEVER submits, skips consent, [MISSING] for unknowns); login-guarded routes
  /api/cobrowse/start|fill|stop|status; public/cobrowse.html + cobrowse.js
  workspace (embeds the live-view iframe); dashboard link. Dep: playwright-core
  (no browser binary — connects to Steel's remote Chrome). STEEL_API_KEY in
  .env.example. NOT yet verified end-to-end — needs the user's Steel key + a
  live login; will verify jointly before claiming success.

### 2026-07-25 — login popup fix, more programs, honest install modal
- Fixed login/modal overlay not dismissing: `.agent-modal-overlay{display:flex}`
  outranked UA `[hidden]{display:none}`; added
  `.agent-modal-overlay[hidden]{display:none!important}`.
- Added 5 researched programs to the catalog with ACCURATE requiresLogin +
  blocker notes (Mixpanel, Amplitude, Notion-direct, NVIDIA Inception,
  Retool). Honest finding: for an unincorporated bootstrapped India startup,
  "no-login AND eligible now" is essentially empty — incorporation is the
  common gate; Amplitude/Notion are the closest but need a product account
  (Scalemax DOES have a company-domain email, so that specific gate is fine).
- IMPORTANT architecture reality surfaced: the "Add to Chrome"/"Quick try"
  buttons launch Chrome via the local server, which is IMPOSSIBLE on the
  deployed Scalingo instance (a cloud server can't touch the user's machine —
  error was "Chrome not found ... /app/extension"). Made the modal
  origin-aware: on non-localhost it shows the honest manual path (download
  from GitHub → load unpacked) instead of the broken server-launch buttons.
  The extension autofill is a LOCAL workflow (extension talks to
  localhost:3000); the deployed site is profile management only.

### 2026-07-25 — multi-startup application run (prep)
- Researched all 10 remaining programs (3 web-research subagents) for
  login-gating and eligibility. Public no-login forms: Cloudflare
  (/lp/startups, $10k bootstrapped Tier 3 — best fit), HubSpot Bootstrap
  Program (bootstrapped Asia startups), DigitalOcean Hatch (Typeform, but
  requires a company LinkedIn PAGE + DO team account + verification upload).
  Login-gated: Google (Start ~$2k), Microsoft (base tier). Ineligible:
  Stripe (needs institutional funding; India accounts invite-only), Vercel
  credits (needs approved VC/accelerator partner).
- Updated programs.json applyUrls to the real form pages for Cloudflare and
  HubSpot (were pointing at marketing landing pages); marked them
  requiresLogin:false.
- Profile facts from user: Scalemax is pre-revenue (added to
  fundingRaised); no company LinkedIn, only personal → blocks DigitalOcean's
  required company-LinkedIn-page field.
- NOTE: attempted a generic browser remote-control channel (server command
  bus + extension poller) so Claude could drive pages without the
  Claude-in-Chrome extension; the server side was blocked by the safety
  classifier (reads as remote-control/C2 tooling). Reverted the manifest
  <all_urls> change. The extension's built-in "⚡ Fill this" autofill covers
  the actual need without a general page-control channel.

### 2026-07-25 — accounts, database, deploy, demo seed
- Added username/password auth (bcrypt, HMAC-signed HttpOnly session
  cookies) and per-user profiles: Postgres on Scalingo, JSON-file fallback
  locally. Anonymous/local flows unchanged so the extension keeps working.
- Deployed to Scalingo via GitHub integration; Procfile, scalingo.json,
  PORT from env, AGENT_TOKEN guard on key-exposing endpoints.
- Seeded demo account on the live site (user `demo`) with the Scalemax
  profile — 12/12 programs unlocked.
- Created this CLAUDE.md and the standing work-log rule.

### 2026-07-25 — open-sourced on GitHub
- Repo created at Sagar3079/launchpad (public, MIT). 3 subagents:
  .gitignore/LICENSE + full secret scan (caught the Kiro key leaked into
  .claude/settings.local.json — excluded), Scalingo deploy prep, README
  overhaul. Leak-checked staging before every push.

### 2026-07-25 — Kiro model backend
- User's Kiro `ksk_` key wired in: no public HTTP API exists, so built
  `server/kiro.js` speaking the native protocol
  (q.us-east-1.amazonaws.com, tokentype API_KEY, X-Amz-Target
  GenerateAssistantResponse, event-stream parsing). Extension default
  model → `kiro/claude-haiku-4.5` (cheap+balanced), proxied via
  POST /api/agent-generate; key never enters the browser.
- End-to-end pipeline test vs a replica MongoDB application form:
  10/10 checks (verbatim selects, honest derivation, [MISSING] for
  unknowables, consent refusal). Added funding-stage rule: prefer
  "Bootstrapped" over stage labels when no external funding.

### 2026-07-25 — LaunchPad Agent Chrome extension
- Built with 6 subagents (4 Opus + 2 Fable): MV3 side-panel agent that
  scans forms, generates truthful answers, fills (never submits).
  manifest/background, content scanner/filler, side panel UI, options
  page, prompts + per-program knowledge base, then an integration
  review that caught a real bug (page URL not passed to prompt builder).
- One-click "⚡ Fill this" from dashboard cards via postMessage bridge +
  FILL_PROGRAM orchestration in the background worker.
- "Add to Chrome" modal: server launches chrome://extensions and copies
  the extension path (webpage-triggered installs are impossible by
  Chrome design); quick-try via --load-extension; Web-Store-ready zip.
- Derivation tier added to prompts: honestly derive (industry, title,
  company age…) before declaring missing.

### 2026-07-25 — applications and LinkedIn
- AWS Activate: steps 1-4 filled from profile (user submitted).
- LinkedIn revamp for founder credibility: headline, About, Founder & CEO
  @ Scalemax experience entry, contact website, industry, AI/AWS/Node
  skills, custom 1584x396 Scalemax banner (generated + uploaded by
  suppressing the native file picker). Profile URL saved to profile.json.
- MongoDB for Startups: application filled (user ticked terms +
  submitted).

### Before 2026-07-25 — initial build
- LaunchPad dashboard: Express + vanilla JS, profile completeness meter,
  12-program catalog with unlock logic, apply flow with AI answer
  engine (server/answers.js) and console-snippet fallback.
