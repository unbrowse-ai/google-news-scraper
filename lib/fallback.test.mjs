// The direct fallback: when Unbrowse cannot run a tool before anything reached the site, the same request goes
// straight from this machine; a site refusal never does, and a working tool is never bypassed.
import test from "node:test";
import assert from "node:assert/strict";
import { UnbrowseError } from "@unbrowse/sdk";
import { RefusedError, fallbackReason, readPage, resetFallback } from "./read-page.mjs";

const big = "<html>" + "x".repeat(5000) + "</html>";
const DIRECT = { url: "https://www.example.com/a?q=1", headers: { "x-site": "1" } };
const KEY = "ub_test_secret_key";

/** A fake SDK client: `run` does what `onRun` says; records every call. */
function fakeClient(onRun) {
  const calls = [];
  return {
    calls,
    run: async (req) => (calls.push(["run", req.capability]), onRun()),
    answerEgress: async (id, rid) => (calls.push(["answer", rid]), { status: "succeeded", runId: "r1" }),
    closeEgress: async (id) => (calls.push(["close", id]), { egressId: id, status: "closed" }),
  };
}
const egress = (url) => ({ status: "egress_required", egressId: "eg_1", requests: [{ id: "rq_1", method: "GET", url, headers: { "user-agent": "tool" }, redirect: "manual" }] });
/** A fake site: answers every request with (status, body); records url + headers. */
function fakeSite(status = 200, body = big, headers = {}) {
  const sent = [];
  const fetch = async (url, init) => (sent.push({ url, headers: init.headers ?? {} }), new Response(body, { status, headers }));
  return { sent, fetch };
}
function setup(onRun, site = fakeSite()) {
  resetFallback();
  const notes = [];
  const ub = fakeClient(onRun);
  const opts = { client: ub, fetch: site.fetch, hosts: ["example.com"], direct: DIRECT, note: (m) => notes.push(m), retryDelayMs: 1 };
  return { ub, site, notes, opts };
}

test("success via Unbrowse: no direct request", async () => {
  const { ub, site, notes, opts } = setup(() => egress("https://www.example.com/a?q=1&extra="));
  const page = await readPage("public.example_com.get_a", {}, opts);
  assert.equal(page.via, "unbrowse");
  assert.deepEqual(ub.calls.map((c) => c[0]), ["run", "answer"]);
  assert.equal(site.sent.length, 1);
  assert.equal(site.sent[0].headers["user-agent"], "tool"); // the tool's request, not ours
  assert.deepEqual(notes, []);
});

