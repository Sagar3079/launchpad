/* LaunchPad — snippet-builder.js
 *
 * Builds the self-contained JavaScript console snippet the user pastes into the
 * DevTools console of the *application* tab. The snippet is a DIRECT, INSTANT
 * filler: it embeds the user's profile and matches visible form fields to those
 * values by label/name/placeholder — no page-agent, no LLM call, no network at
 * fill time (verified ~1s to fill a full Marketo form). It NEVER submits and
 * never touches consent/terms fields.
 *
 * Why not page-agent + an LLM anymore: the LLM path was slow (a reasoning model
 * at ~30-45s per step, multiple steps) and depended on CORS/DNS to a model API.
 * Deterministic matching from the profile fills the same fields instantly.
 *
 * Exposed as a global (no build step / modules): window.LaunchPadSnippet
 */
(function (global) {
  'use strict';

  /**
   * Flatten the stored {basic, extended} profile into the flat keys the filler
   * matches on. First/last name are derived from the founder's full name.
   * @param {Object} profile  {basic:{...}, extended:{...}}
   * @returns {Object} flat profile
   */
  function flattenProfile(profile) {
    var b = (profile && profile.basic) || {};
    var e = (profile && profile.extended) || {};
    var full = String(e.founderName || '').trim();
    var sp = full.indexOf(' ');
    return {
      fullName: full,
      first: sp > 0 ? full.slice(0, sp) : full,
      last: sp > 0 ? full.slice(sp + 1).trim() : '',
      company: b.startupName || '',
      email: b.email || '',
      phone: b.phone || '',
      website: b.website || '',
      country: b.country || '',
      city: '',
      state: '',
      foundedYear: b.foundedYear || '',
      teamSize: e.teamSize || '',
      industry: e.industry || '',
      description: b.description || e.pitch || '',
      // Honest derivation: no external funding recorded => bootstrapped.
      stage: e.stage || (e.fundingRaised ? '' : 'Bootstrapped')
    };
  }

  /**
   * The in-page filler. Serialized into the snippet via .toString(), so it must
   * be SELF-CONTAINED (no closure references beyond its P argument + DOM APIs).
   * Fills visible inputs/textareas/selects from P; skips consent + already-filled
   * fields; never submits. Returns {filled:[], skipped:[]}.
   */
  function LAUNCHPAD_FILL(P) {
    var CONSENT = /terms|agree|consent|privacy|subscribe|newsletter|opt.?in|marketing/i;
    var filled = [];
    var skipped = [];
    var vis = function (el) { return !!(el.offsetParent || el.getClientRects().length); };
    var ctx = function (el) {
      var lbl = '';
      if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) lbl = l.textContent; }
      if (!lbl) { var w = el.closest('label'); if (w) lbl = w.textContent; }
      return ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + lbl).toLowerCase();
    };
    var valueFor = function (el, kind, t) {
      if (CONSENT.test(t)) return null;
      if (kind === 'textarea') return P.description || null;
      if (el.type === 'tel' || /phone|mobile|contact ?number|\btel\b/.test(t)) return P.phone || null;
      if (/e-?mail/.test(t)) return P.email || null;
      if (/first ?name|given ?name|\bfname\b/.test(t)) return P.first || null;
      if (/last ?name|surname|family ?name|\blname\b/.test(t)) return P.last || null;
      if (/company|organi[sz]ation|startup|business ?name/.test(t)) return P.company || null;
      if (/website|url|domain|web ?site/.test(t)) return P.website || null;
      if (/country/.test(t)) return P.country || null;
      if (/\bcity\b|town/.test(t)) return P.city || null;
      if (/\bstate\b|province|region/.test(t)) return P.state || null;
      if (/found(ed|ing)|founded ?year|incorporat/.test(t)) return P.foundedYear || null;
      if (/team ?size|employees|headcount/.test(t)) return P.teamSize || null;
      if (/industry|vertical|sector|category/.test(t)) return P.industry || null;
      if (/fund(ing|ed)|\bstage\b|\bround\b|raised/.test(t)) return P.stage || null;
      if (/full ?name|your ?name|contact ?name|founder|\bname\b/.test(t)) return P.fullName || null;
      return null;
    };
    var setInput = function (el, val) {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try { el.blur(); } catch (e) {}
    };
    var setSelect = function (el, val) {
      var opts = Array.prototype.slice.call(el.options).filter(function (o) { return o.text.trim(); });
      var lv = val.toLowerCase();
      var opt = opts.filter(function (o) { return o.text.trim().toLowerCase() === lv; })[0]
        || opts.filter(function (o) { return o.text.toLowerCase().indexOf(lv) !== -1; })[0]
        || opts.filter(function (o) { return o.text.trim() && lv.indexOf(o.text.trim().toLowerCase()) !== -1; })[0];
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return opt.text.trim(); }
      return null;
    };
    var els = document.querySelectorAll('input, textarea, select');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'file', 'checkbox', 'radio'].indexOf(type) !== -1) continue;
      if (el.disabled || el.readOnly || !vis(el)) continue;
      if (el.value && String(el.value).trim()) continue; // don't overwrite existing input
      var kind = el.tagName.toLowerCase() === 'select' ? 'select' : el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text';
      var t = ctx(el);
      var val = valueFor(el, kind, t);
      var shortLabel = t.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!val) { skipped.push(shortLabel); continue; }
      if (kind === 'select') {
        var picked = setSelect(el, val);
        if (picked) filled.push(shortLabel + ' => ' + picked); else skipped.push(shortLabel + ' (no matching option)');
      } else {
        setInput(el, val);
        filled.push(shortLabel + ' => ' + String(val).slice(0, 40));
      }
    }
    return { filled: filled, skipped: skipped };
  }

  /**
   * Build the pasteable console snippet from a profile.
   * @param {Object} opts  { profile: {basic, extended} }
   * @returns {{snippet:string, hasKey:boolean}}
   */
  function buildSnippet(opts) {
    opts = opts || {};
    var P = flattenProfile(opts.profile);
    var pLit = JSON.stringify(P);
    var fnStr = LAUNCHPAD_FILL.toString();
    var snippet =
      '/* LaunchPad instant fill — paste into the DevTools console of the APPLICATION tab. */\n' +
      '(function () {\n' +
      '  var P = ' + pLit + ';\n' +
      '  var FILL = ' + fnStr + ';\n' +
      '  var r = FILL(P);\n' +
      '  console.log("[LaunchPad] Filled " + r.filled.length + " field(s); " + r.skipped.length + " left for you. NEVER submitted — review every field, then submit yourself.");\n' +
      '  if (r.filled.length) console.log("[LaunchPad] Filled:\\n" + r.filled.map(function (x) { return "  + " + x; }).join("\\n"));\n' +
      '  if (r.skipped.length) console.log("[LaunchPad] Left blank (no matching profile value, or a consent field):\\n" + r.skipped.map(function (x) { return "  - " + x; }).join("\\n"));\n' +
      '})();\n';
    return { snippet: snippet, hasKey: true };
  }

  /**
   * Convenience: build the snippet straight from a /api/fill-payload response.
   * @param {Object} payload  { profile, ... }
   * @returns {{instruction:string, snippet:string, hasKey:boolean}}
   */
  function buildFromPayload(payload) {
    payload = payload || {};
    var built = buildSnippet({ profile: payload.profile });
    return { instruction: '', snippet: built.snippet, hasKey: true };
  }

  global.LaunchPadSnippet = {
    flattenProfile: flattenProfile,
    buildSnippet: buildSnippet,
    buildFromPayload: buildFromPayload
  };
})(window);
