/* LaunchPad — apply.js
 * Drives the 4-step apply flow for apply.html?program=<id>.
 * Vanilla JS, no framework/build. Depends on window.LaunchPadSnippet (snippet-builder.js).
 */
(function () {
  'use strict';

  var state = {
    programId: null,
    program: null,
    answers: [], // [{label, value, note}] — value is the user's edited version
    mode: null, // "ai" | "template"
    generated: false,
  };

  // ---- tiny DOM helpers ----------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'hidden') { if (attrs[k]) node.setAttribute('hidden', ''); }
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function isMissing(value) { return typeof value === 'string' && value.indexOf('[MISSING') !== -1; }

  // ---- stepper -------------------------------------------------------------
  var STEP_LABELS = ['Open & sign in', 'Generate answers', 'Auto-fill', 'Review & submit'];
  function renderStepper() {
    var mount = $('stepper');
    clear(mount);
    // Steps 1 & 2 are done once answers are generated; then 3 & 4 become active.
    var current = state.generated ? 3 : 2;
    STEP_LABELS.forEach(function (label, i) {
      var n = i + 1;
      var cls = 'step-pill';
      if (n < current) cls += ' done';
      else if (n === current) cls += ' active';
      mount.appendChild(
        el('div', { class: cls }, [
          el('span', { class: 'n', text: n < current ? '✓' : String(n) }),
          el('span', { text: label }),
        ])
      );
    });
  }

  // ---- error banner --------------------------------------------------------
  function showError(msg) {
    var mount = $('error-mount');
    clear(mount);
    mount.appendChild(
      el('div', { class: 'card', style: 'border-color:#e0a93b;background:#FEF7E6;color:#7a5410' }, [
        el('strong', { text: '⚠ ' }),
        document.createTextNode(msg),
      ])
    );
  }

  // ---- fetch helpers -------------------------------------------------------
  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Request failed (' + r.status + '): ' + url);
      return r.json();
    });
  }
  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('Request failed (' + r.status + '): ' + url);
      return r.json();
    });
  }

  // ---- STEP 1 --------------------------------------------------------------
  function renderStep1() {
    var p = state.program;
    var head = $('prog-head-mount');
    clear(head);
    head.appendChild(
      el('div', { class: 'prog-head' }, [
        el('span', { class: 'prog-emoji', text: p.logoEmoji || '🚀' }),
        el('div', {}, [
          el('h1', { class: 'prog-title', text: p.name || 'Application' }),
          el('p', { class: 'prog-sub', text: (p.provider ? p.provider + ' · ' : '') + (p.benefitSummary || '') }),
        ]),
      ])
    );
    document.title = 'Apply — ' + (p.name || 'LaunchPad');

    var body = $('step1-body');
    clear(body);

    if (Array.isArray(p.benefits) && p.benefits.length) {
      var ul = el('ul', { class: 'benefit-list' });
      p.benefits.forEach(function (b) { ul.appendChild(el('li', { text: b })); });
      body.appendChild(ul);
    }

    var openBtn = el('a', {
      class: 'btn btn-primary',
      href: p.applyUrl || '#',
      target: '_blank',
      rel: 'noopener noreferrer',
    }, ['Open ' + (p.name || 'application') + ' →']);
    body.appendChild(openBtn);

    if (p.requiresLogin && p.loginNote) {
      body.appendChild(
        el('div', { class: 'login-note' }, [
          el('span', { text: '🔑' }),
          el('span', { text: p.loginNote }),
        ])
      );
    }
  }

  // ---- STEP 2 --------------------------------------------------------------
  function renderModeBadge() {
    var mount = $('mode-badge-mount');
    clear(mount);
    if (!state.mode) return;
    if (state.mode === 'ai') {
      mount.appendChild(el('span', { class: 'mode-badge mode-ai', text: 'AI-optimized' }));
    } else {
      mount.appendChild(
        el('span', {
          class: 'mode-badge mode-template',
          title: 'Add ANTHROPIC_API_KEY in .env for AI-written answers',
          text: 'Template — add ANTHROPIC_API_KEY in .env for AI answers',
        })
      );
    }
  }

  function renderAnswers() {
    var mount = $('answers-mount');
    clear(mount);
    if (!state.generated) return;

    if (!state.answers.length) {
      mount.appendChild(el('p', { class: 'muted', text: 'No form fields for this program.' }));
      return;
    }

    state.answers.forEach(function (ans, idx) {
      var missing = isMissing(ans.value);
      var field = el('div', { class: 'field' + (missing ? ' missing' : '') });

      var labelRow = el('div', { class: 'field-row' }, [
        el('label', { for: 'ans-' + idx }, [
          ans.label || 'Field ' + (idx + 1),
          missing ? el('span', { class: 'missing-flag', text: 'needs info' }) : null,
        ]),
      ]);
      field.appendChild(labelRow);

      var ta = el('textarea', { id: 'ans-' + idx });
      ta.value = ans.value != null ? ans.value : '';
      ta.addEventListener('input', function () {
        state.answers[idx].value = ta.value;
        // reflect missing highlight live
        if (isMissing(ta.value)) field.classList.add('missing');
        else field.classList.remove('missing');
        // edits invalidate any built snippet → rebuild lazily on Step 3 button
      });
      field.appendChild(ta);

      if (ans.note) field.appendChild(el('p', { class: 'hint', text: ans.note }));
      mount.appendChild(field);
    });

    // enable step 3 + refresh fallback
    renderStep3Trigger();
    renderStep4();
    renderStepper();
  }

  function onGenerate() {
    var btn = $('gen-btn');
    btn.disabled = true;
    var original = btn.textContent;
    btn.innerHTML = '<span class="spin">◌</span> Generating…';
    postJSON('/api/generate-answers', { programId: state.programId })
      .then(function (res) {
        state.answers = (res.answers || []).map(function (a) {
          return { label: a.label, value: a.value, note: a.note };
        });
        state.mode = res.mode || 'template';
        state.generated = true;
        btn.textContent = 'Regenerate answers';
        btn.disabled = false;
        renderModeBadge();
        renderAnswers();
      })
      .catch(function (err) {
        btn.textContent = original;
        btn.disabled = false;
        showError('Could not generate answers. ' + err.message);
      });
  }

  // ---- STEP 3 --------------------------------------------------------------
  function renderStep3Trigger() {
    var body = $('step3-body');
    clear(body);
    var buildBtn = el('button', { class: 'btn btn-primary', id: 'build-btn' }, [
      'Build auto-fill snippet',
    ]);
    buildBtn.addEventListener('click', onBuildSnippet);
    body.appendChild(buildBtn);
    body.appendChild(el('p', { class: 'disabled-hint', text: 'Fills instantly from your profile — no waiting, no Step 2 needed.' }));
    var out = el('div', { id: 'snippet-out' });
    body.appendChild(out);
  }

  function onBuildSnippet() {
    var btn = $('build-btn');
    btn.disabled = true;
    // The snippet fills from the PROFILE only, so fetch that directly — instant,
    // no slow answer-generation call.
    getJSON('/api/profile')
      .then(function (profile) {
        btn.disabled = false;
        btn.textContent = 'Rebuild snippet';
        var built = window.LaunchPadSnippet.buildFromPayload({ profile: profile });
        renderSnippet(built);
      })
      .catch(function (err) {
        btn.disabled = false;
        showError('Could not load your profile. ' + err.message);
      });
  }

  function renderSnippet(built) {
    var out = $('snippet-out');
    clear(out);

    if (!built.hasKey) {
      out.appendChild(
        el('div', { class: 'warn' }, [
          el('span', { text: '⚠️' }),
          el('span', {}, [
            el('strong', { text: 'Auto-fill needs an API key. ' }),
            document.createTextNode(
              'No ANTHROPIC_API_KEY was found in .env, so the snippet below has a placeholder. Add the key and restart the server, or use the '
            ),
            el('a', { href: '#step-4' }, ['manual fallback (Step 4)']),
            document.createTextNode(' which always works.'),
          ]),
        ])
      );
    }

    // Copy button
    var copyBtn = el('button', { class: 'btn btn-primary' }, ['Copy snippet']);
    copyBtn.addEventListener('click', function () {
      copyText(built.snippet, copyBtn, 'Copy snippet');
    });
    out.appendChild(copyBtn);

    // Collapsible preview
    var wrap = el('div', { class: 'code-wrap' });
    var pre = el('pre', { class: 'code-preview', hidden: true });
    pre.textContent = built.snippet;
    var toggle = el('button', { class: 'code-toggle', text: 'Show code preview ▾' });
    toggle.addEventListener('click', function () {
      var hidden = pre.hasAttribute('hidden');
      if (hidden) { pre.removeAttribute('hidden'); toggle.textContent = 'Hide code preview ▴'; }
      else { pre.setAttribute('hidden', ''); toggle.textContent = 'Show code preview ▾'; }
    });
    wrap.appendChild(toggle);
    wrap.appendChild(pre);
    out.appendChild(wrap);

    // Numbered instructions
    var ol = el('ol', { class: 'steps-ol' });
    [
      el('li', {}, ['Switch to the application tab where you signed in (Step 1).']),
      el('li', {}, ['Open DevTools: press ', el('span', { class: 'kbd', text: 'F12' }), ' (or ', el('span', { class: 'kbd', text: 'Ctrl+Shift+J' }), '), then click the ', el('strong', { text: 'Console' }), ' tab.']),
      el('li', {}, ['First time in Chrome, it blocks pasting into the console — type ', el('code', { text: 'allow pasting' }), ' and press ', el('span', { class: 'kbd', text: 'Enter' }), ' when prompted.']),
      el('li', {}, ['Paste the snippet and press ', el('span', { class: 'kbd', text: 'Enter' }), ' — it fills the visible fields instantly from your profile (about 1 second, no waiting).']),
      el('li', {}, ['It will ', el('strong', { text: 'never' }), ' click Submit. Review every field, then submit the form yourself.']),
    ].forEach(function (li) { ol.appendChild(li); });
    out.appendChild(ol);
  }

  // ---- STEP 4 --------------------------------------------------------------
  function renderStep4() {
    var body = $('step4-body');
    clear(body);
    if (!state.generated || !state.answers.length) {
      body.appendChild(el('p', { class: 'muted', text: 'Your answers will appear here after Step 2.' }));
      return;
    }

    body.appendChild(
      el('p', { class: 'step-desc', text: 'Copy any answer and paste it directly into the matching field on the application page.' })
    );

    state.answers.forEach(function (ans, idx) {
      var item = el('div', { class: 'fallback-item' });
      var copyBtn = el('button', { class: 'btn btn-ghost btn-sm' }, ['Copy']);
      copyBtn.addEventListener('click', function () {
        copyText(state.answers[idx].value || '', copyBtn, 'Copy');
      });
      item.appendChild(
        el('div', { class: 'fi-head' }, [
          el('span', { class: 'fi-label', text: ans.label || 'Field ' + (idx + 1) }),
          copyBtn,
        ])
      );
      item.appendChild(el('div', { class: 'fi-value', text: ans.value || '' }));
      body.appendChild(item);
    });

    // Final checklist
    body.appendChild(el('h3', { style: 'margin:18px 0 0;font-family:Georgia,ui-serif,serif;font-size:1rem', text: 'Before you submit' }));
    var cl = el('ul', { class: 'checklist' });
    [
      'Verify every field is accurate and truthful — nothing invented.',
      'Fill any field flagged "needs info" ([MISSING …]) yourself.',
      'Confirm you are signed in as the right account.',
      'You click Submit — LaunchPad never does.',
    ].forEach(function (t) { cl.appendChild(el('li', { text: t })); });
    body.appendChild(cl);
  }

  // ---- clipboard -----------------------------------------------------------
  function copyText(text, btn, restore) {
    function ok() {
      var prev = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(function () { btn.textContent = restore || prev; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text, ok); });
    } else {
      fallbackCopy(text, ok);
    }
  }
  function fallbackCopy(text, ok) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ok();
    } catch (e) {
      showError('Could not copy to clipboard — select the text and copy manually.');
    }
  }

  // ---- init ----------------------------------------------------------------
  function init() {
    var params = new URLSearchParams(window.location.search);
    state.programId = params.get('program');
    renderStepper();

    if (!state.programId) {
      showError('No program specified. Return to the dashboard and choose a program.');
      return;
    }

    getJSON('/api/programs')
      .then(function (programs) {
        var prog = (programs || []).filter(function (p) { return p.id === state.programId; })[0];
        if (!prog) throw new Error('Program "' + state.programId + '" not found.');
        state.program = prog;
        renderStep1();
        renderModeBadge();
        renderAnswers();
        // Step 3 fills instantly from your PROFILE — it does not need Step 2, so
        // make the snippet button available right away (Step 2 is only for the
        // manual copy-paste fallback in Step 4).
        renderStep3Trigger();
        renderStep4();
        $('gen-btn').addEventListener('click', onGenerate);

        if (prog.unlocked === false && Array.isArray(prog.missingFields) && prog.missingFields.length) {
          var hint = $('gen-hint');
          hint.hidden = false;
          hint.textContent =
            'Heads up: this program still needs profile fields (' +
            prog.missingFields.join(', ') +
            '). Answers may include [MISSING] placeholders.';
        }
      })
      .catch(function (err) {
        showError(err.message);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
