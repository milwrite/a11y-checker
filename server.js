const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Auditor } = require("./auditor");

const PORT = process.env.PORT || 3000;
const clients = new Set();
let finalReport = null;
let targetUrl = null;
let auditing = false;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

function runAudit(baseUrl) {
  targetUrl = baseUrl;
  auditing = true;
  finalReport = null;

  console.log(`\nTarget: ${baseUrl}`);
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
  }, { baseUrl });

  auditor.run().catch((err) => {
    console.error("Audit failed:", err);
    broadcast("error", { message: err.message });
    auditing = false;
  });
}

function startServer(initialUrl) {
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
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
          const { url } = JSON.parse(body);
          if (!url) throw new Error("Missing url");
          if (auditing) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Audit already in progress" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, url }));
          runAudit(url);
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: targetUrl, auditing }));
      return;
    }

    if (req.url === "/target" && targetUrl) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: targetUrl }));
      return;
    }

    if (req.url === "/report.json" && finalReport) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=a11y-report.json",
      });
      res.end(JSON.stringify(finalReport, null, 2));
      return;
    }

    if (req.url === "/report.csv" && finalReport) {
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=a11y-report.csv",
      });
      const header = "url,viewport,impact,ruleId,help,target,wcagTags,helpUrl\n";
      const rows = finalReport.violations.map((v) =>
        [v.url, v.viewport, v.impact, v.ruleId, `"${(v.help || "").replace(/"/g, '""')}"`, `"${(v.target || "").replace(/"/g, '""')}"`, `"${(v.wcagTags || []).join("; ")}"`, v.helpUrl || ""].join(",")
      ).join("\n");
      res.end(header + rows);
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(path.join(__dirname, "index.html")));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`\nDashboard: http://localhost:${PORT}`);
    if (initialUrl) {
      runAudit(initialUrl);
    } else {
      console.log("Waiting for URL input from dashboard...\n");
    }
  });
}

// Accept URL as CLI argument, prompt, or wait for dashboard input
const arg = process.argv[2];
if (arg) {
  startServer(arg);
} else if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Enter URL to audit (or press Enter to use dashboard): ", (answer) => {
    rl.close();
    const url = answer.trim();
    startServer(url || null);
  });
} else {
  startServer(null);
}
