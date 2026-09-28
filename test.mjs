import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dayWindows, parseRss, searchText, stripSource, timeOperators } from "./parse.mjs";

// Fixture: a real Google News RSS search feed (q=nvidia, US:en), captured 2026-09-28.
const xml = fs.readFileSync(new URL("./fixtures/search.xml", import.meta.url), "utf8");

test("google news: 101 items with title, publisher, source site, ISO date", () => {
  const r = parseRss(xml);
  assert.equal(r.items.length, 101);
  for (const it of r.items) {
    assert.ok(it.id && it.title && it.source && it.sourceUrl?.startsWith("http"), JSON.stringify(it));
    assert.match(it.publishedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(it.publishedTimestamp, Date.parse(it.publishedAt));
    assert.ok(it.googleNewsUrl.includes(it.id));
  }
  assert.equal(new Set(r.items.map((i) => i.id)).size, 101);
  assert.deepEqual([r.items[0].title, r.items[0].source], ["China weighs allowing ByteDance, Alibaba to buy new Nvidia chips, The Information reports", "Reuters"]);
});

test("google news: a bot page is not a feed", () => {
  assert.equal(parseRss("<html><body>Our systems have detected unusual traffic</body></html>"), null);
});

test("google news: time operators and day windows", () => {
  assert.equal(searchText("bitcoin -ethereum", { timeframe: "1d" }), "bitcoin -ethereum when:1d");
  assert.equal(searchText("ai", { dateFrom: "2026-09-01", dateTo: "2026-09-02" }), "ai after:2026-09-01 before:2026-09-02");
  assert.deepEqual(timeOperators({ timeframe: "all" }), []);
  assert.deepEqual(dayWindows("2026-09-26", "2026-09-28"), [{ dateFrom: "2026-09-27", dateTo: "2026-09-28" }, { dateFrom: "2026-09-26", dateTo: "2026-09-27" }]);
  assert.equal(stripSource("Chips rally - Reuters", "Reuters"), "Chips rally");
  assert.equal(stripSource("A - B", "Reuters"), "A - B");
});
