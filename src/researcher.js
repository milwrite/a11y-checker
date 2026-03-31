// src/researcher.js
// Post-audit LLM enrichment: groups violations by rule, samples representative
// HTML, and asks an LLM for plain-language remediation playbooks.
//
// Requires: OPENROUTER_API_KEY
// Optional: OPENROUTER_MODEL (default: openai/gpt-4o-mini)
//           RESEARCH_MODEL   (overrides OPENROUTER_MODEL for this module only)
//
// Usage (from auditor complete event):
//   const { researcher } = require('./researcher');
//   const research = await researcher(violations, { siteUrl, emit });

const { postChatCompletion } = require("./openrouter");

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const MAX_SAMPLES_PER_RULE = 3;
const MAX_HTML_CHARS = 300;
const MAX_RULES_PER_BATCH = 6;

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callLLM(systemPrompt, userPrompt) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Set OPENROUTER_API_KEY to enable deep research.");
  }
  const model =
    process.env.RESEARCH_MODEL ||
    process.env.OPENROUTER_MODEL ||
    DEFAULT_MODEL;
  const resp = await postChatCompletion(
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    {
      apiKey: process.env.OPENROUTER_API_KEY,
    }
  );
  const content = resp?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}

// ─── Grouping + sampling ─────────────────────────────────────────────────────

function groupViolations(violations) {
  const groups = new Map();
  for (const v of violations) {
    if (!groups.has(v.ruleId)) {
      groups.set(v.ruleId, {
        ruleId: v.ruleId,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        wcagTags: v.wcagTags,
        wcagUrls: v.wcagUrls,
        occurrences: 0,
        affectedPages: new Set(),
        samples: [],
      });
    }
    const g = groups.get(v.ruleId);
    g.occurrences++;
    g.affectedPages.add(v.url);
    if (g.samples.length < MAX_SAMPLES_PER_RULE) {
      g.samples.push({
        url: v.url,
        target: v.target,
        html: (v.html || "").slice(0, MAX_HTML_CHARS),
        viewport: v.viewport,
      });
    }
  }

  const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return [...groups.values()]
    .map((g) => ({ ...g, affectedPages: [...g.affectedPages] }))
    .sort(
      (a, b) =>
        (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9) ||
        b.occurrences - a.occurrences
    );
}

// ─── Prompt construction ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert web accessibility consultant specializing in WCAG 2.1/2.2 and practical remediation.
You receive a batch of axe-core violation groups from a site audit. For each rule, return a JSON object with this exact shape:

{
  "ruleId": "<same ruleId>",
  "summary": "<1-2 sentence plain-English explanation of what this violation means for users with disabilities>",
  "remediation": "<concrete fix instructions for a developer, written in imperative voice, 3-6 sentences>",
  "codeExample": "<a short corrected HTML snippet — use the provided sample HTML as a base when possible>",
  "priorityRationale": "<why this should be fixed at this priority level, given the impact rating and page spread>",
  "section508": "<equivalent Section 508 provision if applicable, otherwise null>",
  "effort": "<low|medium|high — estimated fix effort>"
}

Return a top-level JSON object: { "results": [ ...one entry per rule... ] }
Be specific. Avoid vague advice. Use the actual HTML samples provided.`;

function buildUserPrompt(ruleGroups, siteUrl) {
  const rulesText = ruleGroups
    .map((g) => {
      const samplesText = g.samples
        .map(
          (s, i) =>
            `  Sample ${i + 1} [${s.viewport}, ${s.url}]\n    target: ${s.target}\n    html: ${s.html || "(empty)"}`
        )
        .join("\n");

      return [
        `Rule: ${g.ruleId}`,
        `Impact: ${g.impact}`,
        `Occurrences: ${g.occurrences} across ${g.affectedPages.length} page(s)`,
        `Description: ${g.description}`,
        `axe help: ${g.help}`,
        `WCAG tags: ${g.wcagTags.join(", ")}`,
        `HTML samples:\n${samplesText}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return `Site: ${siteUrl}\n\nViolation groups to analyze:\n\n${rulesText}`;
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

async function researchBatch(ruleGroups, siteUrl, emit) {
  emit?.("status", {
    message: `Researching ${ruleGroups.length} violation type(s)...`,
  });

  const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(ruleGroups, siteUrl));

  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    emit?.("status", { message: "Research parse error — skipping batch" });
    return [];
  }

  return parsed.results || [];
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function researcher(violations, { siteUrl = "unknown", emit } = {}) {
  if (!violations || violations.length === 0) return [];

  const groups = groupViolations(violations);
  emit?.("status", {
    message: `Deep research: ${groups.length} distinct violation type(s) found`,
  });

  const batches = [];
  for (let i = 0; i < groups.length; i += MAX_RULES_PER_BATCH) {
    batches.push(groups.slice(i, i + MAX_RULES_PER_BATCH));
  }

  const allResults = [];
  for (const batch of batches) {
    const results = await researchBatch(batch, siteUrl, emit);
    allResults.push(...results);
  }

  const researchByRule = Object.fromEntries(
    allResults.map((r) => [r.ruleId, r])
  );

  return groups.map((g) => ({
    ruleId: g.ruleId,
    impact: g.impact,
    occurrences: g.occurrences,
    affectedPages: g.affectedPages,
    wcagTags: g.wcagTags,
    wcagUrls: g.wcagUrls,
    samples: g.samples,
    research: researchByRule[g.ruleId] || null,
  }));
}

module.exports = { researcher, groupViolations };
