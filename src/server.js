const http = require("http");
const fs = require("fs");
const path = require("path");
const { Auditor } = require("./auditor");
const { researcher } = require("./researcher");

loadEnvFile(path.join(__dirname, "..", ".env"));

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7";
const docsDir = path.join(__dirname, "..", "docs");
const clients = new Set();
let finalReport = null;
let targetUrl = null;
let targetMaxPages = null;
let auditing = false;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function loadEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (_) {
    // .env is optional in production
  }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

function clampMaxPages(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(200, Math.max(1, parsed));
}

function summarizeReport(report) {
  const pageSummaries = new Map();
  const ruleSummaries = new Map();
  const severityTotals = { critical: 0, serious: 0, moderate: 0, minor: 0 };

  for (const violation of report.violations || []) {
    const pageKey = violation.url || "unknown";
    if (!pageSummaries.has(pageKey)) {
      pageSummaries.set(pageKey, {
        url: pageKey,
        count: 0,
        rules: new Set(),
        impacts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      });
    }

    const page = pageSummaries.get(pageKey);
    page.count += 1;
    page.rules.add(violation.ruleId);
    if (severityTotals[violation.impact] !== undefined) {
      severityTotals[violation.impact] += 1;
      page.impacts[violation.impact] += 1;
    }

    const ruleKey = violation.ruleId || "unknown";
    if (!ruleSummaries.has(ruleKey)) {
      ruleSummaries.set(ruleKey, {
        ruleId: ruleKey,
        impact: violation.impact || "unknown",
        help: violation.help || "",
        helpUrl: violation.helpUrl || "",
        wcagTags: violation.wcagTags || [],
        count: 0,
        pages: new Set(),
        targets: new Set(),
      });
    }

    const rule = ruleSummaries.get(ruleKey);
    rule.count += 1;
    if (violation.url) rule.pages.add(violation.url);
    if (violation.target && rule.targets.size < 8) {
      rule.targets.add(violation.target);
    }
  }

  const topRules = Array.from(ruleSummaries.values())
    .sort((a, b) =>
      severityRank(a.impact) - severityRank(b.impact) ||
      b.count - a.count ||
      a.ruleId.localeCompare(b.ruleId)
    )
    .slice(0, 12)
    .map((rule) => ({
      ruleId: rule.ruleId,
      impact: rule.impact,
      help: rule.help,
      helpUrl: rule.helpUrl,
      wcagTags: rule.wcagTags,
      count: rule.count,
      pageCount: rule.pages.size,
      sampleTargets: Array.from(rule.targets),
    }));

  const topPages = Array.from(pageSummaries.values())
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .slice(0, 10)
    .map((page) => ({
      url: page.url,
      count: page.count,
      uniqueRules: page.rules.size,
      impacts: page.impacts,
    }));

  return {
    totalPages: report.totalPages || 0,
    totalViolations: report.totalViolations || 0,
    severityTotals,
    topRules,
    topPages,
  };
}

function severityRank(impact) {
  const ranks = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return ranks[impact] ?? 4;
}

async function analyzeReportWithOpenRouter(report) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const compactReport = summarizeReport(report);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    signal: controller.signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://github.com/milwrite/a11y-checker",
      "X-Title": "a11y-checker",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are an accessibility remediation analyst.",
            "Write for a nontechnical site owner.",
            "Use plain language and prioritize fixes with the biggest user impact.",
            "Ground every recommendation in the provided audit summary.",
            "Avoid mentioning JSON or internal implementation details.",
            "Output markdown with these sections exactly:",
            "## Executive summary",
            "## What to fix first",
            "## Team checklist",
            "## Patterns found across pages",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            "Analyze this accessibility audit summary and explain what the site team should fix.",
            "For each recommendation, describe the user impact, the common cause, and a concrete remediation step.",
            "If the same pattern appears on multiple pages, call it out as a template-level problem.",
            "Keep it concise but specific.",
            "",
            JSON.stringify(compactReport, null, 2),
          ].join("\n"),
        },
      ],
    }),
  });

  clearTimeout(timeout);
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.error?.message || `OpenRouter request failed with ${response.status}`;
    throw new Error(message);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenRouter returned an empty analysis");
  }

  return {
    model: payload.model || OPENROUTER_MODEL,
    analysis: content,
    summary: compactReport,
  };
}

