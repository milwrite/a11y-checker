const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { URL } = require("url");

const MAX_PAGES = parseInt(process.env.MAX_PAGES, 10) || 50;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 812 },
];

const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "best-practice",
];

class Auditor {
  constructor(emit, { baseUrl, seedPaths = ["/"], maxPages } = {}) {
    this.emit = emit;
    this.baseUrl = baseUrl;
    this.seedPaths = seedPaths;
    this.maxPages = maxPages || MAX_PAGES;
    this.visited = new Set();
    this.queue = [];
    this.allViolations = [];
  }

  async run() {
    this.emit("status", { message: `Launching browser for ${this.baseUrl}...` });

    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext();

    // Discover pages from sitemap.xml and robots.txt before crawling
    await this.discoverFromSitemap(context);

    // Seed the queue
    for (const p of this.seedPaths) {
      const url = new URL(p, this.baseUrl).href;
      if (!this.visited.has(url)) {
        this.queue.push(url);
        this.visited.add(url);
      }
    }

    let pageIndex = 0;

    while (this.queue.length > 0 && pageIndex < this.maxPages) {
      const url = this.queue.shift();
      pageIndex++;

      this.emit("page-start", {
        url,
        pageIndex,
        totalQueued: this.queue.length + pageIndex,
      });

      for (const vp of VIEWPORTS) {
        try {
          await this.auditPage(context, url, vp, pageIndex);
        } catch (err) {
          this.emit("page-error", {
            url,
            viewport: vp.name,
            error: err.message,
          });
        }
      }

      // Discover links from the page (desktop viewport only)
      if (this.visited.size < this.maxPages) {
        try {
          await this.discoverLinks(context, url);
        } catch (_) {
          // ignore discovery errors
        }
      }

      this.emit("page-done", { url, pageIndex });
    }

    await browser.close();

    this.emit("complete", {
      totalPages: pageIndex,
      totalViolations: this.allViolations.length,
      violations: this.allViolations,
    });
  }

  async auditPage(context, url, viewport, pageIndex) {
    const page = await context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Wait a bit for JS rendering
      await page.waitForTimeout(1500);

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();

      for (const v of results.violations) {
        for (const node of v.nodes) {
          const violation = {
            url,
            viewport: viewport.name,
            pageIndex,
            ruleId: v.id,
            impact: v.impact,
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            wcagTags: v.tags.filter((t) => t.startsWith("wcag") || t === "best-practice"),
            target: node.target.join(", "),
            html: (node.html || "").slice(0, 200),
          };
          this.allViolations.push(violation);
          this.emit("violation", violation);
        }
      }

      this.emit("page-audit", {
        url,
        viewport: viewport.name,
        violationCount: results.violations.reduce((s, v) => s + v.nodes.length, 0),
        passCount: results.passes.length,
      });
    } finally {
      await page.close();
    }
  }

  async discoverLinks(context, url) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const hrefs = await page.$$eval("a[href]", (anchors) =>
        anchors.map((a) => a.href)
      );

      // Also grab nav links, footer links, and aria-labeled sections
      const navHrefs = await page.$$eval(
        "nav a[href], footer a[href], [role='navigation'] a[href]",
        (anchors) => anchors.map((a) => a.href)
      );

      const allHrefs = [...new Set([...hrefs, ...navHrefs])];
      const baseHost = new URL(this.baseUrl).host;
      for (const href of allHrefs) {
        try {
          const parsed = new URL(href);
          if (
            parsed.host === baseHost &&
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            !parsed.hash
          ) {
            const clean = parsed.origin + parsed.pathname.replace(/\/$/, "");
            const cleanSlash = clean + "/";
            if (
              !this.visited.has(clean) &&
              !this.visited.has(cleanSlash) &&
              this.visited.size < this.maxPages
            ) {
              this.visited.add(clean);
              this.queue.push(clean);
            }
          }
        } catch (_) {}
      }
    } finally {
      await page.close();
    }
  }

  async discoverFromSitemap(context) {
    const baseOrigin = new URL(this.baseUrl).origin;
    const sitemapUrls = new Set();

    // Try robots.txt first to find sitemap locations
    try {
      const page = await context.newPage();
      try {
        await page.goto(`${baseOrigin}/robots.txt`, {
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });
        const text = await page.textContent("body");
        const lines = text.split("\n");
        for (const line of lines) {
          const match = line.match(/^sitemap:\s*(.+)/i);
          if (match) sitemapUrls.add(match[1].trim());
        }
      } finally {
        await page.close();
      }
    } catch (_) {}

    // Always try the default sitemap location
    sitemapUrls.add(`${baseOrigin}/sitemap.xml`);

    const baseHost = new URL(this.baseUrl).host;
    let discovered = 0;

    for (const sitemapUrl of sitemapUrls) {
      if (discovered >= this.maxPages) break;
      try {
        const page = await context.newPage();
        try {
          await page.goto(sitemapUrl, {
            waitUntil: "domcontentloaded",
            timeout: 10000,
          });
          const locs = await page.$$eval("loc", (els) =>
            els.map((el) => el.textContent.trim())
          );
          for (const loc of locs) {
            try {
              const parsed = new URL(loc);
              if (parsed.host === baseHost) {
                const clean = parsed.origin + parsed.pathname.replace(/\/$/, "");
                if (!this.visited.has(clean) && this.visited.size < this.maxPages) {
                  this.visited.add(clean);
                  this.queue.push(clean);
                  discovered++;
                }
              }
            } catch (_) {}
          }
        } finally {
          await page.close();
        }
      } catch (_) {}
    }

    if (discovered > 0) {
      this.emit("status", {
        message: `Discovered ${discovered} pages from sitemap`,
      });
    }
  }
}

module.exports = { Auditor };
