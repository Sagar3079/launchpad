/**
 * prompts.js — LaunchPad Agent intelligence core (Agent E).
 *
 * Pure ES module: prompt builders + response parser for the Anthropic Messages
 * API call made by background.js. No chrome.* APIs, no network, no side effects.
 *
 * Exports: MODELS, buildSystemPrompt, buildUserPrompt, parseAnswers.
 */

/**
 * Supported Claude model ids (spec order — default first).
 * @type {string[]}
 */
export const MODELS = [
  'kiro/claude-haiku-4.5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
];

/** Confidence values accepted from the model. */
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

/** Sentinel the model must use for any fact not present in the profile. */
const MISSING_VALUE = '[MISSING: ask user]';

/**
 * Program-specific reviewer intelligence, selected by page hostname.
 * Each entry: { name, hosts, lines } — `lines` are 3-5 sharp, reviewer-aware
 * instructions distilled from each program's real approval criteria.
 * Hints reference the embedded profile ("the profile") so the model grounds
 * every claim in provided facts.
 */
const PROGRAM_HINTS = [
  {
    name: 'AWS Activate',
    hosts: ['startups.aws.com', 'aws.amazon.com'],
    lines: [
      'Domain consistency is the #1 rejection reason: the website and work-email answers must share the same domain, and the site must be live and substantive.',
      'State the funding stage exactly as in the profile: Founders package = self-funded/bootstrapped; claim Portfolio only if the profile shows a real Activate Provider affiliation (pre-Series B, applied within 12 months of the last round).',
      'Name concrete AWS services mapped from the profile techStack — e.g. EC2/ECS or Lambda for a Node/Next.js backend, RDS for PostgreSQL, S3 for assets, Bedrock for model inference. Never write "cloud hosting" generically.',
      'Tie each service to a real workload and cite the profile monthlyCloudSpend so the credit request looks proportionate and legitimate.',
      'Eligibility hinges on company age (founded within the last 10 years) — use the profile foundedYear verbatim, never adjust it.',
    ],
  },
  {
    name: 'MongoDB for Startups',
    hosts: ['mongodb.com'],
    lines: [
      'Reviewers want Series A or earlier, under 7 years old, and a single scalable software product — never an agency or consultancy framing.',
      'Explain precisely where MongoDB Atlas fits the data architecture described in the profile techStack.',
      'If the profile stack shows a different primary database (e.g. PostgreSQL), be honest: position Atlas for NEW workloads — document-model features, vector search, analytics — not a fictional migration.',
      'Mention the concrete application data that would live in Atlas, drawn from the profile description.',
    ],
  },
  {
    name: 'Google for Startups Cloud Program',
    hosts: ['cloud.google.com'],
    lines: [
      'Google explicitly checks a triple domain match: website domain, work-email domain, and Cloud Billing account email domain must all agree.',
      'State the funding stage truthfully — it routes Start vs Scale tier and funding is verified; Scale requires institutional equity funding.',
      'If the profile shows an AI-first product, say so explicitly in the description — it routes to the larger AI credit tier.',
      'Name specific services mapped from the techStack (Compute Engine or Cloud Run, Cloud SQL for PostgreSQL, BigQuery, Vertex AI, Firebase) with credible workloads.',
    ],
  },
  {
    name: 'Cloudflare for Startups',
    hosts: ['cloudflare.com'],
    lines: [
      'Funding stage maps directly to the credit tier ($5k bootstrapped up to $250k) — state it exactly as in the profile; eligibility is up to Series B and founded within 5 years.',
      'Frame answers around the Developer Platform: Workers, Pages, D1, R2, Queues — connect them to the actual architecture in the profile techStack.',
      'An active website with a matching company email is required; keep those answers consistent.',
      'Reference an accelerator/partner affiliation only if the profile shows one — it unlocks higher tiers but is verified.',
    ],
  },
  {
    name: 'Microsoft for Startups Founders Hub',
    hosts: ['microsoft.com'],
    lines: [
      'Lead with owning and building a scalable SOFTWARE PRODUCT — consulting, agency, and resale businesses are rejected outright.',
      'The Azure credit benefit requires being a new Azure customer; keep email and website domains matching.',
      'If the profile stack uses AI APIs, note that the workload maps to Azure services (e.g. Azure OpenAI Service, App Service, Azure Database for PostgreSQL).',
      'Mention investor/accelerator affiliation only if the profile shows one — it gates the higher credit tiers.',
    ],
  },
  {
    name: 'Notion for Startups',
    hosts: ['notion.so', 'notion.com'],
    lines: [
      'Eligibility is simple and checked: new non-paying Notion customer, fewer than 100 employees, company-domain email (personal Gmail/Outlook is rejected).',
      'Describe a scalable tech product in one or two crisp sentences — this is a light-touch review, so concision wins.',
      'Enter a partner/accelerator code only if the profile actually has one; it upgrades ~3 months free to 6.',
      'Keep teamSize consistent with the profile — it must be under 100.',
    ],
  },
  {
    name: 'Stripe Startups',
    hosts: ['stripe.com'],
    lines: [
      'The program targets venture-backed startups with proof of institutional funding — state the profile fundingRaised honestly; if bootstrapped, say so rather than inflating.',
      'Describe a legitimate product with concrete plans for real transaction volume — reviewers look for genuine payments intent.',
      'The benefit attaches to the Stripe account you actually process payments on; keep company details consistent with that account.',
      'A VC/accelerator partner link yields the largest fee waivers — mention affiliation only if the profile supports it.',
    ],
  },
  {
    name: 'Vercel for Startups',
    hosts: ['vercel.com'],
    lines: [
      'Eligibility: Series A or less, applied within 12 months of the most recent round, and email domain matching the website domain.',
      'If the profile techStack includes Next.js or React, lead with it — it is the natural Vercel fit; mention concrete platform usage (deployments, previews, edge/serverless functions).',
      'Approved-partner affiliation is required — reference it only if the profile shows one.',
      'Use a team that has not previously received Vercel startup credits.',
    ],
  },
  {
    name: 'DigitalOcean Startups (Hatch)',
    hosts: ['digitalocean.com'],
    lines: [
      'Hard limits: total funding of $10M or less, website domain matching the corporate email, and a product (not services/agency) business.',
      'AI-native workloads are prioritized — if the profile stack uses AI models, mention inference/GPU needs concretely.',
      'Include the profile monthlyCloudSpend when asked about cloud spend — it sizes the credit allocation.',
      'Describe the workloads you would run on DigitalOcean (compute, managed PostgreSQL, GPU Droplets) mapped from the techStack.',
    ],
  },
];

