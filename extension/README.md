# 🚀 LaunchPad Agent

A Chrome (Manifest V3) extension that lives in the side panel and drafts **truthful** answers
for startup-benefit applications — AWS Activate, MongoDB for Startups, Google for Startups
Cloud Program, Cloudflare for Startups, and more — using only the facts in your saved
startup profile. It knows how each program's reviewers think and tailors answers accordingly.

## Hard rules

- **Never fabricates facts.** Every answer is generated only from your saved profile.
  Anything the profile doesn't cover comes back as `[MISSING: ask user]`, flagged amber
  in the panel, and is never auto-filled until you edit it.
- **Never submits.** The agent fills fields only. Submit buttons, terms-of-service
  checkboxes, and consent/newsletter boxes are always left untouched for you.

## Install (Load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select this `extension` folder.

## First-run setup

1. Open the extension's options: click the puzzle-piece icon in the toolbar →
   LaunchPad Agent → ⋮ → **Options** (or the ⚙ Settings button in the side panel).
2. Paste your Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))
   and click **Save key**, then **Test key** to verify it works.
3. Pick a model (Opus 4.8 is the default; Haiku 4.5 is the cheapest).
4. Fill in your startup profile — either click **Sync from LaunchPad (localhost:3000)**
   with the LaunchPad app running (`npm start`), or type it in manually and **Save profile**.

## Daily usage

1. Open a startup-program application page in a normal tab.
2. Click the LaunchPad Agent toolbar icon — the side panel opens.
3. Click **Scan & Generate**. The agent scans the form and drafts an answer per field.
4. Review every card. Edit anything inline — especially amber **[MISSING]** cards,
   which are never filled until you resolve them. Use **Copy** for tricky widgets.
5. Click **Fill page**. Filled fields flash a coral outline; the footer shows
   "X/Y filled" plus reasons for anything that failed.
6. Review the actual page, tick the terms checkbox, and click **Submit yourself**.
   The agent never does this for you.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "NO_API_KEY" / "API key needed" banner | Open options and save a valid Anthropic API key, then Test key. |
| "This page can't be scanned" | `chrome://` pages, the Web Store, and PDF views have no content script — open a normal website. Freshly-installed? Reload the tab once. |
| Sync from LaunchPad fails | The sync needs the LaunchPad server running locally: `npm start` so `http://localhost:3000/api/profile` responds. |
| A dropdown didn't fill | Custom (non-`<select>`) comboboxes often can't be set programmatically — they're reported as "combobox — fill manually". Use the card's Copy button and paste. |
| "Rate limited — try again" | The API returned 429; the agent already retried once. Wait a moment and re-run. |

## Privacy

Your API key and profile are stored only in `chrome.storage.local` on this device.
The key is sent to exactly one place — `https://api.anthropic.com` — and is never
logged or shared. Profile sync talks only to your own machine (`localhost:3000`).
No external CDNs, no remote scripts, no analytics.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions, side panel, options page, content script. |
| `background.js` | Service worker (ES module). Routes `GENERATE_ANSWERS` / `SYNC_PROFILE` / `TEST_KEY`, owns the Anthropic API client (timeout, retry, friendly errors), keeps run history. |
| `content.js` | Injected on every page. `SCAN_FORM` (field discovery, labels, exclusions) and `FILL_FIELDS` (native setters + React/Vue-compatible events, consent/submit guards). |
| `sidepanel.html/css/js` | The side-panel UI: Scan & Generate, editable answer cards, Fill page, error banners, model badge. |
| `options.html/css/js` | Settings: API key (save/test/mask), model picker, 17-field profile form, danger zone. |
| `prompts.js` | Pure module: `MODELS`, system/user prompt builders (with per-program reviewer hints selected by page URL), and the strict JSON answer parser/validator. |
| `icons/` | 16/48/128 px extension icons. |

All messages use `{type, payload}` and all responses use `{ok:true, data}` / `{ok:false, error}`.
