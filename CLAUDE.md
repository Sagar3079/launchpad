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

### 2026-07-31 — add-ons: program search/sort/filters + dark mode
- User picked two add-ons: "filters/search/sort" + "dark mode".
- Toolbar (index.html .prog-controls + app.js): live search (name/provider/
  benefits text), sort (Default / Biggest benefit [parses $/€ + k/m] / A-Z), and
  chips India-friendly (regex on eligibility/benefit/name) + Hide-filled. refine()
  applies to the active tab's list; re-renders the cached lastProgramsData on any
  control change. Verified: search "credit" -> 12 no-login cards to 7.
- Dark mode: :root[data-theme="dark"] token overrides in styles.css (bg/ink/glass/
  shadows) + targeted fixes incl. apply.html's inline-styled bits (step-pill,
  textarea, etc.). Shared public/js/theme-toggle.js wires a #themeToggle button;
  a tiny inline <head> script on all 3 pages applies the saved theme with NO flash
  (defaults to prefers-color-scheme). Toggle added to index/apply/cobrowse headers.
- Verified with headless-Chrome screenshots: toolbar + light + dark all clean.

### 2026-07-31 — co-browse: kill stray "about:blank" tabs (target=_blank fix)
- Symptom: in the cloud browser a 2nd tab opened and hung on about:blank ("keeps
  loading"). Cause: the same-tab override only patched window.open; a
  target="_blank" link (or form) opened a real new tab that Steel's single-tab
  viewer can't reach.
- Fix (server/cobrowse.js): installSameTab(context) now also strips target on all
  a[target]/form[target] to _self (init-script + a capturing click handler +
  on-load sweep), plus window.open -> top-frame same-tab. New pickPage(context)
  closes blank stray tabs (about:blank / chrome://) and returns the real page,
  also stripping target on the live DOM. Wired into BOTH openUrl and
  fillCurrentPage. Verified openUrl still opens forms (Sentry) cleanly.

### 2026-07-31 — UI/UX overhaul (aurora + glass + CSS 3D) + local auth bypass
- User: "ui/ux sucks, improve it, use 3d animations, not too complicated; disable
  login on local svr (only I use it)."
- Local auth bypass: DISABLE_AUTH=1 (+ LOCAL_USERNAME, default filldemo) in .env.
  server.js middleware sets req.userId to the local user on every request when
  set (NEVER in prod); /api/me returns authDisabled so app.js hides all login UI
  and never prompts. Verified: /api/me -> authDisabled:true as filldemo with no
  cookie; co-browse loggedIn:true. filldemo profile (Scalemax + phone) auto-loads.
- Visual: rewrote public/css/styles.css as a modern system (kept EVERY class name
  used by index/apply/cobrowse + app.js). Animated aurora background on all pages
  (body::before), glass surfaces (backdrop-blur) for header/hero/cards/modal,
  coral->pink->violet gradient accents, gradient primary buttons, shimmering
  completeness meter, pill tabs. CSS 3D (no libs): hero has a floating rocket ORB
  with an orbiting ring + floating chips (perspective + bob/spin keyframes);
  program cards get cursor-follow tilt (app.js enhanceCards: pointermove ->
  rotateX/Y, logo pops via translateZ) + staggered rise-in reveal.
  prefers-reduced-motion disables it all.
- index.html: added the hero section (eyebrow, gradient headline, CTAs, 3D scene).
  apply.html: retheme its inline <style> (serif->sans headings, old coral
  #D97757 -> #ff6a3d) so it matches the shared theme.
- Verified with headless Chrome screenshots (dashboard, programs grid, apply):
  cohesive, modern, no layout breakage. NOTE: "import skills from fellow project"
  (caveman/ui-ux-pro-max/etc.) — those still aren't in the installed marketplaces;
  applied design fundamentals directly instead of pulling unknown code.

### 2026-07-31 — co-browse: proactive session-liveness detection ("stuck" fix)
- Symptom: co-browse fill worked (Freshworks: 13 filled, 3 left incl consent),
  then the Steel viewer showed "Session ended" but the toolbar buttons still
  looked active — stuck. Cause: the frontend only noticed a dead session when the
  NEXT open/fill call failed; at the 15-min free-tier cap (idle) nothing fired.
- Fix: server cobrowse.sessionAlive(userId) GETs the Steel session and checks
  status (released/failed/timed_out/... => dead, deletes from the Map); transient
  error => assume alive. New route GET /api/cobrowse/alive. Frontend polls it
  every 20s while a session is live and calls markSessionEnded() (now also stops
  the poll) with a clear "Session ended (15-min cap) — Start session to continue"
  message. Verified: alive=false (no session) -> true (live) -> false (released).
- HONEST LIMIT: 15 min is the Steel FREE-TIER session cap — this makes the end
  graceful/recoverable but doesn't extend it. Real long-session fix = Steel
  Profiles (persist login so a restart keeps you signed in) or a paid Steel plan;
  still not built.

### 2026-07-31 — instant deterministic fill + phone field + 2.7x faster model
- User: "so slow, not filling fast; and phone +91 9711995422 / country India not
  filling." Root causes: (a) DeepSeek V4 Flash is a reasoning model — measured
  47s default vs 26s (reasoning_effort:low) vs 17s (chat_template_kwargs
  enable_thinking:false); page-agent made MANY such calls -> minutes. (b) phone
  wasn't a profile field at all; country select wasn't matched by page-agent.
- Speed: added chat_template_kwargs:{enable_thinking:false} to every Scalemax
  call (cobrowse scalemaxGenerate, answers.js, the /api/llm proxy). ~2.7x faster,
  same output, still DeepSeek V4 Flash.
- Phone: added basic.phone to the schema (defaultProfile), the profile form
  (index.html tel input), and app.js ALL_FIELDS/LABELS. Set filldemo's phone.
- Instant snippet: REPLACED the page-agent snippet with a self-contained
  DETERMINISTIC filler (snippet-builder.js). It embeds the flattened profile and
  matches visible fields by label/name/placeholder — no page-agent, no LLM, no
  network, no API key at fill time. Handles inputs/textarea/selects, splits
  founderName into first/last, skips consent + already-filled fields, never
  submits. Verified on the REAL New Relic Marketo form via Playwright: filled 7/8
  in ~1.1s (first/last name, company, description textarea CORRECT, email, phone
  +91..., country select -> India); skipped only Funding Stage (no matching
  option — honest, no fabrication). Fake-DOM run of the generated snippet: same 7
  fields, Country select resolved to the India option. apply.js Step-3 copy
  updated (no more page-agent).
- The model-based paths (co-browse, answers.js) still exist and are now faster;
  the snippet path is instant because it needs no model at all.

### 2026-07-31 — page-agent snippet: route through a server-side LLM proxy
- Follow-up to the CORS fix. Pointing the snippet straight at Scalemax then hit
  net::ERR_NAME_NOT_RESOLVED — the user's home router DNS (192.168.1.1) can't
  resolve api.scalemax.pro from the browser (nslookup no-response; curl resolves
  via Cloudflare 104.21.46.69 after a slow 4s first lookup). Also, calling the
  provider directly embedded the sm_live_ key in the application page.
- Fix: added an OpenAI-compatible proxy on the LaunchPad server —
  POST/OPTIONS /api/llm/v1/chat/completions (open CORS, forces model
  deepseek-v4-flash, forwards to Scalemax with the key kept server-side; reuses
  AGENT_TOKEN as the bearer secret when set). snippet-builder.js now bakes in the
  LaunchPad origin (window.location.origin + /api/llm/v1) at build time, so the
  browser only talks to the origin it already resolved. fill-payload returns a
  proxy token ("launchpad" locally / AGENT_TOKEN in prod), never the real key.
  Bumped express.json limit 1mb -> 4mb (page-agent posts the DOM tree).
- Verified locally: preflight 204 + proxy POST returns a real completion (model
  forced to deepseek-v4-flash); built snippet baseURL = http://localhost:3000/
  api/llm/v1, no sm_live_ leak, no api.scalemax.pro reference. Needs
  SCALEMAX_API_KEY on Scalingo for the deployed dashboard.
- Then hit "InvokeError: Response truncated: max tokens reached" — DeepSeek V4
  Flash is a reasoning model, page-agent's small max_tokens got eaten by hidden
  reasoning. Fix: the /api/llm proxy now forces max_tokens = max(client, 16000)
  (finish_reason went length -> stop).
- RESOLVED the iframe caveat by TESTING it myself with Playwright (a standalone
  script: Steel session + playwright-core + the Scalemax profile). The New Relic
  "form" is a SAME-ORIGIN Marketo form (<form id="mktoForm_4369">), NOT a
  cross-origin iframe — the iframe SecurityErrors were just the chat widget. The
  script found 8 fields and filled First/Last name, Company, Email + textarea
  from the profile (screenshot proof, never submitted). So the snippet CAN fill
  it now that CORS+DNS+max_tokens are fixed.
- Real remaining gotcha: the DataImpulse tunnel intermittently throws
  net::ERR_TUNNEL_CONNECTION_FAILED on the first goto (heavy page). robustGoto's
  retries handle it (attempt 2 on 'commit' succeeded) — that's why the co-browse
  fill was SLOW (retrying) not broken. Possible follow-up: skip the redundant
  re-navigation in fillCurrentPage when already on applyUrl.

### 2026-07-31 — fix page-agent snippet (CORS) — migrate apply flow to Scalemax
- Bug: the apply.html "paste snippet" flow ran page-agent inside the application
  page (e.g. newrelic.com) pointed at OpenCode Zen (opencode.ai/zen), which sends
  NO CORS headers -> every model call died with "blocked by CORS policy" +
  net::ERR_FAILED. A new OpenCode key can't fix this: CORS blocks before auth.
  Also a double-slash bug (BASE_URL trailing slash + page-agent appends
  /chat/completions -> /zen/v1//chat/completions).
- Fix: point everything at Scalemax, which DOES send access-control-allow-origin:*
  (verified: OPTIONS preflight 204 + POST 200 from an Origin: newrelic.com).
  - snippet-builder.js: BASE_URL -> https://api.scalemax.pro/token/v1 (no trailing
    slash, kills the //), MODEL -> deepseek-v4-flash, placeholder/docs updated.
  - answers.js (server-side answer engine): repointed from opencode to Scalemax
    via the same SCALEMAX_BASE_URL / SCALEMAX_MODEL env vars as cobrowse.js.
  - server.js getApiKey(): prefer SCALEMAX_API_KEY (falls back to ANTHROPIC).
- Verified locally: /api/fill-payload/new-relic-startups now returns the sm_live_
  key + real AI answers (founder, scalemax.pro, AI-written description); built
  snippet has the right base/model/key and no double-slash; page-agent's exact
  POST from a newrelic.com origin returns 200. Deployed site needs SCALEMAX_API_KEY
  set on Scalingo for this to work globally.
- NOTE: the snippet embeds the sm_live_ key into whatever page it's pasted on
  (page-agent needs a client-side key) — user should rotate periodically. A
  server-side CORS proxy would avoid this but wasn't needed since Scalemax allows
  browser CORS directly.

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
