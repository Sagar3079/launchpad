/**
 * LaunchPad Agent — content.js (Agent B)
 *
 * Injected on <all_urls> at document_idle. Handles two runtime messages:
 *   - SCAN_FORM  → walks visible form controls, assigns stable fids, returns field descriptors.
 *   - FILL_FIELDS → fills fields via native setters + framework-compatible events.
 *
 * Hard rules honoured here:
 *   - Never touch submit buttons.
 *   - Never fill / toggle consent, terms, privacy, subscribe or newsletter controls.
 *   - Never scan password fields or any form that contains a password field (login heuristic).
 *
 * The file is idempotent: if injected twice, the second injection is a no-op.
 */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Idempotency guard — a second injection must not re-register listeners.
  // ---------------------------------------------------------------------------
  if (window.__LPA_CONTENT_LOADED__) {
    return;
  }
  window.__LPA_CONTENT_LOADED__ = true;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const FID_ATTR = 'data-lpa-fid';
  const MAX_FIELDS = 60;
  const MAX_CONTEXT = 200;
  const MAX_LABEL = 120;
  const OUTLINE = '2px solid #D97757';
  const OUTLINE_MS = 3000;

  /** Controls we consider "form fields" for scanning. */
  const FIELD_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[role="combobox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
  ].join(',');

  /** input[type] values we never expose. */
  const EXCLUDED_INPUT_TYPES = new Set([
    'password',
    'hidden',
    'file',
    'search',
    'submit',
    'reset',
    'button',
    'image',
  ]);

  /** Label/name patterns that indicate consent-style controls — never toggled. */
  const CONSENT_RE = /terms|agree|consent|privacy|subscribe|newsletter/i;

  /** Sensitive field name/id patterns (credit card, SSN, CVV). */
  const SENSITIVE_RE =
    /(credit|card|cc[-_]?num|cardnumber|cvv|cvc|ssn|social[-_ ]?security|tax[-_ ]?id|ein|passport|routing|iban)/i;

  /** Field-scoped runtime state. Keyed by fid string. */
  let fidCounter = 0;

  // ---------------------------------------------------------------------------
  // DOM traversal helpers (shadow-DOM aware, one level deep)
  // ---------------------------------------------------------------------------

  /**
   * Query a root for field elements, also descending into open shadow roots
   * one level deep.
   * @param {Document|ShadowRoot|Element} root
   * @returns {Element[]}
   */
  function queryFields(root) {
    /** @type {Element[]} */
    const found = [];
    let list;
    try {
      list = root.querySelectorAll(FIELD_SELECTOR);
    } catch (_e) {
      list = [];
    }
    for (const el of list) {
      found.push(el);
    }
    // Descend one level into open shadow roots hanging off any element.
    let hosts;
    try {
      hosts = root.querySelectorAll('*');
    } catch (_e) {
      hosts = [];
    }
    for (const host of hosts) {
      const sr = host.shadowRoot;
      if (sr && sr.mode === 'open') {
        try {
          for (const el of sr.querySelectorAll(FIELD_SELECTOR)) {
            found.push(el);
          }
        } catch (_e) {
          /* ignore exotic shadow roots */
        }
      }
    }
    return found;
  }

  /**
   * Visibility check per spec: rendered if it has an offsetParent OR any client rect.
   * @param {Element} el
   * @returns {boolean}
   */
  function isVisible(el) {
    try {
      if (el.offsetParent !== null) {
        return true;
      }
      return el.getClientRects().length > 0;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Read a boolean-ish attribute/property defensively.
   * @param {Element} el
   * @param {string} prop
   * @returns {boolean}
   */
  function isDisabledLike(el, prop) {
    try {
      if (el[prop]) {
        return true;
      }
      return el.hasAttribute(prop);
    } catch (_e) {
      return false;
    }
  }

  /**
   * Determine whether an element is contenteditable.
   * @param {Element} el
   * @returns {boolean}
   */
  function isContentEditable(el) {
    const attr = el.getAttribute && el.getAttribute('contenteditable');
    return attr === '' || attr === 'true';
  }

  // ---------------------------------------------------------------------------
  // Exclusion logic
  // ---------------------------------------------------------------------------

  /**
   * Collect all <form> elements that contain a password input — their fields are
   * treated as login/credential forms and skipped entirely.
   * @param {Element[]} elements
   * @returns {Set<HTMLFormElement>}
   */
  function collectPasswordForms(elements) {
    /** @type {Set<HTMLFormElement>} */
    const forms = new Set();
    for (const el of elements) {
      if (
        el.tagName === 'INPUT' &&
        String(el.type).toLowerCase() === 'password'
      ) {
        const form = el.form || (el.closest && el.closest('form'));
        if (form) {
          forms.add(form);
        }
      }
    }
    return forms;
  }

  /**
   * Should this element be excluded from the scan?
   * @param {Element} el
   * @param {Set<HTMLFormElement>} passwordForms
   * @returns {boolean}
   */
  function isExcluded(el, passwordForms) {
    // Disabled / readonly controls of any kind.
    if (isDisabledLike(el, 'disabled') || isDisabledLike(el, 'readOnly')) {
      return true;
    }

    // aria-hidden subtree.
    try {
      if (el.closest && el.closest('[aria-hidden="true"]')) {
        return true;
      }
    } catch (_e) {
      /* ignore */
    }

    const tag = el.tagName;

    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      if (EXCLUDED_INPUT_TYPES.has(type)) {
        return true;
      }
    }

    // Credit-card / SSN-looking name, id, or autocomplete.
    const nameish =
      (el.getAttribute && (el.getAttribute('name') || '')) +
      ' ' +
      (el.id || '') +
      ' ' +
      (el.getAttribute && (el.getAttribute('autocomplete') || ''));
    if (SENSITIVE_RE.test(nameish)) {
      return true;
    }
    if (/\bcc-|\bcard/i.test((el.getAttribute && el.getAttribute('autocomplete')) || '')) {
      return true;
    }

    // Inside a form that contains a password field → skip (login heuristic).
    try {
      const form = el.form || (el.closest && el.closest('form'));
      if (form && passwordForms.has(form)) {
        return true;
      }
    } catch (_e) {
      /* ignore */
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Label resolution
  // ---------------------------------------------------------------------------

  /**
   * Collapse whitespace and trim to a max length.
   * @param {string} s
   * @param {number} max
   * @returns {string}
   */
  function clean(s, max) {
    if (!s) {
      return '';
    }
    const out = String(s).replace(/\s+/g, ' ').trim();
    return out.length > max ? out.slice(0, max) : out;
  }

  /**
   * Look up an element by id within the element's root node (shadow-aware),
   * falling back to the document.
   * @param {Element} el
   * @param {string} id
   * @returns {Element|null}
   */
  function getElementByIdScoped(el, id) {
    try {
      const root = el.getRootNode();
      if (root && typeof root.getElementById === 'function') {
        const found = root.getElementById(id);
        if (found) {
          return found;
        }
      }
    } catch (_e) {
      /* ignore */
    }
    try {
      return document.getElementById(id);
    } catch (_e) {
      return null;
    }
  }

  /**
   * Resolve the best label for a control, per spec priority order:
   *   <label for>, wrapping label, aria-label, aria-labelledby, placeholder,
   *   preceding heading/text node. Trimmed to 120 chars.
   * @param {Element} el
   * @returns {string}
   */
  function resolveLabel(el) {
    // 1. <label for="id">
    if (el.id) {
      const forLabel = findLabelFor(el, el.id);
      if (forLabel) {
        const t = clean(forLabel.textContent, MAX_LABEL);
        if (t) {
          return t;
        }
      }
    }

    // 2. Wrapping <label>
    try {
      const wrap = el.closest && el.closest('label');
      if (wrap) {
        const t = clean(wrap.textContent, MAX_LABEL);
        if (t) {
          return t;
        }
      }
    } catch (_e) {
      /* ignore */
    }

    // 3. aria-label
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel) {
      const t = clean(ariaLabel, MAX_LABEL);
      if (t) {
        return t;
      }
    }

    // 4. aria-labelledby
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = [];
      for (const id of labelledby.split(/\s+/)) {
        const ref = getElementByIdScoped(el, id);
        if (ref) {
          parts.push(ref.textContent || '');
        }
      }
      const t = clean(parts.join(' '), MAX_LABEL);
      if (t) {
        return t;
      }
    }

    // 5. placeholder
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) {
      const t = clean(ph, MAX_LABEL);
      if (t) {
        return t;
      }
    }

    // 6. preceding heading / text node
    const preceding = precedingText(el);
    if (preceding) {
      return clean(preceding, MAX_LABEL);
    }

    // Fallback to name attribute.
    const name = el.getAttribute && el.getAttribute('name');
    return name ? clean(name, MAX_LABEL) : '';
  }

  /**
   * Find a <label for="id"> in the element's root (shadow-aware).
   * @param {Element} el
   * @param {string} id
   * @returns {HTMLLabelElement|null}
   */
  function findLabelFor(el, id) {
    // CSS.escape guards against ids with special chars.
    let sel;
    try {
      sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]';
    } catch (_e) {
      sel = 'label[for="' + id + '"]';
    }
    try {
      const root = el.getRootNode();
      if (root && typeof root.querySelector === 'function') {
        const found = root.querySelector(sel);
        if (found) {
          return found;
        }
      }
    } catch (_e) {
      /* ignore */
    }
    try {
      return document.querySelector(sel);
    } catch (_e) {
      return null;
    }
  }

  /**
   * Find nearby preceding text: a previous sibling heading/label/text, or a
   * heading earlier in the parent. Best-effort.
   * @param {Element} el
   * @returns {string}
   */
  function precedingText(el) {
    let node = el.previousSibling;
    let hops = 0;
    while (node && hops < 6) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = clean(node.textContent, MAX_LABEL);
        if (t) {
          return t;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (/^(LABEL|H1|H2|H3|H4|H5|H6|SPAN|P|DIV|STRONG|B)$/.test(tag)) {
          const t = clean(node.textContent, MAX_LABEL);
          if (t) {
            return t;
          }
        }
      }
      node = node.previousSibling;
      hops++;
    }
    // Look for a heading among the parent's earlier children.
    try {
      const parent = el.parentElement;
      if (parent) {
        const heading = parent.querySelector('label, h1, h2, h3, h4, h5, h6');
        if (heading && heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
          const t = clean(heading.textContent, MAX_LABEL);
          if (t) {
            return t;
          }
        }
      }
    } catch (_e) {
      /* ignore */
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Context (helper text) resolution
  // ---------------------------------------------------------------------------

  /**
   * Gather nearby hint text (following small/p elements, aria-describedby),
   * plus a maxlength annotation when present. Capped at 200 chars.
   * @param {Element} el
   * @returns {string}
   */
  function resolveContext(el) {
    const parts = [];

    // aria-describedby references.
    const describedby = el.getAttribute && el.getAttribute('aria-describedby');
    if (describedby) {
      for (const id of describedby.split(/\s+/)) {
        const ref = getElementByIdScoped(el, id);
        if (ref) {
          const t = clean(ref.textContent, MAX_CONTEXT);
          if (t) {
            parts.push(t);
          }
        }
      }
    }

    // Following sibling hint elements (small, p, .hint, .help).
    try {
      let node = el.nextElementSibling;
      let hops = 0;
      while (node && hops < 4) {
        const tag = node.tagName;
        const cls = String(node.className || '');
        if (
          tag === 'SMALL' ||
          tag === 'P' ||
          /hint|help|desc|note|caption/i.test(cls)
        ) {
          const t = clean(node.textContent, MAX_CONTEXT);
          if (t) {
            parts.push(t);
            break;
          }
        }
        node = node.nextElementSibling;
        hops++;
      }
    } catch (_e) {
      /* ignore */
    }

    // maxlength annotation.
    const maxlen = el.getAttribute && el.getAttribute('maxlength');
    if (maxlen && /^\d+$/.test(maxlen)) {
      parts.push('maxlength:' + maxlen);
    }

    return clean(parts.join(' — '), MAX_CONTEXT);
  }

  // ---------------------------------------------------------------------------
  // Field kind classification
  // ---------------------------------------------------------------------------

  /**
   * Classify a control into a Field.kind.
   * @param {Element} el
   * @returns {string}
   */
  function classifyKind(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') {
      return 'textarea';
    }
    if (tag === 'SELECT') {
      return 'select';
    }
    if (isContentEditable(el)) {
      return 'textarea';
    }
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'combobox' || (el.getAttribute && el.getAttribute('aria-haspopup') === 'listbox')) {
      return 'combobox';
    }
    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      if (type === 'radio') {
        return 'radio';
      }
      if (type === 'checkbox') {
        return 'checkbox';
      }
      return 'text';
    }
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // fid assignment / lookup
  // ---------------------------------------------------------------------------

  /**
   * Assign a stable fid to an element (idempotent) and return it.
   * @param {Element} el
   * @returns {string}
   */
  function ensureFid(el) {
    let fid = el.getAttribute(FID_ATTR);
    if (!fid) {
      fid = 'f' + fidCounter++;
      el.setAttribute(FID_ATTR, fid);
    }
    return fid;
  }

  /**
   * Find an element by fid across the document and open shadow roots.
   * @param {string} fid
   * @returns {Element|null}
   */
  function elementByFid(fid) {
    let sel;
    try {
      sel = '[' + FID_ATTR + '="' + (window.CSS && CSS.escape ? CSS.escape(fid) : fid) + '"]';
    } catch (_e) {
      sel = '[' + FID_ATTR + '="' + fid + '"]';
    }
    const direct = document.querySelector(sel);
    if (direct) {
      return direct;
    }
    // Search open shadow roots one level deep.
    try {
      for (const host of document.querySelectorAll('*')) {
        const sr = host.shadowRoot;
        if (sr && sr.mode === 'open') {
          const found = sr.querySelector(sel);
          if (found) {
            return found;
          }
        }
      }
    } catch (_e) {
      /* ignore */
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // SCAN_FORM
  // ---------------------------------------------------------------------------

  /**
   * Build the {value, text} option list for a <select>.
   * @param {HTMLSelectElement} el
   * @returns {Array<{value:string,text:string}>}
   */
  function selectOptions(el) {
    const opts = [];
    try {
      for (const o of el.options) {
        opts.push({ value: o.value, text: clean(o.textContent, 120) });
      }
    } catch (_e) {
      /* ignore */
    }
    return opts;
  }

  /**
   * Scan the page for fillable form fields.
   * @returns {{url:string, title:string, fields:Array<Object>}}
   */
  function scanForm() {
    const rawElements = queryFields(document);
    const passwordForms = collectPasswordForms(rawElements);

    /** @type {Array<Object>} */
    const fields = [];
    /** @type {Set<string>} Radio group names already emitted. */
    const seenRadioGroups = new Set();

    for (const el of rawElements) {
      if (fields.length >= MAX_FIELDS) {
        break;
      }
      try {
        if (!isVisible(el)) {
          continue;
        }
        if (isExcluded(el, passwordForms)) {
          continue;
        }

        const kind = classifyKind(el);

        // Radios: group by name into ONE field.
        if (kind === 'radio') {
          const name = (el.getAttribute && el.getAttribute('name')) || '';
          const groupKey = name || ('__anon__' + ensureFid(el));
          if (seenRadioGroups.has(groupKey)) {
            continue;
          }
          seenRadioGroups.add(groupKey);
          const field = buildRadioGroupField(el, name, passwordForms);
          if (field) {
            fields.push(field);
          }
          continue;
        }

        const field = buildField(el, kind);
        if (field) {
          fields.push(field);
        }
      } catch (_e) {
        // One bad field never kills the scan.
      }
    }

    return {
      url: location.href,
      title: document.title || '',
      fields,
    };
  }

  /**
   * Build a Field descriptor for a single (non-radio) control.
   * @param {Element} el
   * @param {string} kind
   * @returns {Object|null}
   */
  function buildField(el, kind) {
    const fid = ensureFid(el);
    const tag = el.tagName.toLowerCase();
    const inputType =
      el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';

    /** @type {Object} */
    const field = {
      fid,
      label: resolveLabel(el),
      kind,
      tag,
      inputType,
      currentValue: readValue(el, kind),
      required: readRequired(el),
      placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
      context: resolveContext(el),
    };

    if (kind === 'select') {
      field.options = selectOptions(el);
    }

    return field;
  }

  /**
   * Build a single Field descriptor representing a whole radio group.
   * @param {Element} first  Any radio in the group.
   * @param {string} name
   * @param {Set<HTMLFormElement>} passwordForms
   * @returns {Object|null}
   */
  function buildRadioGroupField(first, name, passwordForms) {
    // Gather all radios sharing the name within the same root.
    let radios = [];
    try {
      const root = first.getRootNode();
      const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
      if (name) {
        let sel;
        try {
          sel = 'input[type="radio"][name="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]';
        } catch (_e) {
          sel = 'input[type="radio"][name="' + name + '"]';
        }
        radios = Array.from(scope.querySelectorAll(sel));
      } else {
        radios = [first];
      }
    } catch (_e) {
      radios = [first];
    }

    // Filter to visible, non-excluded radios.
    radios = radios.filter(
      (r) => isVisible(r) && !isExcluded(r, passwordForms)
    );
    if (radios.length === 0) {
      return null;
    }

    const fid = ensureFid(first);
    const options = [];
    let currentValue = '';
    for (const r of radios) {
      const text = resolveLabel(r) || r.value || '';
      options.push({ value: r.value, text: clean(text, 120) });
      if (r.checked) {
        currentValue = r.value;
      }
    }

    // Group label: prefer a fieldset legend, else the shared name.
    let label = '';
    try {
      const fieldset = first.closest && first.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) {
          label = clean(legend.textContent, MAX_LABEL);
        }
      }
    } catch (_e) {
      /* ignore */
    }
    if (!label) {
      label = name ? clean(name, MAX_LABEL) : resolveLabel(first);
    }

    return {
      fid,
      label,
      kind: 'radio',
      tag: 'input',
      inputType: 'radio',
      options,
      currentValue,
      required: readRequired(first),
      placeholder: '',
      context: resolveContext(first),
    };
  }

  /**
   * Read the current value of a control.
   * @param {Element} el
   * @param {string} kind
   * @returns {string}
   */
  function readValue(el, kind) {
    try {
      if (kind === 'checkbox') {
        return el.checked ? 'true' : 'false';
      }
      if (isContentEditable(el)) {
        return clean(el.textContent, 500);
      }
      if (typeof el.value === 'string') {
        return el.value;
      }
      const attr = el.getAttribute && el.getAttribute('value');
      return attr || '';
    } catch (_e) {
      return '';
    }
  }

  /**
   * Determine whether a control is required.
   * @param {Element} el
   * @returns {boolean}
   */
  function readRequired(el) {
    try {
      if (el.required) {
        return true;
      }
      const aria = el.getAttribute && el.getAttribute('aria-required');
      return aria === 'true';
    } catch (_e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // FILL_FIELDS
  // ---------------------------------------------------------------------------

  // Cache native value setters so framework-managed inputs register changes.
  const nativeInputSetter = getNativeSetter(window.HTMLInputElement);
  const nativeTextareaSetter = getNativeSetter(window.HTMLTextAreaElement);
  const nativeSelectSetter = getNativeSetter(window.HTMLSelectElement);

  /**
   * Grab the prototype 'value' setter for a given element constructor.
   * @param {Function} ctor
   * @returns {(function(string):void)|null}
   */
  function getNativeSetter(ctor) {
    try {
      const desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'value');
      return desc && desc.set ? desc.set : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Set a value using the native prototype setter (so React/Vue/Ember detect it),
   * then dispatch bubbling input + change events.
   * @param {Element} el
   * @param {string} value
   */
  function setNativeValue(el, value) {
    let setter = null;
    if (el.tagName === 'INPUT') {
      setter = nativeInputSetter;
    } else if (el.tagName === 'TEXTAREA') {
      setter = nativeTextareaSetter;
    } else if (el.tagName === 'SELECT') {
      setter = nativeSelectSetter;
    }
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    fireEvents(el);
  }

  /**
   * Dispatch bubbling input + change events.
   * @param {Element} el
   */
  function fireEvents(el) {
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_e) {
      /* ignore */
    }
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * Is this element a consent-style control we must never toggle?
   * @param {Element} el
   * @returns {boolean}
   */
  function isConsent(el) {
    const label = resolveLabel(el);
    if (label && CONSENT_RE.test(label)) {
      return true;
    }
    const nameish =
      ((el.getAttribute && el.getAttribute('name')) || '') +
      ' ' +
      (el.id || '');
    return CONSENT_RE.test(nameish);
  }

  /**
   * Fill a <select> by matching option: exact text → case-insensitive → startsWith → value.
   * @param {HTMLSelectElement} el
   * @param {string} value
   * @returns {boolean} whether a match was applied
   */
  function fillSelect(el, value) {
    const target = String(value);
    const targetLc = target.toLowerCase();
    const options = Array.from(el.options);

    /** @type {HTMLOptionElement|null} */
    let match =
      options.find((o) => clean(o.textContent, 500) === target) || null;
    if (!match) {
      match = options.find((o) => clean(o.textContent, 500).toLowerCase() === targetLc) || null;
    }
    if (!match) {
      match = options.find((o) =>
        clean(o.textContent, 500).toLowerCase().startsWith(targetLc)
      ) || null;
    }
    if (!match) {
      match =
        options.find((o) => o.value === target) ||
        options.find((o) => String(o.value).toLowerCase() === targetLc) ||
        null;
    }
    if (!match) {
      return false;
    }
    if (nativeSelectSetter) {
      nativeSelectSetter.call(el, match.value);
    } else {
      el.value = match.value;
    }
    fireEvents(el);
    return true;
  }

  /**
   * Fill a radio group: click the radio whose value/label matches, only if state differs.
   * @param {Element} anchor  The radio the fid points to.
   * @param {string} value
   * @returns {{ok:boolean, reason?:string, el?:Element}}
   */
  function fillRadio(anchor, value) {
    const name = (anchor.getAttribute && anchor.getAttribute('name')) || '';
    let radios = [anchor];
    try {
      if (name) {
        const root = anchor.getRootNode();
        const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
        let sel;
        try {
          sel = 'input[type="radio"][name="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]';
        } catch (_e) {
          sel = 'input[type="radio"][name="' + name + '"]';
        }
        radios = Array.from(scope.querySelectorAll(sel));
      }
    } catch (_e) {
      radios = [anchor];
    }

    const target = String(value);
    const targetLc = target.toLowerCase();

    const match =
      radios.find((r) => r.value === target) ||
      radios.find((r) => String(r.value).toLowerCase() === targetLc) ||
      radios.find((r) => {
        const lbl = resolveLabel(r);
        return lbl && lbl.toLowerCase() === targetLc;
      }) ||
      radios.find((r) => {
        const lbl = resolveLabel(r);
        return lbl && lbl.toLowerCase().startsWith(targetLc);
      });

    if (!match) {
      return { ok: false, reason: 'no matching option' };
    }
    if (isConsent(match)) {
      return { ok: false, reason: 'consent — left for you' };
    }
    if (!match.checked) {
      match.click();
    }
    return { ok: true, el: match };
  }

  /**
   * Fill a checkbox toward a truthy/falsey value, honouring consent exclusion.
   * @param {HTMLInputElement} el
   * @param {string} value
   * @returns {{ok:boolean, reason?:string, el?:Element}}
   */
  function fillCheckbox(el, value) {
    if (isConsent(el)) {
      return { ok: false, reason: 'consent — left for you' };
    }
    const want = /^(true|yes|on|checked|1)$/i.test(String(value).trim());
    if (el.checked !== want) {
      el.click();
    }
    return { ok: true, el };
  }

  /**
   * Fill a contenteditable element via textContent + input event.
   * @param {Element} el
   * @param {string} value
   */
  function fillContentEditable(el, value) {
    el.textContent = String(value);
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * Apply an outline to an element for OUTLINE_MS, then restore.
   * @param {Element} el
   */
  function highlight(el) {
    try {
      const prev = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      el.style.outline = OUTLINE;
      el.style.outlineOffset = '2px';
      setTimeout(() => {
        try {
          el.style.outline = prev;
          el.style.outlineOffset = prevOffset;
        } catch (_e) {
          /* ignore */
        }
      }, OUTLINE_MS);
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * Fill the given answers into the page.
   * @param {Array<{fid:string, value:string}>} answers
   * @returns {{filled:string[], failed:Array<{fid:string, reason:string}>}}
   */
  function fillFields(answers) {
    /** @type {string[]} */
    const filled = [];
    /** @type {Array<{fid:string, reason:string}>} */
    const failed = [];

    if (!Array.isArray(answers)) {
      return { filled, failed };
    }

    for (const ans of answers) {
      const fid = ans && ans.fid;
      if (!fid) {
        continue;
      }
      /** @type {Element|null} */
      let toHighlight = null;
      try {
        const el = elementByFid(fid);
        if (!el) {
          failed.push({ fid, reason: 'field not found' });
          continue;
        }

        // Never touch submit-like controls.
        if (el.tagName === 'INPUT') {
          const type = String(el.type || '').toLowerCase();
          if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
            failed.push({ fid, reason: 'submit control — never filled' });
            continue;
          }
        }
        if (el.tagName === 'BUTTON') {
          failed.push({ fid, reason: 'button — never filled' });
          continue;
        }

        const kind = classifyKind(el);
        const value = ans.value == null ? '' : String(ans.value);

        if (kind === 'select') {
          if (fillSelect(el, value)) {
            toHighlight = el;
          } else {
            failed.push({ fid, reason: 'no matching option' });
            continue;
          }
        } else if (kind === 'radio') {
          const r = fillRadio(el, value);
          if (r.ok) {
            toHighlight = r.el || el;
          } else {
            failed.push({ fid, reason: r.reason || 'radio fill failed' });
            continue;
          }
        } else if (kind === 'checkbox') {
          const r = fillCheckbox(el, value);
          if (r.ok) {
            toHighlight = r.el || el;
          } else {
            failed.push({ fid, reason: r.reason || 'checkbox fill failed' });
            continue;
          }
        } else if (kind === 'combobox') {
          // Best-effort: set an associated hidden input if present, else fail.
          const hidden = findComboboxHidden(el);
          if (hidden) {
            setNativeValue(hidden, value);
            toHighlight = el;
          } else if (isContentEditable(el)) {
            fillContentEditable(el, value);
            toHighlight = el;
          } else {
            failed.push({ fid, reason: 'combobox — fill manually' });
            continue;
          }
        } else if (isContentEditable(el)) {
          fillContentEditable(el, value);
          toHighlight = el;
        } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          setNativeValue(el, value);
          toHighlight = el;
        } else {
          failed.push({ fid, reason: 'unsupported field' });
          continue;
        }

        filled.push(fid);
        if (toHighlight) {
          highlight(toHighlight);
        }
      } catch (err) {
        failed.push({ fid, reason: (err && err.message) || 'fill error' });
      }
    }

    return { filled, failed };
  }

  /**
   * Try to locate a hidden input backing a custom combobox.
   * @param {Element} el
   * @returns {HTMLInputElement|null}
   */
  function findComboboxHidden(el) {
    try {
      // controls / owns references.
      const owns = el.getAttribute && (el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
      if (owns) {
        for (const id of owns.split(/\s+/)) {
          const ref = getElementByIdScoped(el, id);
          if (ref && ref.tagName === 'INPUT') {
            return /** @type {HTMLInputElement} */ (ref);
          }
        }
      }
      // Sibling / descendant hidden input within the same widget container.
      const container = (el.closest && el.closest('[role="combobox"], .combobox, .select, [data-combobox]')) || el.parentElement;
      if (container) {
        const hidden = container.querySelector('input[type="hidden"], input[type="text"]');
        if (hidden && hidden !== el) {
          return /** @type {HTMLInputElement} */ (hidden);
        }
      }
    } catch (_e) {
      /* ignore */
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Message router
  // ---------------------------------------------------------------------------

  /**
   * chrome.runtime.onMessage handler. Returns true when responding asynchronously.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'SCAN_FORM') {
      try {
        const data = scanForm();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'scan failed' });
      }
      return false;
    }

    if (message.type === 'FILL_FIELDS') {
      try {
        const payload = message.payload || {};
        const answers = payload.answers || payload.fields || [];
        const data = fillFields(answers);
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'fill failed' });
      }
      return false;
    }

    return false;
  });
})();

/* ============================================================================
   LaunchPad dashboard bridge (localhost:3000 only).

   Lets the LaunchPad dashboard trigger one-click autofill:
     page --postMessage--> this bridge --runtime--> background (FILL_PROGRAM)
   and receive progress back:
     background --runtime--> this bridge --postMessage--> page (FILL_RESULT)

   Security: only ever active on the exact origin http://localhost:3000,
   only accepts messages from the page's own window, and only relays the
   two whitelisted shapes below. The apply URL is re-validated in background.
   ========================================================================== */
(() => {
  'use strict';

  if (window.__LPA_BRIDGE_LOADED__) {
    return;
  }
  window.__LPA_BRIDGE_LOADED__ = true;

  const DASH_ORIGIN = 'http://localhost:3000';
  if (window.location.origin !== DASH_ORIGIN) {
    return;
  }

  /** Announce extension presence to the dashboard page. */
  function announce() {
    try {
      const version =
        (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
      window.postMessage(
        { source: 'launchpad-agent', type: 'AGENT_READY', version },
        DASH_ORIGIN,
      );
    } catch (_e) {
      /* extension context invalidated — nothing to do */
    }
  }

  // Page -> extension.
  window.addEventListener('message', (ev) => {
    if (ev.origin !== DASH_ORIGIN || ev.source !== window) {
      return;
    }
    const d = ev.data;
    if (!d || d.source !== 'launchpad-dashboard') {
      return;
    }

    if (d.type === 'PING') {
      announce();
      return;
    }

    if (d.type === 'FILL_PROGRAM' && typeof d.applyUrl === 'string') {
      const programId = typeof d.programId === 'string' ? d.programId : '';
      try {
        chrome.runtime.sendMessage(
          { type: 'FILL_PROGRAM', payload: { applyUrl: d.applyUrl, programId } },
          (resp) => {
            const lastErr = chrome.runtime.lastError;
            window.postMessage(
              {
                source: 'launchpad-agent',
                type: 'FILL_STARTED',
                ok: !lastErr && !!(resp && resp.ok),
                error: lastErr ? lastErr.message : (resp && resp.error) || null,
                programId,
              },
              DASH_ORIGIN,
            );
          },
        );
      } catch (err) {
        window.postMessage(
          {
            source: 'launchpad-agent',
            type: 'FILL_STARTED',
            ok: false,
            error: (err && err.message) || 'extension unavailable',
            programId,
          },
          DASH_ORIGIN,
        );
      }
    }
  });

  // Extension -> page (autofill progress/result relayed from background).
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'FILL_RESULT' && message.payload) {
      const p = message.payload;
      window.postMessage(
        {
          source: 'launchpad-agent',
          type: 'FILL_RESULT',
          programId: typeof p.programId === 'string' ? p.programId : '',
          host: typeof p.host === 'string' ? p.host : '',
          filled: Number(p.filled) || 0,
          failed: Number(p.failed) || 0,
          missing: Number(p.missing) || 0,
          error: typeof p.error === 'string' ? p.error : null,
        },
        DASH_ORIGIN,
      );
    }
    return false;
  });

  announce();
})();
