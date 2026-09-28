#!/usr/bin/env node
// Google News Scraper: search Google News for a keyword and get articles as structured JSON.
// Searches go through the public Unbrowse tool for the Google News RSS search feed, sent from this machine.
import { fileURLToPath } from "node:url";
import { cli, readPage } from "./lib/read-page.mjs";
import { dayWindows, parseRss, searchText } from "./parse.mjs";

const CAPABILITY = "public.news_google_com.get_rss_search";
const HOSTS = ["news.google.com"];
const FEED_CAP = 100; // Google returns at most ~100 items per search feed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Google's "unusual traffic" page is HTML, never a feed.
const refused = (page) => (page.status === 200 && !/<rss[\s>]/.test(page.body.slice(0, 2000)) ? "not an RSS feed (bot check?)" : false);

async function feed(text) {
  const page = await readPage(CAPABILITY, { query: text }, { hosts: HOSTS, refused, minBytes: 200 });
  const r = parseRss(page.body);
  if (!r) throw new Error(`Google News did not return a feed for "${text}"`);
  return r.items;
}

/**
 * Search Google News (US English edition). Options: max (default 100), timeframe (1h|1d|7d|30d|1y),
 * dateFrom / dateTo (YYYY-MM-DD). Past 100 results the search is repeated one day at a time.
 */
export async function scrape(query, { max = 100, timeframe, dateFrom, dateTo, log = () => {} } = {}) {
  const limit = Math.max(1, Number(max) || 100);
  const seen = new Set();
  const out = [];
  const now = new Date().toISOString();
  const take = (items) => {
    for (const it of items) {
      if (out.length >= limit || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ ...it, searchQuery: query, scrapedAt: now });
    }
  };
  const first = await feed(searchText(query, { timeframe, dateFrom, dateTo }));
  take(first);
  log(`"${query}": ${first.length} in the first feed`);
  if (out.length < limit && first.length >= FEED_CAP * 0.9) {
    // Walk back one day per call: each day gets its own 100-item feed.
    const days = { "1h": 1, "1d": 1, "7d": 7, "30d": 30, "1y": 365 }[timeframe] ?? 30;
    const end = dateTo ?? new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const start = dateFrom ?? new Date(Date.parse(end) - days * 864e5).toISOString().slice(0, 10);
    for (const w of dayWindows(start, end)) {
      if (out.length >= limit) break;
      await sleep(600 + Math.random() * 600);
      const before = out.length;
      take(await feed(searchText(query, w)));
      log(`"${query}" ${w.dateFrom}: +${out.length - before}`);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli(
    async (pos, f) => {
      const out = [];
      for (const q of pos) out.push(...(await scrape(q, { max: f.max, timeframe: f.when, dateFrom: f.from, dateTo: f.to, log: (m) => process.stderr.write(`${m}\n`) })));
      return out;
    },
    `
Usage: node index.mjs <query>... [options]

  "nvidia"   "climate change"   "openai -musk"   "site:reuters.com tariffs"
  --max N          articles per query (default 100; more than 100 walks back one day per request)
  --when 1h|1d|7d|30d|1y
  --from YYYY-MM-DD --to YYYY-MM-DD

Needs UNBROWSE_API_KEY (free at https://unbrowse.ai).`,
  );
}