function runAudit(baseUrl, maxPages, seedPaths = []) {
  targetUrl = baseUrl;
  targetMaxPages = maxPages;
  auditing = true;
  finalReport = null;

  console.log(`\nTarget: ${baseUrl}`);
  if (seedPaths.length > 0) console.log(`Seed URLs: ${seedPaths.join(", ")}`);
  if (maxPages) console.log(`Max pages: ${maxPages}`);
  console.log("Starting audit...\n");

  const auditor = new Auditor((event, data) => {
    broadcast(event, data);

    if (event === "page-start") {
      console.log(`[${data.pageIndex}] Auditing: ${data.url}`);
    } else if (event === "violation") {
      const icon =
        data.impact === "critical" ? "!!" :
        data.impact === "serious" ? "!" : "-";
      console.log(`  ${icon} ${data.impact}: ${data.ruleId} (${data.viewport})`);
    } else if (event === "page-error") {
      console.log(`  ERROR: ${data.error} (${data.viewport})`);
    } else if (event === "complete") {
      console.log(`\nDone. ${data.totalPages} pages, ${data.totalViolations} violations.`);
      finalReport = data;
      auditing = false;
    }
  }, { baseUrl, seedPaths, maxPages });

  auditor.run().catch((err) => {
    console.error("Audit failed:", err);
    broadcast("error", { message: err.message });
    auditing = false;
  });
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.url === "/audit" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { url, urls, maxPages } = JSON.parse(body);
        const normalizedMaxPages = clampMaxPages(maxPages);
        // Accept a single url or a comma/array of urls
        const allUrls = urls && urls.length > 0
          ? urls
          : url
            ? url.split(",").map((u) => u.trim()).filter(Boolean)
            : [];
        if (allUrls.length === 0) throw new Error("Missing url");
        const baseUrl = allUrls[0];
        const seedPaths = allUrls.slice(1);
        if (auditing) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Audit already in progress" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, url: baseUrl, urls: allUrls, maxPages: normalizedMaxPages }));
        runAudit(baseUrl, normalizedMaxPages, seedPaths);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: targetUrl, maxPages: targetMaxPages, auditing }));
    return;
  }

  if (req.url === "/report.json" && finalReport) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(finalReport, null, 2));
    return;
  }

  if (req.url === "/analyze" && req.method === "POST") {
    if (!finalReport) {
      res.writeHead(409, corsHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ error: "No completed audit available yet" }));
      return;
    }

    const researchPromise = OPENROUTER_API_KEY
      ? researcher(finalReport.violations, {
          siteUrl: targetUrl,
          emit: (ev, d) => {
            if (ev === "status") console.log("[research]", d.message);
          },
        }).catch((err) => {
          console.warn("Deep research failed:", err.message);
          return [];
        })
      : Promise.resolve([]);

    Promise.all([
      analyzeReportWithOpenRouter(finalReport).catch((err) => ({
        error: err.message,
      })),
      researchPromise,
    ]).then(([narrative, deepResearch]) => {
      res.writeHead(200, corsHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ ...narrative, deepResearch }));
    });
    return;
  }

  if (req.url === "/report.csv" && finalReport) {
    res.writeHead(200, { "Content-Type": "text/csv" });
    const header = "url,viewport,impact,ruleId,help,target,wcagTags,helpUrl,wcagUrls\n";
    const rows = finalReport.violations.map((v) =>
      [v.url, v.viewport, v.impact, v.ruleId, `"${(v.help || "").replace(/"/g, '""')}"`, `"${(v.target || "").replace(/"/g, '""')}"`, `"${(v.wcagTags || []).join("; ")}"`, v.helpUrl || "", `"${(v.wcagUrls || []).join("; ")}"`].join(",")
    ).join("\n");
    res.end(header + rows);
    return;
  }

  if (req.url === "/favicon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(fs.readFileSync(path.join(docsDir, "favicon.svg")));
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(docsDir, "index.html")));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, auditing }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`a11y-checker listening on port ${PORT}`);
});