/** Fallback hints when no program host matches. */
const GENERIC_HINTS = {
  name: 'General startup program',
  lines: [
    'Consistency is everything: company name, domain, email, stage, team size, and all numbers must agree across every field and with the profile.',
    'Reviewers skim hundreds of applications — lead with the concrete product and who it serves; cut throat-clearing.',
    'Show reviewer empathy: a live product, honest stage, and a proportionate ask get approved; inflated claims get flagged.',
    'Prefer specific nouns and numbers from the profile over adjectives; one concrete fact beats three superlatives.',
  ],
};

/**
 * Extract a lowercase hostname from a URL string. Returns '' on failure.
 * @param {string} url
 * @returns {string}
 */
function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when `hostname` is `host` or a subdomain of it.
 * @param {string} hostname
 * @param {string} host
 * @returns {boolean}
 */
function hostMatches(hostname, host) {
  return hostname === host || hostname.endsWith('.' + host);
}

/**
 * Pick the program hints entry for a page URL (generic fallback otherwise).
 * @param {string} url
 * @returns {{name: string, lines: string[]}}
 */
function selectProgramHints(url) {
  const hostname = hostnameOf(url);
  if (hostname) {
    for (const entry of PROGRAM_HINTS) {
      if (entry.hosts.some((h) => hostMatches(hostname, h))) return entry;
    }
  }
  return GENERIC_HINTS;
}

/**
 * Build the system prompt: persona, iron rules, style guide, the user's
 * profile embedded as JSON, and a program-specific hints block.
 *
 * @param {object} profile - LaunchPad profile ({basic, extended}).
 * @param {string} [url] - Optional page URL used to select program hints;
 *   when omitted or unrecognized, generic guidance is appended.
 * @returns {string} System prompt text.
 */
