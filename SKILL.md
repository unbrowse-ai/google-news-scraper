---
name: google-news-scraper
description: Search Google News for a keyword and get articles as JSON with headline, publisher, publisher site, publish date and link, filtered to the last hour/day/week or a date range, beyond the 100-result cap. Use when the user asks for recent news or press coverage about a company, person, product or topic, or wants news monitored or exported.
---

# Google News scraper

## When to use
- "Latest news about Nvidia", "press coverage of our launch this week", "Reuters articles on tariffs in September", "export 300 articles about climate change".
- Keyword search only (US English edition). Not for reading article bodies.

## Run
Needs `UNBROWSE_API_KEY` (free at https://unbrowse.ai). From the repo root:

```bash
node index.mjs "nvidia" --when 1d > out.json
node index.mjs "climate change" --when 7d --max 300 > out.json
node index.mjs "site:reuters.com tariffs" --from 2026-09-01 --to 2026-09-15 > out.json
```

Options: `--max N` (default 100; more walks back one day per request), `--when 1h|1d|7d|30d|1y`, `--from YYYY-MM-DD`, `--to YYYY-MM-DD`. Google News operators (`"phrase"`, `-word`, `site:`) go in the query.
Progress goes to stderr, the JSON array to stdout. Exit 1 on error, 2 on zero results.

## Output
Array of articles: `id, title, source, sourceUrl, googleNewsUrl, publishedAt, publishedTimestamp, relatedArticles[], searchQuery, scrapedAt`.

## Notes
- `googleNewsUrl` redirects to the publisher's page; `sourceUrl` is the publisher's homepage.
- `RefusedError` = Google showed this IP a bot check; nothing was reported. Wait and retry.
