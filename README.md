# a11y-checker

WCAG 2.1 AA accessibility auditor powered by GitHub Actions. Trigger an audit from the Actions tab, view results on the dashboard.

**Dashboard:** [zmuhls.github.io/a11y-checker](https://zmuhls.github.io/a11y-checker/)

## How it works

1. Go to [Actions > Run Accessibility Audit](https://github.com/zmuhls/a11y-checker/actions/workflows/audit.yml)
2. Click **Run workflow**
3. Enter the URL to audit (and optionally a page limit)
4. The workflow crawls the site, runs axe-core against every page, and publishes results to GitHub Pages
5. View violations on the dashboard with severity/viewport filters and JSON/CSV export

## What it tests

- Crawls pages via sitemap.xml, robots.txt, and link discovery
- Tests every page at desktop (1280x800) and mobile (375x812) viewports
- Checks against WCAG 2.1 Level AA plus best practices
- Default limit: 50 pages per audit

## Local usage

You can also run audits locally:

```bash
npm install
npx playwright install chromium
node run-audit.js https://example.com
```

Or use the local dev server with live streaming:

```bash
node server.js https://example.com
# open http://localhost:3000
```

## License

MIT
