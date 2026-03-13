const fs = require("fs");
const path = require("path");
const { Auditor } = require("./auditor");

const url = process.argv[2];
if (!url) {
  console.error("Usage: node run-audit.js <url>");
  process.exit(1);
}

const outDir = process.argv[3] || path.join(__dirname, "docs", "results");
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

    const report = {
      url,
      timestamp: new Date().toISOString(),
      totalPages: data.totalPages,
      totalViolations: data.totalViolations,
      violations: data.violations,
    };

    const reportPath = path.join(outDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${reportPath}`);

    // Write index of all reports
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
      file: `report-${Date.now()}.json`,
    });
    // Keep last 20 reports
    index = index.slice(0, 20);

    // Copy report with timestamped name
    fs.copyFileSync(reportPath, path.join(outDir, index[0].file));
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log(`Index updated: ${index.length} reports`);
  }
}, { baseUrl: url });

auditor.run().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
