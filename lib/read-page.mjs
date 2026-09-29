// Fetch one page through a public Unbrowse registry tool, sent from this machine (client egress),
// and keep the raw body so a scraper can parse it into structured records.
//
// Why not `runOnClient`: when the site refuses us (403, captcha, bot page), runOnClient either posts
// the refused response back or, if our fetch throws, posts an `error`. Both are recorded against the
// public tool, and a couple of such failures exclude the tool for every user. A refusal is about this
// IP, not the tool. So this loop drives the egress protocol with the SDK's lower-level calls and, on a
// refusal, closes the session (`closeEgress`) without posting anything.
//
// Direct fallback: every call site also says which request the tool stands for (`opts.direct`). When
// Unbrowse cannot run the tool before anything reached the site (no API key, tool not in the registry,
// tool needs a browser, service down, tool now asks for a different page), that request is sent
// straight from this machine with a normal browser user agent, checked for refusals the same way, and
// the body goes to the same parser. The Unbrowse API key is never sent to the site.
import { Unbrowse, UnbrowseError, isEgressStep } from "@unbrowse/sdk";

/** The site refused this IP (bot check, captcha, rate limit). Nothing was reported to the tool. */
export class RefusedError extends Error {
  constructor(message, page) {
    super(message);
    this.name = "RefusedError";
    this.page = page;
  }
}

// Only checked on small pages: real results pages are hundreds of KB and may mention these words in scripts.
const BOT_MARKERS = [
  /g-recaptcha|hcaptcha|captcha-delivery|px-captcha|\/captcha\//i,
  /cf-chl-|challenge-platform|Just a moment\.\.\./i,
  /Access to this page has been denied/i,
  /api-services-support@amazon\.com|\/errors\/validateCaptcha|Type the characters you see/i,
  /unusual traffic from your computer/i,
  /confirm you.re not a bot/i,
];
const BLOCK_REDIRECT = /google\.com\/sorry|captcha|\/checkpoint\/|authwall|\/uas\/login|\/login\b|\/signin\b|\/ap\/signin/i;

/**
 * Generic refusal check. `page` = { status, url, location, body }. Returns a reason string or false.
 * A 3xx is fine (the tool follows it and asks for the next hop) unless it points at a bot wall or login.
 */
export function isRefused(page, { minBytes = 2048 } = {}) {
  const { status, body = "", location = "" } = page;
  if (status >= 400) return `HTTP ${status}`;
  if (status >= 300) return BLOCK_REDIRECT.test(location) ? `redirected to a bot wall (${location.slice(0, 80)})` : false;
  if (body.length < minBytes) return `tiny body (${body.length} bytes)`;
  if (body.length < 150_000) for (const re of BOT_MARKERS) if (re.test(body)) return `bot page (${re.source.slice(0, 40)})`;
  return false;
}

/** The public capability id for a site's page reader: amazon.com → public.amazon_com.read_page. */
export const capabilityFor = (host, tool = "read_page") => `public.${host.replace(/^www\./, "").replace(/[.-]/g, "_")}.${tool}`;

let client;
/** One SDK client; UNBROWSE_API_KEY from the environment unless `apiKey` is given. */
export function unbrowse(apiKey) {
  if (apiKey) return new Unbrowse({ apiKey });
  if (!process.env.UNBROWSE_API_KEY) throw new Error("UNBROWSE_API_KEY is not set. Get a free key at https://unbrowse.ai");
  return (client ??= new Unbrowse());
}

