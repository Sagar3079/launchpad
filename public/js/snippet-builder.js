/* LaunchPad — snippet-builder.js
 *
 * Builds the self-contained JavaScript console snippet that a user pastes into
 * the DevTools console of the *application* tab. The snippet injects the
 * page-agent CDN bundle, constructs a PageAgent against Anthropic's
 * OpenAI-compatible endpoint, and asks it to fill (but NEVER submit) the form.
 *
 * page-agent facts confirmed from https://github.com/alibaba/page-agent (v1.12.2):
 *   - CDN IIFE build: dist/iife/page-agent.demo.js  → global `window.PageAgent`
 *   - The .demo.js bundle AUTO-INITIALISES its own demo agent. To stop that and
 *     construct our own instance we append `?autoInit=false` to the script src.
 *   - Constructor: new PageAgent({ model, baseURL, apiKey, language })
 *   - agent.execute(instruction) returns a Promise.
 *
 * Exposed as a global (no build step / modules): window.LaunchPadSnippet
 */
(function (global) {
  'use strict';

  var CDN_URL =
    'https://cdn.jsdelivr.net/npm/page-agent@1.12.2/dist/iife/page-agent.demo.js?autoInit=false';
  var MODEL = 'deepseek-v4-flash-free';
  var BASE_URL = 'https://opencode.ai/zen/v1/';
  var LANGUAGE = 'en-US';
  var API_KEY_PLACEHOLDER = 'YOUR_ANTHROPIC_API_KEY';

  /**
   * Build the natural-language instruction handed to page-agent.execute().
   * @param {Object} program  program object (uses .name)
   * @param {Array}  answers   [{label, value, note}] — the user's *edited* answers
   * @returns {string}
   */
  function buildInstruction(program, answers) {
    var name = (program && program.name) || 'this';
    var pairs = (answers || [])
      .filter(function (a) {
        return a && a.label != null && a.value != null && String(a.value).trim() !== '';
      })
      .map(function (a) {
        // Collapse newlines so each pair stays on one readable line.
        var value = String(a.value).replace(/\s*\n\s*/g, ' ').trim();
        return '- "' + String(a.label).trim() + '": "' + value + '"';
      });

    var lines = [];
    lines.push(
      'You are filling out the "' +
        name +
        '" application form on the current web page. Fill the visible form fields using the label → value pairs below. Match each value to the field whose visible label, question text, or placeholder is the closest meaning (case-insensitive, best effort).'
    );
    lines.push('');
    lines.push('Field values to enter:');
    lines.push.apply(lines, pairs);
    lines.push('');
    lines.push('Rules you must follow strictly:');
    lines.push(
      '1. Only fill a field when it clearly corresponds to one of the labels above. If a field on the page has no matching value, leave it untouched — do not guess.'
    );
    lines.push(
      '2. Type the values exactly as provided. Do NOT invent, embellish, or alter any facts. You may adapt formatting to the field type (e.g. pick the matching option in a dropdown).'
    );
    lines.push(
      '3. If a value contains "[MISSING", skip that field and leave it blank for the human to complete.'
    );
    lines.push(
      '4. DO NOT submit the form. NEVER click any Submit, Apply, Send, Continue, or Next button. Stop as soon as the fields are filled so the human can review and submit themselves.'
    );
    return lines.join('\n');
  }

  /**
   * Build the pasteable console snippet.
   * @param {Object} opts
   * @param {string}      opts.instruction  instruction string (from buildInstruction)
   * @param {string|null} opts.apiKey       Anthropic key, or null → placeholder
   * @returns {{snippet: string, hasKey: boolean}}
   */
  function buildSnippet(opts) {
    opts = opts || {};
    var hasKey = typeof opts.apiKey === 'string' && opts.apiKey.length > 0;
    var apiKey = hasKey ? opts.apiKey : API_KEY_PLACEHOLDER;
    var instruction = opts.instruction || '';

    // JSON.stringify produces safe, correctly-escaped double-quoted JS string
    // literals for embedding arbitrary text (handles quotes, newlines, backticks).
    var keyLit = JSON.stringify(apiKey);
    var instrLit = JSON.stringify(instruction);
    var srcLit = JSON.stringify(CDN_URL);

    var snippet =
      '/* LaunchPad auto-fill — paste into the DevTools console of the APPLICATION tab. */\n' +
      '(async () => {\n' +
      '  const SRC = ' + srcLit + ';\n' +
      '  const API_KEY = ' + keyLit + ';\n' +
      '  const INSTRUCTION = ' + instrLit + ';\n' +
      '\n' +
      '  if (API_KEY === "' + API_KEY_PLACEHOLDER + '") {\n' +
      '    console.warn("[LaunchPad] Replace YOUR_ANTHROPIC_API_KEY with a real key, or use the manual fallback.");\n' +
      '    return;\n' +
      '  }\n' +
      '\n' +
      '  if (!window.PageAgent) {\n' +
      '    await new Promise((resolve, reject) => {\n' +
      '      const s = document.createElement("script");\n' +
      '      s.src = SRC;\n' +
      '      s.crossOrigin = "anonymous";\n' +
      '      s.onload = resolve;\n' +
      '      s.onerror = () => reject(new Error(\n' +
      '        "Could not load page-agent — this site\'s CSP likely blocks external scripts. Use LaunchPad\'s manual fallback (Step 4)."\n' +
      '      ));\n' +
      '      document.head.appendChild(s);\n' +
      '    });\n' +
      '  }\n' +
      '\n' +
      '  const agent = new window.PageAgent({\n' +
      '    model: "' + MODEL + '",\n' +
      '    baseURL: "' + BASE_URL + '",\n' +
      '    apiKey: API_KEY,\n' +
      '    language: "' + LANGUAGE + '",\n' +
      '  });\n' +
      '\n' +
      '  console.log("[LaunchPad] page-agent loaded — filling the form. It will NOT submit; review before you click Submit.");\n' +
      '  await agent.execute(INSTRUCTION);\n' +
      '  console.log("[LaunchPad] Done. Review EVERY field for accuracy, then submit the form yourself.");\n' +
      '})();\n';

    return { snippet: snippet, hasKey: hasKey };
  }

  /**
   * Convenience: build instruction + snippet in one call from a fill-payload,
   * overriding the payload's answers with the user's edited answers.
   * @param {Object} payload        GET /api/fill-payload/:id → {program, apiKey, ...}
   * @param {Array}  editedAnswers  the user's edited [{label,value,note}]
   * @returns {{instruction:string, snippet:string, hasKey:boolean}}
   */
  function buildFromPayload(payload, editedAnswers) {
    payload = payload || {};
    var instruction = buildInstruction(payload.program, editedAnswers);
    var built = buildSnippet({ instruction: instruction, apiKey: payload.apiKey });
    return {
      instruction: instruction,
      snippet: built.snippet,
      hasKey: built.hasKey,
    };
  }

  global.LaunchPadSnippet = {
    CDN_URL: CDN_URL,
    buildInstruction: buildInstruction,
    buildSnippet: buildSnippet,
    buildFromPayload: buildFromPayload,
  };
})(window);
