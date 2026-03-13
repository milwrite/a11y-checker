# a11y-checker

An automated accessibility auditor that checks web pages against WCAG 2.1 AA standards. Runs entirely on GitHub Actions — no local setup required.

## What it does

- **Checks any website for accessibility issues** — enter a URL and the tool crawls up to 50 pages, flagging problems that affect screen readers, keyboard navigation, color contrast, missing alt text, form labels, and more
- **Tests at both desktop and mobile sizes** — every page is audited at 1280x800 and 375x812 viewports, catching responsive layout issues that only appear on smaller screens
- **Discovers pages automatically** — parses sitemap.xml, reads robots.txt, and follows links through navigation, footers, and page content so you don't have to list every URL by hand
- **Reports against WCAG 2.1 Level AA** — the standard required by most institutional, government, and educational web policies, powered by axe-core
- **Exports results as JSON or CSV** — for sharing with developers, filing tickets, or tracking progress over time

## How to run an audit

1. Go to the [dashboard](https://zmuhls.github.io/a11y-checker/) and enter a URL
2. Submit the pre-filled GitHub issue that opens
3. The audit runs automatically via GitHub Actions
4. Results appear on the dashboard and get posted back to the issue

You can also trigger audits from the [Actions tab](https://github.com/zmuhls/a11y-checker/actions/workflows/audit.yml) directly.

## Local usage

```bash
npm install
npx playwright install chromium
node run-audit.js https://example.com
```

Or with a live streaming dashboard:

```bash
node server.js https://example.com
# open http://localhost:3000
```

## License

MIT