export function buildSystemPrompt(profile, url = '') {
  const profileJson = JSON.stringify(profile && typeof profile === 'object' ? profile : {}, null, 2);
  const hints = selectProgramHints(url);

  return [
    'You are an expert startup-program application writer. You fill startup-benefit application forms (cloud credits, SaaS discounts, founder programs) on behalf of a founder, using ONLY the facts in their saved profile. You know how program reviewers think and what gets applications approved — and you know that fabricated details get them rejected and banned.',
    '',
    '## Iron rules (non-negotiable)',
    `1. Use ONLY facts from the profile below. NEVER guess or invent dates, revenue, funding amounts, employee counts, addresses, phone numbers, account IDs, registration numbers, or any other fact.`,
    `2. DERIVE before declaring missing. If a field is not answered verbatim in the profile but can be honestly derived from it, answer with the derivation and start the note with "derived from profile". Legitimate derivations: an industry/category implied by the description, a job title from founderRole, company age computed from foundedYear, target customers implied by the product description, use of a technology implied by techStack, business model implied by the pitch. Set confidence "medium" (or "low" for looser inferences). Derivation means rephrasing, categorising, or computing from known facts — it is NEVER inventing new ones. Only when a fact is neither present nor honestly derivable (specific dates, IDs, financial figures, contact details, addresses), set value to exactly "${MISSING_VALUE}" and missing to true.`,
    '3. Never suggest agreeing to terms, ticking consent/privacy/newsletter checkboxes, or submitting the form. Those actions are always left to the human.',
    '3. Do not embellish the profile. You may rephrase and select, but every claim must be traceable to a profile field.',
    '',
    '## Writing style',
    '- Persuasive but strictly truthful: concrete nouns, real numbers from the profile, active voice.',
    '- No buzzword soup — never "synergy", "cutting-edge", "revolutionary", "leverage best-in-class". One specific fact beats three superlatives.',
    '- Match register to the field: short factual fields get the bare fact; free-text fields get tight, confident prose a busy reviewer can skim.',
    '- Keep every answer internally consistent with every other answer and with the profile (same domain, same stage, same numbers).',
    '',
    '## Founder profile (single source of truth)',
    '```json',
    profileJson,
    '```',
    '',
    `## Program-specific guidance: ${hints.name}`,
    ...hints.lines.map((l) => '- ' + l),
  ].join('\n');
}

/**
 * Render one scanned field as a numbered block for the user prompt.
 * @param {object} field - Field from SCAN_FORM.
 * @param {number} index - Zero-based position.
 * @returns {string}
 */
function renderField(field, index) {
  const f = field && typeof field === 'object' ? field : {};
  const lines = [
    `${index + 1}. fid: ${f.fid ?? ''}`,
    `   label: ${f.label ?? ''}`,
    `   kind: ${f.kind ?? 'unknown'}`,
    `   required: ${f.required ? 'yes' : 'no'}`,
  ];
  if (Array.isArray(f.options) && f.options.length > 0) {
    lines.push(`   options (copy one EXACTLY verbatim): ${JSON.stringify(f.options)}`);
  }
  if (f.context) lines.push(`   context: ${f.context}`);
  if (f.placeholder) lines.push(`   placeholder: ${f.placeholder}`);
  lines.push(`   currentValue: ${f.currentValue ?? ''}`);
  return lines.join('\n');
}

/**
 * Build the user prompt from a form scan: page info, numbered field list,
 * answering instructions, and the strict JSON-only output contract.
 *
 * @param {{url: string, title: string, fields: object[]}} scan - SCAN_FORM result.
 * @returns {string} User prompt text.
 */
export function buildUserPrompt(scan) {
  const s = scan && typeof scan === 'object' ? scan : {};
  const fields = Array.isArray(s.fields) ? s.fields : [];

  return [
    `Page: ${s.title ?? ''}`,
    `URL: ${s.url ?? ''}`,
    '',
    `## Form fields (${fields.length})`,
    ...fields.map(renderField),
    '',
    '## Instructions',
    '- Answer EVERY field above, exactly one answer per fid.',
    '- For select/radio fields: value MUST be one option copied EXACTLY verbatim (its text or value, character-for-character) from that field\'s options list. If no option truthfully fits the profile, set missing to true instead of picking the closest.',
    '- Funding-stage selects: if the profile shows NO external funding raised and an option like "Bootstrapped" or "Self-funded" exists, choose it over stage labels like "Pre-seed" — startup-credit programs use this to route eligibility (e.g. AWS Founders track), and "bootstrapped" is the more precise truth.',
    '- If the context mentions a maxlength or character limit, keep the value within it.',
    '- Length: short text inputs get a concise value (a name, URL, number, or one short phrase). Textareas get 2-4 tight sentences unless the context clearly asks for more.',
    `- Any fact not present in the profile AND not honestly derivable from it (per the derivation rule): value exactly "${MISSING_VALUE}", missing true, and a note saying what to ask the user for. Prefer an honest derivation with a "derived from profile" note over marking missing.`,
    '- Do NOT answer fields that look like consent, terms-of-service, privacy agreements, or newsletter/marketing opt-ins: set missing to true with a note explaining they are left for the human.',
    '- If a field\'s currentValue is already correct for the profile, return that exact currentValue unchanged with note "already filled".',
    '- note: one short sentence of reasoning or caveat (may be ""). confidence: "high", "medium", or "low".',
    '',
    '## Output contract (STRICT)',
    'Respond with ONLY this JSON object — no prose before or after, no markdown, no code fences:',
    '{"answers":[{"fid":"f0","value":"...","note":"...","missing":false,"confidence":"high"}]}',
  ].join('\n');
}

