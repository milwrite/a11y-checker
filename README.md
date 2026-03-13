# a11y-checker

An automated accessibility auditor that checks web pages against WCAG 2.1 AA standards. Runs entirely in the browser — no install, no server, no configuration.

**Use it now:** [milwrite.github.io/a11y-checker](https://milwrite.github.io/a11y-checker/)

## What it does

- **Checks any website for accessibility issues** — enter a URL and the tool crawls up to 20 pages, flagging problems that affect screen readers, keyboard navigation, color contrast, missing alt text, form labels, and more
- **Discovers pages automatically** — parses sitemap.xml, reads robots.txt, and follows links through navigation and page content so you don't have to list every URL by hand
- **Reports against WCAG 2.1 Level AA** — the standard required by most institutional, government, and educational web policies, powered by axe-core
- **Streams results in real time** — violations appear as they're found, with severity filters and links to documentation for each issue
- **Exports results as JSON or CSV** — for sharing with developers, filing tickets, or tracking progress over time

## How it works

1. Go to [milwrite.github.io/a11y-checker](https://milwrite.github.io/a11y-checker/)
2. Enter a URL
3. Results stream in as pages are crawled and audited

Everything runs client-side using [axe-core](https://github.com/dequelabs/axe-core) in the browser. Pages are fetched via a CORS proxy, rendered in a sandboxed iframe, and analyzed against WCAG 2.1 AA rules.

## Local usage

You can also run audits locally with the full Playwright-based crawler:

```bash
npm install
npx playwright install chromium
node run-audit.js https://example.com
```

## License

MIT
