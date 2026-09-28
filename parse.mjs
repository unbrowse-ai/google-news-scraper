// Google News: search operators and RSS parsing. Pure functions, no I/O.

const WHEN = { "1h": "1h", "1d": "1d", "7d": "7d", "30d": "30d", "1y": "1y" };
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/** Search operators for the time filter: explicit dates win over the relative timeframe. */
export function timeOperators({ timeframe, dateFrom, dateTo } = {}) {
  const ops = [];
  if (dateFrom) ops.push(`after:${ymd(dateFrom)}`);
  if (dateTo) ops.push(`before:${ymd(dateTo)}`);
  if (!ops.length && WHEN[timeframe]) ops.push(`when:${WHEN[timeframe]}`);
  return ops;
}

/** The search text Google News gets: the query plus its time operators ("when:1d", "after:...", "before:..."). */
export function searchText(query, time = {}) {
  return [String(query ?? "").trim(), ...timeOperators(time)].filter(Boolean).join(" ");
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  const v = m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
  return decodeEntities(v).trim();
};
const clean = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Article id from a news.google.com/rss/articles/<id> or /read/<id> or /articles/<id> link. */
export function articleId(link) {
  return String(link ?? "").match(/\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
}

/** Title "Headline - Publisher" → "Headline" when the suffix is the source name. */
export function stripSource(title, source) {
  const t = String(title ?? "").trim();
  if (source && t.endsWith(` - ${source}`)) return t.slice(0, -(source.length + 3)).trim();
  return t;
}

/** Cluster links inside a top-stories item: <ol><li><a href>title</a> <font>publisher</font></li>... */
function parseCluster(descHtml) {
  const out = [];
  for (const li of descHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const a = li[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const src = li[1].match(/<font[^>]*>([\s\S]*?)<\/font>/);
    out.push({ title: clean(a[2]), source: src ? clean(src[1]) : null, googleNewsUrl: decodeEntities(a[1]), id: articleId(decodeEntities(a[1])) });
  }
  return out;
}

/** RSS feed → { title, items: [{ id, title, source, sourceUrl, googleNewsUrl, publishedAt, publishedTimestamp, relatedArticles }] }. null if not a feed. */
export function parseRss(xml) {
  if (typeof xml !== "string" || !/<rss[\s>]/.test(xml) || !xml.includes("<channel>")) return null;
  const head = xml.split("<item>")[0];
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    const link = tag(x, "link");
    const srcTag = x.match(/<source(?:\s+url="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/);
    const source = srcTag ? clean(srcTag[2]) : null;
    const sourceUrl = srcTag?.[1] ? decodeEntities(srcTag[1]) : null;
    const pub = tag(x, "pubDate");
    const date = pub ? new Date(pub) : null;
    const valid = date && !Number.isNaN(date.getTime());
    const desc = tag(x, "description") ?? "";
    const cluster = desc.includes("<ol>") ? parseCluster(desc) : [];
    const id = tag(x, "guid") || articleId(link);
    items.push({
      id,
      title: stripSource(clean(tag(x, "title")), source),
      source,
      sourceUrl,
      googleNewsUrl: link,
      publishedAt: valid ? date.toISOString() : null,
      publishedTimestamp: valid ? date.getTime() : null,
      // The first cluster entry is the item itself.
      relatedArticles: cluster.filter((c) => c.id !== id),
    });
  }
  return { title: tag(head, "title"), items };
}

/** Day windows [after, before] walking back from `end` to `start` (YYYY-MM-DD strings), newest first. */
export function dayWindows(start, end, max = 366) {
  const out = [];
  let d = new Date(`${ymd(end)}T00:00:00Z`);
  const s = new Date(`${ymd(start)}T00:00:00Z`);
  while (d > s && out.length < max) {
    const prev = new Date(d.getTime() - 86_400_000);
    out.push({ dateFrom: ymd(prev), dateTo: ymd(d) });
    d = prev;
  }
  return out;
}
