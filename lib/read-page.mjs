// Fetch one page through a public Unbrowse registry tool, sent from this machine (client egress),
// and keep the raw body so a scraper can parse it into structured records.
//
// Why not `runOnClient`: when the site refuses us (403, captcha, bot page), runOnClient either posts
// the refused response back or, if our fetch throws, posts an `error`. Both are recorded against the
// public tool, and a couple of such failures exclude the tool for every user. A refusal is about this
// IP, not the tool. So this loop drives the egress protocol with the SDK's lower-level calls and, on a
// refusal, closes the session (`closeEgress`) without posting anything.
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

/**
 * Run `capability` with `input` over client egress and return the final page the site sent:
 * { status, url, body, run }.
 *
 * - The site refused (see isRefused, plus opts.refused(page) for site checks): the session is closed
 *   with closeEgress, nothing is posted, and RefusedError is thrown.
 * - A request for a host outside opts.hosts (the site's own domains): closed, never sent, error thrown.
 *   The tool only ever needs the site itself; this keeps your IP from being pointed anywhere else.
 * - opts.fetch replaces globalThis.fetch (e.g. to go through your own proxy).
 */
export async function readPage(capability, input, opts = {}) {
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
  for (let hop = 0; isEgressStep(step); hop++) {
    const { egressId } = step;
    const abandon = async (err) => {
      await ub.closeEgress(egressId).catch(() => {});
      throw err;
    };
    if (hop >= 10) await abandon(new Error(`${capability}: too many hops`));
    for (const q of step.requests) {
      if (!allowed(q.url)) await abandon(Object.assign(new OffSiteError(`${capability} asked this machine to fetch ${new URL(q.url).host}, outside ${opts.hosts.join(", ")}; closed without sending`), { sentToSite: !!last || hop > 0 }));
      let res;
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
        await abandon(new Error(`${new URL(q.url).host}: ${err?.cause?.code ?? err.message}`));
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
    throw new UnbrowseError(`${capability}: ${err?.message ?? `run ${step?.status}`}`, 502, err?.code ?? "run_failed", step);
  }
  return { ...last, run: step };
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
    process.stderr.write(`${items.length} item(s)\n`);
    if (!items.length) process.exitCode = 2;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
