# LaunchPad Agent — Chrome Extension Spec (v1.0)

AI agent that lives in Chrome's side panel and fills startup-benefit applications
(AWS Activate, MongoDB for Startups, Google for Startups, Cloudflare, etc.) with
TRUTHFUL answers generated from the user's saved startup profile.

## Hard rules (non-negotiable, enforced in code AND prompts)
1. **Never fabricate facts.** Answers use only profile data. Missing fact →
   value `[MISSING: ask user]`, flagged amber in UI, never auto-filled.
2. **Never click Submit / final CTA.** The agent fills fields only. Submit,
   terms-checkboxes, and consent boxes are ALWAYS left to the human.
3. API key lives only in `chrome.storage.local`. Never logged, never sent
   anywhere except `https://api.anthropic.com`.
4. No external CDNs / remote scripts. 100% local vanilla JS, no build step.

## Files & ownership (each agent writes ONLY its own files)
| Agent | Files |
|---|---|
| A | `manifest.json`, `background.js` |
| B | `content.js` |
| C | `sidepanel.html`, `sidepanel.css`, `sidepanel.js` |
| D | `options.html`, `options.css`, `options.js` |
| E | `prompts.js` |
| F (reviewer) | may patch any file + writes `README.md` |
| build script (already done) | `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` |

## Manifest (MV3)
- `manifest_version: 3`, name "LaunchPad Agent", version "1.0.0"
- `permissions`: `storage`, `sidePanel`, `activeTab`, `scripting`, `tabs`
- `host_permissions`: `https://api.anthropic.com/*`, `http://localhost:3000/*`
- content script: `content.js` on `<all_urls>`, `run_at: document_idle`
- background: `{ "service_worker": "background.js", "type": "module" }`
- `action` (click opens side panel via `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` in background)
- `options_page: options.html`
- icons 16/48/128 from `icons/`

## chrome.storage.local schema
```js
{
  apiKey: "sk-ant-...",            // string, default ""
  model: "claude-opus-4-8",        // one of MODELS below
  profile: { basic: {...}, extended: {...} },  // exact LaunchPad schema (see below)
  history: [ {ts, host, fieldsFilled, missing} ]  // last 20 runs, newest first
}
```
MODELS = `claude-opus-4-8` (default), `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`.

Profile schema (identical to LaunchPad `data/profile.json`):
`basic`: startupName, website, email, description, country, foundedYear —
`extended`: stage, fundingRaised, teamSize, industry, linkedin, pitch,
techStack, monthlyCloudSpend, incorporated, founderName, founderRole.
All strings, default "".

## Message protocol (chrome.runtime / chrome.tabs messages)
Every message: `{type, payload}`. Every response: `{ok:true, data}` or `{ok:false, error}`.

1. `SCAN_FORM` — sidepanel → content (tabs.sendMessage, active tab)
   → data: `{url, title, fields: [Field]}`
   `Field = {fid, label, kind, tag, inputType, options?, currentValue, required, placeholder, context}`
   - `fid`: stable id assigned by content.js (e.g. "f0", "f1"), kept in a WeakMap/`data-lpa-fid` attr
   - `kind`: "text" | "textarea" | "select" | "radio" | "checkbox" | "combobox" | "unknown"
   - `options`: array of {value, text} for select/radio/known comboboxes
   - `context`: nearby helper text (hints/descriptions), ≤200 chars
   - EXCLUDE: password fields, credit-card/SSN-looking fields, hidden inputs,
     search bars, login forms (heuristic: page has password field → skip that form),
     submit buttons, file inputs.
2. `GENERATE_ANSWERS` — sidepanel → background
   payload: `{url, title, fields}` → background loads profile+key from storage,
   calls Anthropic, returns data: `{answers: [Answer], mode}`
   `Answer = {fid, value, note, missing:boolean, confidence: "high"|"medium"|"low"}`
   For select/radio: `value` MUST be one of the provided option texts/values, or missing:true.
   If no API key configured → `{ok:false, error:"NO_API_KEY"}`.
3. `FILL_FIELDS` — sidepanel → content
   payload: `{answers:[{fid, value}]}` → fills via native setters + dispatches
   `input`/`change` events (React/Vue compatible), returns
   data: `{filled:[fid], failed:[{fid, reason}]}`. Skips answers with missing:true.
4. `SYNC_PROFILE` — options/sidepanel → background: fetch `http://localhost:3000/api/profile`,
   save into storage, return profile. Graceful error if server down.
5. `TEST_KEY` — options → background: 1-token ping to Messages API, returns ok/error.

