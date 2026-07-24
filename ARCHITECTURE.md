# LaunchPad — Startup Benefits Auto-Apply Platform

Local web platform: save your startup profile once → see startup-benefit programs (AWS Activate, Google for Startups Cloud, + locked ones) → click Apply Now → log in to the provider yourself → inject page-agent to AI-fill the application with optimized, TRUTHFUL answers.

**Hard rule for all generated content: NEVER fabricate facts (revenue, funding, metrics, incorporation status). Present real profile data persuasively. If a required fact is missing, output `[MISSING: ask user]` — never invent.**

## Environment
- Windows 11, Node v24 (built-in `fetch` available — do NOT add axios/node-fetch)
- Project root: `C:\Users\pc\desktop\startup`
- Server: Express on **http://localhost:3000**
- Anthropic key from `.env` → `ANTHROPIC_API_KEY` (optional; everything must degrade gracefully without it)

## File ownership (each agent writes ONLY its own files)

| Agent | Files |
|---|---|
| A (backend) | `package.json`, `server.js`, `.env.example`, `data/.gitkeep` |
| B (frontend) | `public/index.html`, `public/css/styles.css`, `public/js/app.js` |
| C (apply/inject) | `public/apply.html`, `public/js/apply.js`, `public/js/snippet-builder.js` |
| D (program data) | `data/programs.json` |
| E (answer engine) | `server/answers.js` |

## Profile schema (`data/profile.json`, created at runtime by server)

```json
{
  "basic": {
    "startupName": "", "website": "", "email": "", "description": "",
    "country": "", "foundedYear": ""
  },
  "extended": {
    "stage": "",            // idea | pre-seed | seed | series-a+
    "fundingRaised": "",    // e.g. "none", "$50k angel"
    "teamSize": "",
    "industry": "",
    "linkedin": "",
    "pitch": "",            // one-paragraph elevator pitch
    "techStack": "",
    "monthlyCloudSpend": "",
    "incorporated": "",     // yes | no
    "founderName": "",
    "founderRole": ""
  }
}
```

## API contract (server.js)

- `GET /api/profile` → full profile object (empty-string defaults if file missing)
- `POST /api/profile` → body is full profile object; persist to `data/profile.json`; respond `{ok:true}`
- `GET /api/programs` → array of program objects from `data/programs.json`, each augmented with:
  - `unlocked: boolean` — all `requiredProfileFields` non-empty in saved profile
  - `missingFields: string[]` — required fields still empty
- `GET /api/settings` → `{hasApiKey: boolean, model: "claude-opus-4-8"}`
- `POST /api/generate-answers` → body `{programId}`; calls `generateAnswers(profile, program)` from `server/answers.js`; returns `{answers: [...], mode: "ai"|"template"}`
- `GET /api/fill-payload/:programId` → `{program, profile, answers, apiKey: string|null, instruction: string}` — everything the injected page-agent snippet needs. `instruction` is a single string telling page-agent what to fill (built from answers).
- Static: serve `public/` at `/`. Also `GET /health` → `{ok:true}`.

## programs.json entry schema (Agent D)

```json
{
  "id": "aws-activate",
  "name": "AWS Activate",
  "provider": "Amazon Web Services",
  "logoEmoji": "🟠",
  "benefitSummary": "Up to $100,000 in AWS credits",
  "benefits": ["...", "..."],
  "applyUrl": "https://...",
  "requiresLogin": true,
  "loginNote": "Sign in with your AWS account first",
  "eligibility": ["...", "..."],
  "requiredProfileFields": ["basic.startupName", "basic.website", "basic.email", "basic.description"],
  "formFields": [
    {"label": "Company name", "profileKey": "basic.startupName", "type": "text"},
    {"label": "What does your startup do?", "profileKey": "generated", "type": "textarea", "hint": "what the reviewer looks for"}
  ],
  "approvalTips": ["...", "..."],
  "tier": "live"   // "live" = AWS + GCP (fully wired), "locked-extra" = unlockable extras
}
```

- 2 `tier:"live"` programs: AWS Activate, Google for Startups Cloud Program — research REAL current application form fields/eligibility.
- 8–10 `tier:"locked-extra"` programs (Microsoft for Startups, Notion, Stripe, MongoDB, Cloudflare, HubSpot, Vercel, Airtable, etc.) with real benefit info; these unlock as profile completeness grows (via `requiredProfileFields` drawing on `extended.*`).

## answers.js contract (Agent E)

`module.exports = { generateAnswers }`
`async generateAnswers(profile, program, apiKey)` → `{mode: "ai"|"template", answers: [{label, value, note}]}`
- With `apiKey`: call Anthropic Messages API natively (`https://api.anthropic.com/v1/messages`, header `x-api-key`, `anthropic-version: 2023-06-01`, model `claude-opus-4-8`) to write persuasive, truthful answers per formField. Enforce the no-fabrication rule in the system prompt; missing data → `[MISSING: ask user]`.
- Without key: deterministic template mode that assembles decent answers from profile strings.

## Apply flow (Agents B + C)

1. Dashboard card → **Apply Now** → `apply.html?program=<id>`
2. apply.html: stepper UI — (1) open official application page in new tab + log in, (2) generate answers (calls `/api/generate-answers`, shows editable preview), (3) copy the injection snippet, paste into the application tab's DevTools console (or drag bookmarklet), page-agent fills the form, (4) review before submitting — the tool never clicks final Submit.
3. Snippet (built by `snippet-builder.js` from `/api/fill-payload/:id`): loads `https://cdn.jsdelivr.net/npm/page-agent@1.12.2/dist/iife/page-agent.demo.js`, then `new PageAgent({model:'claude-opus-4-8', baseURL:'https://api.anthropic.com/v1/', apiKey, language:'en-US'}).execute(instruction)`. Fallback panel: per-field copy buttons for manual paste (some sites' CSP blocks external scripts).

## Design (Agent B + C shared theme via styles.css)

Claude/Anthropic aesthetic: warm cream background `#F0EEE6`, ink text `#141413`, Claude coral accent `#D97757`, serif display headings (Georgia/`ui-serif`), clean sans body, rounded 12px cards, generous whitespace, subtle borders `#E5E1D8`. Dark not required. Locked cards: slightly desaturated with a "🔒 Add N more fields to unlock" ribbon. Profile form: shows completeness meter + "adding X unlocks Y more programs".