test("capability_not_found → direct, one note, tool skipped afterwards", async () => {
  const { ub, site, notes, opts } = setup(() => {
    throw new UnbrowseError("Capability x does not exist", 404, "capability_not_found");
  });
  const a = await readPage("public.example_com.gone", {}, opts);
  const b = await readPage("public.example_com.gone", {}, opts);
  assert.equal(a.via, "direct");
  assert.equal(b.via, "direct");
  assert.equal(ub.calls.filter((c) => c[0] === "run").length, 1);
  assert.equal(site.sent.length, 2);
  assert.equal(site.sent[0].url, DIRECT.url);
  assert.equal(site.sent[0].headers["x-site"], "1");
  assert.match(site.sent[0].headers["user-agent"], /Chrome\//);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /public\.example_com\.gone unavailable \(not in the registry\); fetching www\.example\.com directly/);
});

test("requires_browser (failed run, nothing sent) → direct", async () => {
  const { site, opts } = setup(() => ({ status: "failed", error: { code: "requires_browser", message: "read_page is a rendered page and no renderer is configured" } }));
  const page = await readPage("c", {}, opts);
  assert.equal(page.via, "direct");
  assert.equal(site.sent.length, 1);
});

test("service unreachable → direct", async () => {
  const { opts } = setup(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal((await readPage("c", {}, opts)).via, "direct");
});

test("tool now asks for a different page → closed unsent, direct", async () => {
  const { ub, site, notes, opts } = setup(() => egress("https://www.example.com/t/a%3Fq%3D1/"));
  const page = await readPage("c", {}, opts);
  assert.equal(page.via, "direct");
  assert.deepEqual(ub.calls.map((c) => c[0]), ["run", "close"]);
  assert.deepEqual(site.sent.map((s) => s.url), [DIRECT.url]);
  assert.match(notes[0], /tool now requests www\.example\.com\/t\//);
});

test("refused through Unbrowse → RefusedError, no direct retry", async () => {
  const { ub, site, opts } = setup(() => egress("https://www.example.com/a"), fakeSite(403));
  await assert.rejects(readPage("c", {}, opts), RefusedError);
  assert.deepEqual(ub.calls.map((c) => c[0]), ["run", "close"]);
  assert.equal(site.sent.length, 1);
});

test("refused on the direct request → RefusedError with the page", async () => {
  const { opts } = setup(() => {
    throw new UnbrowseError("gone", 404, "capability_not_found");
  }, fakeSite(200, "<html>Type the characters you see in this image</html>"));
  const err = await readPage("c", {}, opts).catch((e) => e);
  assert.ok(err instanceof RefusedError);
  assert.equal(err.page.via, "direct");
});

test("no API key → direct without touching Unbrowse; key never sent to the site", async () => {
  const saved = process.env.UNBROWSE_API_KEY;
  delete process.env.UNBROWSE_API_KEY;
  try {
    resetFallback();
    const site = fakeSite();
    const notes = [];
    const opts = { fetch: site.fetch, hosts: ["example.com"], direct: DIRECT, note: (m) => notes.push(m) };
    assert.equal((await readPage("c", {}, opts)).via, "direct");
    await readPage("c2", {}, opts);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /UNBROWSE_API_KEY is not set.*https:\/\/unbrowse\.ai/);
    // Without a direct request there is nothing to fall back to.
    await assert.rejects(readPage("c", {}, { fetch: site.fetch }), /UNBROWSE_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.UNBROWSE_API_KEY = saved;
  }
});

test("the Unbrowse key never reaches the site on the direct path", async () => {
  const saved = process.env.UNBROWSE_API_KEY;
  process.env.UNBROWSE_API_KEY = KEY;
  try {
    const { site, opts } = setup(() => {
      throw new UnbrowseError("gone", 404, "capability_not_found");
    });
    await readPage("c", {}, { ...opts, apiKey: KEY });
    assert.ok(!JSON.stringify(site.sent).includes(KEY));
  } finally {
    if (saved === undefined) delete process.env.UNBROWSE_API_KEY;
    else process.env.UNBROWSE_API_KEY = saved;
  }
});

test("direct redirects are followed on the site's hosts only", async () => {
  resetFallback();
  let n = 0;
  const hop = async (url) => (n++ ? new Response(big) : new Response("", { status: 302, headers: { location: "/b" } }));
  const page = await readPage("c", {}, { client: fakeClient(() => ({ status: "failed", error: { code: "requires_browser" } })), fetch: hop, hosts: ["example.com"], direct: DIRECT, note: () => {} });
  assert.equal(page.url, "https://www.example.com/b");
  const away = async () => new Response("", { status: 302, headers: { location: "https://evil.test/x" } });
  await assert.rejects(readPage("c", {}, { fetch: away, hosts: ["example.com"], direct: DIRECT, client: fakeClient(() => ({ status: "failed", error: { code: "x" } })), note: () => {} }), /outside example\.com; not followed/);
});

test("fallbackReason: only failures before the site was contacted", () => {
  assert.equal(fallbackReason(new RefusedError("x")), null);
  assert.equal(fallbackReason(Object.assign(new UnbrowseError("x", 502, "run_failed"), { sentToSite: true })), null);
  assert.equal(fallbackReason(new UnbrowseError("x", 402, "credits")), "out of credits");
  assert.equal(fallbackReason(new UnbrowseError("x", 401, "unauthorized")), "API key refused");
  assert.equal(fallbackReason(new UnbrowseError("x", 503, "down")), "service error 503");
});