/**
 * Strip markdown code fences (``` or ```json) wrapping a model response.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
  return text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
}

/**
 * Slice from the first "{" to the last "}" inclusive, or null if absent.
 * @param {string} text
 * @returns {string|null}
 */
function sliceJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Find the option matching a value: exact against text or value first,
 * then trimmed case-insensitive.
 * @param {string} value
 * @param {Array<{value?: string, text?: string}>} options
 * @returns {{value?: string, text?: string}|null}
 */
function matchOption(value, options) {
  for (const o of options) {
    if (o && (String(o.text ?? '') === value || String(o.value ?? '') === value)) return o;
  }
  const needle = value.trim().toLowerCase();
  for (const o of options) {
    if (!o) continue;
    if (String(o.text ?? '').trim().toLowerCase() === needle) return o;
    if (String(o.value ?? '').trim().toLowerCase() === needle) return o;
  }
  return null;
}

/**
 * Coerce and validate one raw model answer against its scanned field.
 * @param {object} raw - Raw answer object from the model.
 * @param {object} field - Matching field from the scan.
 * @returns {{fid: string, value: string, note: string, missing: boolean, confidence: string}}
 */
function normalizeAnswer(raw, field) {
  let value = raw.value == null ? '' : String(raw.value);
  let note = raw.note == null ? '' : String(raw.note);
  let missing = Boolean(raw.missing);
  const conf = String(raw.confidence ?? '').toLowerCase();
  const confidence = CONFIDENCE_LEVELS.includes(conf) ? conf : 'medium';

  if (value.includes('[MISSING')) missing = true;

  const kind = field.kind;
  const options = Array.isArray(field.options) ? field.options : [];
  if (!missing && (kind === 'select' || kind === 'radio') && options.length > 0) {
    const match = matchOption(value, options);
    if (match) {
      // Canonicalize to the option's visible text (what content.js matches on).
      value = String(match.text ?? match.value ?? value);
    } else {
      missing = true;
      note = note
        ? `${note} (value did not match any option verbatim)`
        : `Model value "${value}" did not match any option verbatim — pick one manually.`;
    }
  }

  return { fid: String(field.fid), value, note, missing, confidence };
}

/**
 * Parse and validate the model's raw text into Answer objects.
 *
 * Strips code fences, extracts the outermost JSON object, JSON.parses it,
 * drops answers whose fid is not in `fields` (or duplicated), verifies
 * select/radio values against options (else missing:true), coerces types,
 * and flags any "[MISSING" value as missing. Never throws.
 *
 * @param {string} rawText - Raw text content from the Anthropic response.
 * @param {object[]} fields - The scanned fields sent in the user prompt.
 * @returns {{answers: Array<{fid: string, value: string, note: string, missing: boolean, confidence: string}>, error?: string}}
 */
export function parseAnswers(rawText, fields) {
  try {
    const byFid = new Map();
    for (const f of Array.isArray(fields) ? fields : []) {
      if (f && f.fid != null) byFid.set(String(f.fid), f);
    }

    const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
    const jsonText = sliceJsonObject(stripCodeFences(text));
    if (!jsonText) {
      return { answers: [], error: 'No JSON object found in the model response.' };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return { answers: [], error: 'Model response was not valid JSON: ' + e.message };
    }

    const rawAnswers = parsed && Array.isArray(parsed.answers) ? parsed.answers : null;
    if (!rawAnswers) {
      return { answers: [], error: 'Model response JSON has no "answers" array.' };
    }

    const answers = [];
    const seen = new Set();
    for (const raw of rawAnswers) {
      if (!raw || typeof raw !== 'object') continue;
      const fid = String(raw.fid ?? '');
      const field = byFid.get(fid);
      if (!field || seen.has(fid)) continue; // unknown or duplicate fid — drop
      seen.add(fid);
      answers.push(normalizeAnswer(raw, field));
    }
    return { answers };
  } catch (err) {
    return { answers: [], error: 'Failed to parse answers: ' + (err && err.message ? err.message : String(err)) };
  }
}