## background.js (Agent A)
- ES module; `import { buildSystemPrompt, buildUserPrompt, parseAnswers, MODELS } from './prompts.js'`
- onMessage router for GENERATE_ANSWERS / SYNC_PROFILE / TEST_KEY (async, `return true`)
- Anthropic call: POST `https://api.anthropic.com/v1/messages`
  headers: `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-dangerous-direct-browser-access: true`, `content-type: application/json`
  body: `{model, max_tokens: 4000, system, messages:[{role:"user", content}]}`
- Retry once on 429/5xx with 2s backoff. Map errors to friendly strings
  (401→"Invalid API key", 429→"Rate limited — try again", network→"Offline?").
- Timeout 60s via AbortController. Append run to history (cap 20).
- On install: `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})`.

## content.js (Agent B)
- Label resolution order: `<label for>`, wrapping label, `aria-label`,
  `aria-labelledby`, placeholder, preceding heading/text node. Trim to 120 chars.
- Custom combobox detection: `role="combobox"`, `aria-haspopup="listbox"`, or
  button+hidden-input patterns → kind "combobox", fill best-effort:
  set hidden input if present, else report failed with reason "combobox — fill manually".
- Fill: use `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set`
  (and Textarea equivalent) then dispatch `input` + `change` bubbling events;
  for select: match option by exact text, then case-insensitive, then startsWith → set value + change event;
  for radio/checkbox: click the matching input.
- After filling, outline filled fields `2px solid #D97757` for 3s.
- NEVER interact with submit buttons or checkboxes whose label matches
  /terms|agree|consent|privacy|subscribe|newsletter/i (report as skipped:"consent — left for you").
- Guard all logic in try/catch per field; one bad field never kills the scan.

## sidepanel (Agent C)
Claude aesthetic: cream `#F0EEE6` bg, ink `#141413` text, coral `#D97757` accents,
Georgia/serif headings, 12px radius cards. Layout top→bottom:
1. Header: 🚀 LaunchPad Agent + status dot (grey idle / amber working / green done / red error)
2. Big primary button **"Scan & Generate"** (disabled while working, shows spinner)
3. Answers list: one card per field — label, editable value (input/textarea inline),
   note in small grey, amber left-border + "[MISSING]" chip when missing,
   confidence chip. Card has "copy" button.
4. Sticky footer: **"Fill page"** button + text "Submit is always left to you." +
   "42/45 filled" result line after fill; failed fields listed with reason.
5. Error banner area (red card) for NO_API_KEY (link to options), server errors.
6. Small toolbar: model badge (from storage), "↻ sync profile", "⚙ settings" (opens options).
Persist last scan/answers per-tab in memory only. Escape all page-derived text (XSS).

## options (Agent D)
Sections, same aesthetic:
1. **API key**: password-type input + show/hide toggle, Save, "Test key" button
   with inline ✓/✗ result. Key masked as `sk-ant-…abcd` when saved.
2. **Model**: radio group of MODELS with one-line descriptions
   (Opus 4.8 — best default; Fable 5 — most capable; Sonnet 5 — fast; Haiku 4.5 — cheapest).
3. **Profile**: form with all 17 profile fields (grouped Basic / Extended),
   Save + "Sync from LaunchPad (localhost:3000)" button.
4. **Danger zone**: Clear key / Clear all data.
Toast confirmations. All storage writes merge, never clobber other keys.

## prompts.js (Agent E)
Exports: `MODELS`, `buildSystemPrompt(profile)`, `buildUserPrompt(scan)`, `parseAnswers(rawText, fields)`.
- System prompt: role ("expert startup-program application writer"), the
  no-fabrication rule with [MISSING: ask user] convention, never-submit rule,
  persuasive-but-truthful style guide, the full profile as JSON, plus
  PROGRAM_HINTS matched by URL host (aws→ mention concrete services from techStack;
  mongodb→ how Atlas fits; cloudflare/google/etc.) — include hints for
  startups.aws.com|aws.amazon, mongodb.com, cloud.google.com, cloudflare.com,
  microsoft.com, notion.so, stripe.com, vercel.com, digitalocean.com, generic fallback.
- User prompt: page url/title + numbered field list (label, kind, options,
  required, context, current value) + STRICT output contract:
  reply ONLY with JSON `{"answers":[{"fid","value","note","missing","confidence"}]}`.
  Select/radio values must be copied verbatim from options. Respect maxlength
  if present in context. Char guidance: text ≤ field-appropriate length,
  textarea 2-4 sentences unless context suggests more.
- `parseAnswers`: strip code fences, find first `{`..last `}`, JSON.parse,
  validate each answer (fid exists in fields, select value ∈ options else missing:true),
  fill defaults, never throw — on unparseable return `{answers:[], error}`.

## Coding standards
Vanilla ES2022, no frameworks, no innerHTML with untrusted strings
(use textContent / createElement), every async path try/catch with user-visible
error, JSDoc on exported functions, files ≤ ~400 lines where feasible.
