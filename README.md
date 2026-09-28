# Google News Scraper (Node.js): search articles by keyword as JSON

Scrape Google News search results into structured JSON: headline, publisher name, publisher website, publish date as ISO 8601 and as a timestamp, the Google News article link and its id, and related coverage from other outlets when Google groups a story. Search any keyword or phrase with Google's own operators (`"exact phrase"`, `-exclude`, `site:reuters.com`), limit it to the last hour, day, week, month or year, or to a date range, and go past Google's 100-result cap by walking back one day at a time.

The scraper reads the Google News RSS search feed (US English edition) through a public [Unbrowse](https://unbrowse.ai) tool. The request is sent from your machine and the feed is parsed locally, so no browser, no HTML scraping and no page-layout breakage: the feed format has been stable for years.

## Quick start

```bash
git clone https://github.com/unbrowse-ai/google-news-scraper && cd google-news-scraper && npm install
export UNBROWSE_API_KEY=ub_live_...        # free key: https://unbrowse.ai

node index.mjs "nvidia" > nvidia.json
node index.mjs "climate change" --when 7d --max 300 > climate-week.json
node index.mjs "site:reuters.com tariffs" --from 2026-09-01 --to 2026-09-15 > reuters.json
```

| Option | Default | Meaning |
|---|---|---|
| `<query>...` | | Keyword or phrase, with Google News operators if you like |
| `--max N` | 100 | Articles per query. Above 100, the search repeats one day at a time, newest first |
| `--when` | | `1h`, `1d`, `7d`, `30d` or `1y` |
| `--from`, `--to` | | Date range, `YYYY-MM-DD` (wins over `--when`) |

From code:

```js
import { scrape } from "./index.mjs";
const articles = await scrape("openai", { timeframe: "1d", max: 50 });
```

## Output

```json
{
  "id": "CBMi2AFBVV95cUxPX0pM...",
  "title": "China weighs allowing ByteDance, Alibaba to buy new Nvidia chips, The Information reports",
  "source": "Reuters",
  "sourceUrl": "https://www.reuters.com",
  "googleNewsUrl": "https://news.google.com/rss/articles/CBMi2AFBVV95cUxPX0pM...?oc=5",
  "publishedAt": "2026-09-27T15:24:00.000Z",
  "publishedTimestamp": 1790522640000,
  "relatedArticles": [],
  "searchQuery": "nvidia"
}
```

## Fields

| Field | Notes |
|---|---|
| `id` | Google News article id (stable; use it to deduplicate between runs) |
| `title` | Headline, with the " - Publisher" suffix removed |
| `source`, `sourceUrl` | Publisher name and homepage |
| `googleNewsUrl` | The Google News link; it redirects to the publisher's article |
| `publishedAt`, `publishedTimestamp` | ISO 8601 and milliseconds |
| `relatedArticles[]` | `{ title, source, googleNewsUrl, id }` for grouped stories |
| `searchQuery`, `scrapedAt` | Context |

## FAQ

**Why only 100 per search?** Google News caps each feed at about 100 items. With `--max` above 100 the scraper runs the same search for each day in the window (`after:` / `before:` operators) and merges the results without duplicates.

**Other countries and languages?** The public tool is fixed to the US English edition for now. Queries in any language work, but ranking follows the US edition.

**Why a key?** The feed is fetched through Unbrowse's public Google News tool, which tells your machine which request to send. The key is free; the request leaves from your IP. If Google shows your IP a bot check, the scraper stops without reporting it.

---

Part of [open-scrapers](https://github.com/unbrowse-ai/open-scrapers): more scrapers and a catalog of 2,400+ websites callable as APIs or MCP servers.
