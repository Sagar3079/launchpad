"use strict";

/**
 * LaunchPad answer engine (Agent E).
 *
 * generateAnswers(profile, program, apiKey) -> { mode, answers }
 *   answers: one { label, value, note } per program.formFields, in order.
 *
 * Two modes:
 *   - "ai":       one Anthropic Messages API call writes truthful, tailored answers.
 *   - "template": deterministic assembly from profile strings. Used when there is
 *                 no apiKey, or when the AI call fails (reason is attached to the
 *                 first answer's note).
 *
 * Hard rule (enforced in both modes): never fabricate facts. Any required fact not
 * present in the profile becomes "[MISSING: ask user]".
 */

// OpenCode Zen — OpenAI-compatible gateway serving Claude models.
const API_URL = "https://opencode.ai/zen/v1/chat/completions";
// Overridable via env so we can switch models without code edits.
const MODEL = process.env.OPENCODE_MODEL || "deepseek-v4-flash-free";
// Free Zen models are reasoning models: they spend tokens on hidden reasoning
// before emitting content, so the budget must cover reasoning + the JSON output.
const MAX_TOKENS = 8000;
const MISSING = "[MISSING: ask user]";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

function str(v) {
  return isEmpty(v) ? "" : String(v).trim();
}

/** Resolve a dotted path (e.g. "basic.startupName") against an object. */
function getPath(obj, path) {
  return String(path)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------------------------------------------------------------------------
// In-memory cache (keyed on program id + profile), capped at 20 entries.
// ---------------------------------------------------------------------------

const CACHE = new Map();
const CACHE_CAP = 20;

function cacheGet(key) {
  return CACHE.get(key);
}

function cacheSet(key, value) {
  if (CACHE.has(key)) CACHE.delete(key);
  CACHE.set(key, value);
  while (CACHE.size > CACHE_CAP) {
    CACHE.delete(CACHE.keys().next().value);
  }
}

// ---------------------------------------------------------------------------
// Template mode
// ---------------------------------------------------------------------------

/** Compose a deterministic answer for a "generated" field from profile strings. */
function composeGenerated(profile, field) {
  const basic = (profile && profile.basic) || {};
  const ext = (profile && profile.extended) || {};

  const core = str(ext.pitch) || str(basic.description);
  const hint = str(field.hint);

  if (!core) {
    return {
      value: MISSING,
      note: `Add extended.pitch or basic.description so "${str(field.label)}" can be auto-composed${hint ? ` (reviewer looks for: ${hint})` : ""}.`,
    };
  }

  const parts = [core];

  const context = [];
  if (str(ext.industry)) context.push(`in ${str(ext.industry)}`);
  if (str(ext.stage)) context.push(`at the ${str(ext.stage)} stage`);
  if (context.length) {
    const subject = str(basic.startupName) || "The company";
    parts.push(`${subject} is operating ${context.join(" ")}.`);
  }

  if (str(ext.techStack)) parts.push(`Built on ${str(ext.techStack)}.`);
  if (str(ext.teamSize)) parts.push(`Team size: ${str(ext.teamSize)}.`);

  const note = hint
    ? `Template-composed from your profile; reviewer looks for: ${hint}.`
    : "Template-composed from your pitch/description and profile details.";

  return { value: parts.join(" ").replace(/\s+/g, " ").trim(), note };
}

/** Build a single template answer for one form field. */
function answerForField(profile, field) {
  const label = str(field.label);

  if (field.profileKey === "generated") {
    return { label, ...composeGenerated(profile, field) };
  }

  if (field.profileKey) {
    const value = getPath(profile, field.profileKey);
    if (isEmpty(value)) {
      return {
        label,
        value: MISSING,
        note: `Fill in profile field "${field.profileKey}".`,
      };
    }
    return { label, value: String(value).trim(), note: "" };
  }

  // No profileKey and not "generated" — nothing to map from.
  return {
    label,
    value: MISSING,
    note: `No profileKey mapping for "${label}"; provide a value.`,
  };
}

/**
 * Build all template answers. If failureNote is provided (AI fallback), it is
 * attached to the first answer's note.
 */
function templateAnswers(profile, fields, failureNote) {
  const answers = fields.map((field) => answerForField(profile, field));
  if (failureNote && answers.length) {
    const first = answers[0];
    first.note = first.note ? `${failureNote} ${first.note}` : failureNote;
  }
  return answers;
}

// ---------------------------------------------------------------------------
// AI mode
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are an expert startup-program application writer.",
  "You are given an applicant's REAL profile data and one specific benefits program.",
  "For each form field, write the strongest TRUTHFUL answer, tailored to this program —",
  "use its name, benefits, eligibility, approval tips, and each field's hint as context.",
  "",
  "ABSOLUTE RULE: never invent facts. Do not fabricate revenue, funding, customers,",
  "team size, incorporation status, or any metric. If a fact needed for a field is not",
  'present in the profile, write "[MISSING: ask user]" for that portion of the answer.',
  "",
  "Match each field's expected length: short text fields get short answers; textareas get",
  "2-4 tight, specific sentences. Use a clear, specific, confident tone. No buzzword soup.",
  "",
  "Return STRICT JSON only: an array of objects {\"label\",\"value\",\"note\"} in the exact",
  'same order and count as the form fields provided. "note" is a one-line reviewer-facing',
  "rationale or tip (may be \"\"). Output only the JSON array — no prose, no markdown fences.",
].join("\n");

