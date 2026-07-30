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

### 2026-07-31 — catalog expansion to 41 programs (3 research subagents)
- Added 12 verified programs (29 -> 41; now 29 login / 12 no-login). 3 parallel
  research agents (cloud/DB, AI/ML, devtools+SaaS+India), each returning strict
  JSON scored with a Scalemax-eligibility verdict; merged via a validating script
  (unique ids, profileKey allowlist, login/loginNote consistency).
- Eligible-now for bootstrapped pre-revenue Scalemax: PostHog ($50k credits,
  <2yr & <$5M — best fit), Render, Supabase, WorkOS (free to 1M MAU), New Relic
  (no-login), Replicate, Cohere (no-login, 25% model discount).
- AI perk: Hugging Face (50% Enterprise, a paid discount not credits). India:
  Freshworks + Zoho (both gated on DPIIT/Startup India — honest note; Zoho has a
  non-incorporation route via ecosystem enabler). Global borderline: OVHcloud
  (EUR10k), Akamai Rise ($120k, needs one traction signal).
- SKIPPED per the no-VC-gated policy: Modal, RunPod, LangSmith, Auth0 (need
  venture backing); Scaleway (EU-only, India excluded); Statsig (~25k MAU
  target). Agents also flagged closed/unverifiable: Railway, DataStax, Redis,
  Twilio (no credits now), Postman, Linear (partner-code), Groq (invite-only).

### 2026-07-30 — new proxy + Scalemax model backend (fill verified locally)
- Old Decodo proxy sub expired. Replaced with DataImpulse (BYO residential,
  pay-as-you-go non-expiring, ~$1/GB). Chose Sticky + India targeting; verified
  exit IP = Reliance Jio residential (proxy:false, hosting:false), stable across
  requests. Only STEEL_PROXY_URL changes (local .env + Scalingo env).
- Model backend fix: Kiro hit its MONTHLY_REQUEST_COUNT limit, and the co-browse
  fill was hardcoded to Kiro with NO fallback (single point of failure). Wired
  Scalemax (the user's own product) as the PRIMARY backend: OpenAI-compatible,
  base https://api.scalemax.pro/token/v1, model deepseek-v4-flash, key sm_live_.
  Kiro is now the fallback. New env: SCALEMAX_API_KEY (+ optional
  SCALEMAX_BASE_URL / SCALEMAX_MODEL, defaults baked in). Endpoint quirks found:
  base is /token/v1 (not /v1); DeepSeek upstream throws transient
  provider_unavailable -> scalemaxGenerate retries 3x. max_tokens 8000 (reasoning
  model needs room for hidden reasoning + JSON).
- Reliability: steelFetch now retries transient network failures ("fetch failed"
  on session create) + 5xx (3x). This was the real cause of "sessions breaking a
  lot" at start — a single blip had no retry.
- VERIFIED end to end locally (filldemo user, Scalemax profile): proxy -> Steel
  session -> open Sentry form through the Indian IP -> fill via DeepSeek V4 Flash:
  filled 6, missing 1 (Sentry Org Slug, honestly flagged — no fabrication),
  failed 0, never submitted. Next: user sets STEEL_PROXY_URL + SCALEMAX_API_KEY
  on Scalingo and redeploys this commit, then verify globally.

### 2026-07-25 — co-browse reliability + unified login flow (3 subagents)
- Session stability: Steel default timeout is 5 min (why sessions kept
  ending); free tier caps at 15 min, so set timeout 900000 + no
  inactivityTimeout. Graceful "session ended" detection -> prompt restart.
- Clarity: blur was upscaling a ~720p stream; set dimensions 1920x1080 +
  blockAds + debugConfig{interactive,systemCursor} + embed
  debugUrl?interactive=true.
- Nav reliability: robustGoto() retries with looser waitUntil (fixes transient
  net::ERR_FAILED via proxy). Reclassified Mixpanel -> login (account-tied),
  Cloudflare -> no-login (account only post-approval; /startups/).
- Unified login flow: login forms now use the SAME one-window cloud flow (open
  in cloud -> user logs in in the live view -> Fill), with an "Own browser"
  fallback. Research verdict: fresh in-cloud SSO works for GitHub/email,
  fragile for Google (CDP-based block, not behavioral); OAuth popups handled
  by forcing same-tab (window.open override) since Steel's viewer shows one
  tab. Most robust future step = persist login via Steel Profiles (not yet
  built). Still declining auto cookie-transfer for Google (DBSC).

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
