const http = require("http");
const fs = require("fs");
const path = require("path");
const { Auditor } = require("./auditor");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const clients = new Set();
let finalReport = null;
let targetUrl = null;
let auditing = false;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

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

const server = http.createServer((req, res) => {
  cors(res);

  // Handle preflight
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

  if (req.url === "/report.json" && finalReport) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(finalReport, null, 2));
    return;
  }

  if (req.url === "/report.csv" && finalReport) {
    res.writeHead(200, { "Content-Type": "text/csv" });
    const header = "url,viewport,impact,ruleId,help,target,wcagTags,helpUrl\n";
    const rows = finalReport.violations.map((v) =>
      [v.url, v.viewport, v.impact, v.ruleId, `"${(v.help || "").replace(/"/g, '""')}"`, `"${(v.target || "").replace(/"/g, '""')}"`, `"${(v.wcagTags || []).join("; ")}"`, v.helpUrl || ""].join(",")
    ).join("\n");
    res.end(header + rows);
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "docs", "index.html")));
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