function buildUserPrompt(profile, program, fields) {
  const context = {
    program: {
      name: program && program.name,
      provider: program && program.provider,
      benefitSummary: program && program.benefitSummary,
      benefits: program && program.benefits,
      eligibility: program && program.eligibility,
      approvalTips: program && program.approvalTips,
    },
    profile,
    formFields: fields.map((f, i) => ({
      index: i,
      label: f.label,
      type: f.type || "text",
      hint: f.hint || "",
    })),
  };

  return [
    "APPLICANT PROFILE and PROGRAM CONTEXT (JSON):",
    JSON.stringify(context, null, 2),
    "",
    `Write exactly one answer object per form field, in order (${fields.length} total).`,
    "Return only the JSON array.",
  ].join("\n");
}

/** Parse and validate the model's response text into answers. Throws on mismatch. */
function parseAiJson(text, fields) {
  let s = String(text).trim();

  // Strip a markdown code fence if present (anchored or inline).
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  const parsed = JSON.parse(s); // may throw — caught by caller

  if (!Array.isArray(parsed)) {
    throw new Error("model did not return a JSON array");
  }
  if (parsed.length !== fields.length) {
    throw new Error(
      `expected ${fields.length} answers, got ${parsed.length}`
    );
  }

  return parsed.map((item, i) => {
    const value = item && item.value;
    if (typeof value !== "string") {
      throw new Error(`answer ${i} has a non-string value`);
    }
    const label =
      item && typeof item.label === "string" && item.label
        ? item.label
        : str(fields[i].label);
    const note = item && typeof item.note === "string" ? item.note : "";
    return { label, value, note };
  });
}

/** Make the single Anthropic API call and return validated answers. Throws on any failure. */
async function aiAnswers(profile, program, fields, apiKey) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(profile, program, fields) },
      ],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 160);
    } catch (_) {
      /* ignore */
    }
    throw new Error(`OpenCode Zen API ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  const data = await res.json();
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || "")
      : "";

  if (!text) throw new Error("empty response from model");

  return parseAiJson(text, fields);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function generateAnswers(profile, program, apiKey) {
  const fields =
    program && Array.isArray(program.formFields) ? program.formFields : [];

  // No fields to answer — nothing to do (and no reason to call the API).
  if (fields.length === 0) {
    return { mode: "template", answers: [] };
  }

  // No key -> deterministic template mode.
  if (isEmpty(apiKey)) {
    return { mode: "template", answers: templateAnswers(profile, fields) };
  }

  // AI mode, with caching to avoid re-billing identical requests.
  const cacheKey = JSON.stringify({
    programId: program && program.id,
    profile,
  });
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const answers = await aiAnswers(profile, program, fields, apiKey);
    const result = { mode: "ai", answers };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    const reason = `AI generation failed (${err && err.message ? err.message : err}); used template fallback.`;
    return {
      mode: "template",
      answers: templateAnswers(profile, fields, reason),
    };
  }
}

module.exports = { generateAnswers };