const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** A desktop browser's user agent and accept headers, for requests this machine sends straight to a site. */
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const BROWSER_HEADERS = { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" };

// Per run: tools Unbrowse could not run (asked once, then skipped) and the notes already printed.
const unavailable = new Map();
const noted = new Set();
const say = (opts, key, line) => {
  if (noted.has(key)) return;
  noted.add(key);
  (opts.note ?? ((m) => process.stderr.write(`${m}\n`)))(line);
};
/** How pages were served this run: { unbrowse, direct }. */
export const stats = { unbrowse: 0, direct: 0 };
/** Forget which tools were unavailable and which notes were printed (tests, long-running processes). */
export function resetFallback() {
  unavailable.clear();
  noted.clear();
  stats.unbrowse = stats.direct = 0;
}

const hasKey = (opts) => !!(opts.client || opts.apiKey || process.env.UNBROWSE_API_KEY);
const hostOf = (url) => new URL(url).host;
const siteHost = (h) => h.toLowerCase().replace(/^www\./, "");
// "Same page" = same host and path (query strings differ in harmless ways: empty params, key order).
const pathKey = (url) => {
  const u = new URL(url);
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {}
  return `${siteHost(u.hostname)}${p.replace(/\+/g, " ").replace(/\/+$/, "")}`;
};

/**
 * Read one page. Unbrowse first: run `capability` with `input` over client egress and return the final page
 * the site sent, { status, url, body, via: "unbrowse", run }.
 *
 * - The site refused (see isRefused, plus opts.refused(page) for site checks): the session is closed
 *   with closeEgress, nothing is posted, and RefusedError is thrown.
 * - A request for a host outside opts.hosts (the site's own domains): closed, never sent, error thrown.
 *   The tool only ever needs the site itself; this keeps your IP from being pointed anywhere else.
 * - opts.fetch replaces globalThis.fetch (e.g. to go through your own proxy).
 *
 * opts.direct = { url, method, headers, body } (or a function returning it) is the request the tool stands for.
 * It is sent straight from this machine ({ ..., via: "direct" }) when Unbrowse fails before anything reached the
 * site: no API key, the tool is not in the registry, it needs a browser, the service is unreachable or refuses
 * the key, or the tool's first request is for a different page than `direct.url`. After the first such failure
 * the tool is skipped for the rest of the run. A site refusal is never retried directly (same IP, same answer).
 */
export async function readPage(capability, input, opts = {}) {
  const direct = typeof opts.direct === "function" ? opts.direct() : opts.direct;
  if (!hasKey(opts)) {
    if (!direct) unbrowse(); // throws: key needed
    say(opts, "no-key", "note: UNBROWSE_API_KEY is not set; requesting sites directly from this machine. A free key (https://unbrowse.ai) runs the shared site tools first.");
    return directPage(direct, opts);
  }
  if (direct && unavailable.has(capability)) return directPage(direct, opts);
  try {
    const page = await viaUnbrowse(capability, input, { ...opts, expect: direct?.url });
    stats.unbrowse++;
    return page;
  } catch (err) {
    const why = direct ? fallbackReason(err) : null;
    if (!why) throw err;
    unavailable.set(capability, why);
    say(opts, `tool:${capability}`, `note: Unbrowse tool ${capability} unavailable (${why}); fetching ${hostOf(direct.url)} directly`);
    return directPage(direct, opts);
  }
}

/** Why Unbrowse could not serve this call, when nothing was sent to the site; null when the error stands. */
export function fallbackReason(err) {
  if (!err || err instanceof RefusedError || err.sentToSite) return null;
  if (err instanceof ToolMismatchError) return err.message;
  if (err instanceof OffSiteError) return "tool asked for another host";
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  if (code === "capability_not_found" || (err.status === 404 && err instanceof UnbrowseError)) return "not in the registry";
  if (code === "requires_browser" || /no renderer|requires? a browser/i.test(msg)) return "needs a browser";
  if (err instanceof UnbrowseError) {
    if (err.status === 401 || err.status === 403) return "API key refused";
    if (err.status === 402) return "out of credits";
    if (err.status === 429 || err.status >= 500) return `service error ${err.status}`;
    return code ? `run failed: ${code}` : "run failed";
  }
  // The SDK's own fetch to the service failed (DNS, TLS, timeout, connection refused).
  if (err.name === "TypeError" || err.name === "TimeoutError" || err.name === "AbortError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg)) return "service unreachable";
  return null;
}

/**
 * Send `req` = { url, method, headers, body } from this machine: browser headers (req.headers win), redirects
 * followed by hand so each hop is checked against opts.hosts and bot walls, same refusal checks as the tool path.
 */
export async function directPage(req, opts = {}) {
  const send = opts.fetch ?? globalThis.fetch;
  const allowed = (url) => {
    if (!opts.hosts?.length) return true;
    const h = new URL(url).hostname;
    return opts.hosts.some((d) => h === d || h.endsWith(`.${d}`));
  };
  let url = req.url;
  let method = req.method ?? "GET";
  let body = req.body;
  for (let hop = 0; hop < 10; hop++) {
    if (!allowed(url)) throw new Error(`${hostOf(req.url)} redirected to ${hostOf(url)}, outside ${opts.hosts.join(", ")}; not followed`);
    let res;
    try {
      res = await send(url, { method, headers: { ...BROWSER_HEADERS, ...req.headers }, body, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000) });
    } catch (err) {
      throw new Error(`${hostOf(url)}: ${err?.cause?.code ?? err.message}`);
    }
    const text = await res.text();
    const page = { status: res.status, url: res.url || url, location: res.headers.get("location") ?? "", body: text, via: "direct" };
    const why = isRefused(page, opts) || opts.refused?.(page) || false;
    if (why) throw new RefusedError(`${hostOf(url)} refused this IP: ${why}`, page);
    if (res.status >= 300 && res.status < 400 && page.location) {
      url = new URL(page.location, url).toString();
      if (res.status !== 307 && res.status !== 308) (method = "GET"), (body = undefined);
      continue;
    }
    stats.direct++;
    return page;
  }
  throw new Error(`${hostOf(req.url)}: too many redirects`);
}

async function viaUnbrowse(capability, input, opts) {
  // A run that asks for another host before any site request has not reached the site at all (a service-side
  // hiccup, seen on cold tools). Nothing was sent, so trying again a little later is safe.
  const tries = opts.retries ?? 2;
  for (let i = 0; ; i++) {
    try {
      return await readPageOnce(capability, input, opts);
    } catch (err) {
      if (!(err instanceof OffSiteError) || err.sentToSite || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 3000) * (i + 1)));
    }
  }
}

