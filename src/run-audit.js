const fs = require("fs");
const path = require("path");
const { Auditor } = require("./auditor");
const { researcher } = require("./researcher");

const rawUrls = process.argv[2];
if (!rawUrls) {
  console.error("Usage: node src/run-audit.js <url>[,url2,url3...]");
  process.exit(1);
}
const allUrls = rawUrls.split(",").map((u) => u.trim()).filter(Boolean);
const url = allUrls[0];
const seedPaths = allUrls.slice(1);

const outDir = process.argv[3] || path.join(__dirname, "..", "docs", "results");
fs.mkdirSync(outDir, { recursive: true });

const auditor = new Auditor((event, data) => {
  if (event === "page-start") {
    console.log(`[${data.pageIndex}] ${data.url}`);
  } else if (event === "violation") {
    const icon =
      data.impact === "critical" ? "!!" :
      data.impact === "serious" ? "!" : "-";
    console.log(`  ${icon} ${data.impact}: ${data.ruleId} (${data.viewport})`);
  } else if (event === "status") {
    console.log(data.message);
  } else if (event === "complete") {
    console.log(`\nDone. ${data.totalPages} pages, ${data.totalViolations} violations.`);

    const hasResearchKey =
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

    const finish = (deepResearch) => {
      const report = {
        url,
        timestamp: new Date().toISOString(),
        totalPages: data.totalPages,
        totalViolations: data.totalViolations,
        violations: data.violations,
        deepResearch,
      };

      const reportPath = path.join(outDir, "report.json");
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`Report written to ${reportPath}`);

      const indexPath = path.join(outDir, "index.json");
      let index = [];
      if (fs.existsSync(indexPath)) {
        try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch (_) {}
      }
      index.unshift({
        url,
        timestamp: report.timestamp,
        totalPages: report.totalPages,
        totalViolations: report.totalViolations,
        hasDeepResearch: deepResearch.length > 0,
        file: `report-${Date.now()}.json`,
      });
      index = index.slice(0, 20);

      fs.copyFileSync(reportPath, path.join(outDir, index[0].file));
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      console.log(`Index updated: ${index.length} reports`);
    };

    if (hasResearchKey) {
      researcher(data.violations, {
        siteUrl: url,
        emit: (ev, d) => {
          if (ev === "status") console.log("[research]", d.message);
        },
      })
        .then((deepResearch) => {
          console.log(
            `Research complete: ${deepResearch.length} rule group(s) analyzed.`
          );
          finish(deepResearch);
        })
        .catch((err) => {
          console.warn("Deep research failed:", err.message);
          finish([]);
        });
    } else {
      console.log(
        "Deep research skipped (set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable)."
      );
      finish([]);
    }
  }
}, { baseUrl: url, seedPaths });

auditor.run().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