class OffSiteError extends Error {}
/** The tool's first request is for a different page than the one this call stands for (the tool changed). */
class ToolMismatchError extends Error {}

async function readPageOnce(capability, input, opts) {
  const ub = opts.client ?? unbrowse(opts.apiKey);
  const send = opts.fetch ?? globalThis.fetch;
  const allowed = (url) => {
    if (!opts.hosts?.length) return true;
    const h = new URL(url).hostname;
    return opts.hosts.some((d) => h === d || h.endsWith(`.${d}`));
  };
  let step = await ub.run({ capability, input, egress: "client" });
  let last = null;
  let sent = false;
  for (let hop = 0; isEgressStep(step); hop++) {
    const { egressId } = step;
    const abandon = async (err) => {
      await ub.closeEgress(egressId).catch(() => {});
      throw err;
    };
    if (hop >= 10) await abandon(Object.assign(new Error(`${capability}: too many hops`), { sentToSite: sent }));
    for (const q of step.requests) {
      if (!allowed(q.url)) await abandon(Object.assign(new OffSiteError(`${capability} asked this machine to fetch ${new URL(q.url).host}, outside ${opts.hosts.join(", ")}; closed without sending`), { sentToSite: sent }));
      if (!sent && opts.expect && pathKey(q.url) !== pathKey(opts.expect)) {
        const u = new URL(q.url);
        await abandon(new ToolMismatchError(`tool now requests ${u.host}${u.pathname.slice(0, 60)}`));
      }
      let res;
      sent = true;
      try {
        res = await send(q.url, {
          method: q.method,
          headers: q.headers,
          redirect: q.redirect,
          body: q.body === undefined ? undefined : q.bodyEncoding === "base64" ? toBytes(q.body) : q.body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
        });
      } catch (err) {
        // Our own network failed (DNS, TLS, timeout): not the tool's fault either. Abandon quietly.
        await abandon(Object.assign(new Error(`${new URL(q.url).host}: ${err?.cause?.code ?? err.message}`), { sentToSite: true }));
      }
      const body = await res.text();
      const page = { status: res.status, url: res.url || q.url, location: res.headers.get("location") ?? "", body };
      const why = isRefused(page, opts) || opts.refused?.(page) || false;
      if (why) await abandon(new RefusedError(`${new URL(q.url).host} refused this IP: ${why}`, page));
      if (res.status < 300) last = page;
      // fetch() already decoded the body, so drop the headers that describe the wire encoding.
      const headers = [...res.headers].filter(([k]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(k));
      step = await ub.answerEgress(egressId, q.id, { response: { status: res.status, headers, body, url: page.url } });
      if (!isEgressStep(step)) break;
    }
  }
  if (!last) {
    const err = step?.error;
    throw Object.assign(new UnbrowseError(`${capability}: ${err?.message ?? `run ${step?.status}`}`, 502, err?.code ?? "run_failed", step), { sentToSite: sent });
  }
  return { ...last, via: "unbrowse", run: step };
}

/** Run async `fn` over `items` with at most `n` in flight; results keep input order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k], k);
        } catch (error) {
          out[k] = { error };
        }
      }
    }),
  );
  return out;
}

/** Tiny argv parser: positionals plus --flag value / --flag. */
export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** CLI wrapper: prints JSON to stdout, progress and errors to stderr. */
export async function cli(main, usage) {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !pos.length) {
    process.stderr.write(usage.trim() + "\n");
    process.exit(pos.length ? 0 : 1);
  }
  try {
    const items = await main(pos, flags);
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    const via = [stats.unbrowse && `${stats.unbrowse} via Unbrowse`, stats.direct && `${stats.direct} direct`].filter(Boolean).join(", ");
    process.stderr.write(`${items.length} item(s)${via ? ` (requests: ${via})` : ""}\n`);
    if (!items.length) process.exitCode = 2;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
