interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * gBizINFO — Japanese corporate registry, from METI (経済産業省).
 *
 * Every Japanese corporation has a 13-digit 法人番号 (corporate number), and
 * gBizINFO hangs government records off it: registry profile, government
 * procurement awards, subsidies received, patents and trademarks, statutory
 * certifications, commendations, filed financials and workplace statistics.
 * This is the JP leg our entity-resolution tools lacked.
 *
 * PLATFORM KEY, since 2026-09-13 (fleet #1940). The gateway holds
 * PLATFORM_GBIZINFO_KEY and injects it, so callers need no key of their own;
 * `_apiKey` stays accepted for anyone who prefers their own token and its own
 * quota.
 *
 * It shipped BYOK-only first, with `platformKeyEnv` deliberately absent, so the
 * gateway's keyBlockedTools() sank these tools from routing while no key
 * existed — an honest no_match beats routing Japanese-company questions to a
 * tool that can only refuse. Secret and `platformKeyEnv` landed together, which
 * is the rule that ordering exists to enforce (fda-inspections, fleet #617).
 *
 * DO NOT PASTE THE TRIAL TOKEN IN HERE. The public OpenAPI document at
 * https://api.info.gbiz.go.jp/hojin/v3/api-docs?group=v2 embeds a token in its
 * `info.description`, and the same sentence says in Japanese that it is for
 * checking behaviour on the Swagger page only. It is fine for reading response
 * shapes during a build. It is not ours to ship, and a pack that shipped it
 * would break for everyone the day METI rotates it.
 *
 * FOUR UPSTREAM BEHAVIOURS, all measured live 2026-09-13:
 *
 *  1. A MISSING TOKEN IS AN HTTP 500, NOT A 401. Omit the header entirely and
 *     the API answers `500 - Internal Server Error.`; a WRONG token answers a
 *     clean 401. Passed through, a missing credential reads as "gBizINFO is
 *     down" and gets filed as an upstream outage. Translated below.
 *
 *  2. THE HOST IS api.info.gbiz.go.jp AND THE VERSION IS v2. The bare
 *     info.gbiz.go.jp answers /hojin/v1/... with the SAME 500/401 signature, so
 *     it looks like a working base until you try v2 there and get an HTML 404.
 *
 *  3. NO RESULTS IS AN HTTP 404 — the same status and the same body as a
 *     corporate number that does not exist and as a malformed one. So 404 must
 *     NOT be reported as "not found" on a search: on a search it means zero
 *     matches, which is a normal answer.
 *
 *  4. THE RESPONSE CARRIES NO TOTAL. The envelope is
 *     {id, errors, message, hojin-infos} and nothing else — no count, no
 *     next-page marker. `limit` caps at 5000 and `page` at 10, so nothing here
 *     ever claims a total it did not receive.
 *
 * AND THE ONE THAT WILL BITE A CALLER RATHER THAN A BUILDER — see
 * `gbiz_company_search`: a Latin-script name search does not find the company
 * you mean.
 */


const BASE = 'https://api.info.gbiz.go.jp/hojin';
const UA = 'pipeworx-mcp-gbizinfo/1.0 (+https://pipeworx.io)';
const REGISTER = 'https://info.gbiz.go.jp/hojin/various_registration/form';

async function pwFetch(url: string, token: string): Promise<Response> {
  return fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA, Accept: 'application/json', 'X-hojinInfo-api-token': token } },
    'gBizINFO (METI)',
  );
}

function bad(message: string): never {
  throw new Error(`user_error: ${message}`);
}

/**
 * The refusal a caller without a key gets. It must literally say "requires an
 * API key": the quality suite books that wording as a correct gated refusal and
 * anything else as a Pipeworx defect.
 */
function requireKey(args: Record<string, unknown>): string {
  const k = args._apiKey;
  if (typeof k === 'string' && k.trim()) return k.trim();
  // Reached only if the platform key is missing from the environment — the
  // gateway normally injects it. Still says "requires an API key" verbatim,
  // because that wording is what books a gated refusal as a gate rather than a
  // Pipeworx defect.
  throw new Error(
    'auth_required: gBizINFO requires an API key and none was supplied. ' +
      `Pass your own token via _apiKey, or register free at ${REGISTER} (choose 個人利用者 / "individual" ` +
      'if you are not applying on behalf of a Japanese corporation — the corporate path asks for a ' +
      '13-digit 法人番号); the token arrives by email.',
  );
}

interface Envelope {
  message?: string;
  errors?: unknown;
  'hojin-infos'?: Array<Record<string, unknown>>;
}

/**
 * `emptyOn404` is the whole reason this wrapper exists. gBizINFO answers a
 * search with no matches, a corporate number that does not exist, and a
 * malformed corporate number all with the same 404 and the same body — so the
 * CALLER's intent, not the status, decides which of those it was.
 */
async function gbizGet(path: string, token: string, emptyOn404: boolean): Promise<Array<Record<string, unknown>>> {
  const res = await pwFetch(`${BASE}${path}`, token);
  const text = await res.text();

  if (res.status === 401) {
    throw new Error(
      'auth_required: gBizINFO rejected that API key (HTTP 401). Check the token from your ' +
        `registration email, or register at ${REGISTER}.`,
    );
  }
  if (res.status === 500 && !text.includes('hojin-infos')) {
    // Measured: omitting the header entirely returns 500, not 401. Reporting
    // this verbatim files a missing credential as an upstream outage.
    throw new Error(
      'auth_required: gBizINFO requires an API key and answered a credential-less request with ' +
        'HTTP 500 (it returns 401 only for a key it can read). Pass your token via _apiKey.',
    );
  }
  if (res.status === 404) {
    if (emptyOn404) return [];
    throw new Error('not_found: gBizINFO holds no record for that 13-digit corporate number.');
  }

  let parsed: Envelope;
  try {
    parsed = JSON.parse(text) as Envelope;
  } catch {
    throw new Error(`upstream_down: gBizINFO returned HTTP ${res.status} and a non-JSON body.`);
  }
  if (!res.ok) {
    throw new Error(`upstream_down: gBizINFO returned HTTP ${res.status}: ${String(parsed.message ?? '').slice(0, 120)}`);
  }
  return parsed['hojin-infos'] ?? [];
}

const CORP_NUMBER = /^\d{13}$/;

/**
 * Resolve the caller's `corporate_number` to a real 13-digit 法人番号.
 *
 * It accepts a NAME as well as a number, and that is not a convenience — it is
 * the difference between this pack answering and refusing. Measured live the
 * day the platform key landed: ask_pipeworx sent "what Japanese government
 * procurement contracts has Toyota Motor received?" straight to
 * gbiz_company_procurement with a non-numeric argument, because a router picks
 * the tool whose DESCRIPTION matches the question, not the one whose argument
 * the caller happens to hold. Telling it in prose to call gbiz_company_search
 * first does not change that. So the resolution happens here.
 *
 * A name that matches exactly one filer resolves silently and the response says
 * what it resolved. Several matches refuse and LIST them rather than guessing —
 * picking the first would answer confidently about the wrong company, which is
 * the failure this whole pack is careful about.
 */
async function corpNumber(args: Record<string, unknown>, token: string): Promise<{ cn: string; resolvedFrom?: string }> {
  const raw = String(args.corporate_number ?? '').replace(/[\s\u3000-]/g, '');
  if (!raw) {
    bad('Required argument "corporate_number" is missing. Pass the 13-digit Japanese corporate number (法人番号), e.g. "1180301018771" for Toyota Motor, or the company name.');
  }
  if (CORP_NUMBER.test(raw)) return { cn: raw };

  // Not a number — treat it as a name and look it up.
  const term = String(args.corporate_number).trim();
  const p = new URLSearchParams({ name: term, limit: '10', page: '1', fields_hint: '' });
  p.delete('fields_hint');
  const rows = await gbizGet(`/v2/hojin?${p}`, token, true);
  const hits = rows.filter((r) => typeof r.corporate_number === 'string');

  if (hits.length === 0) {
    throw new Error(
      `not_found: "${term}" is neither a 13-digit Japanese corporate number nor a company gBizINFO lists.` +
        (isLatinOnly(term)
          ? ' A Latin-script name is matched against the romanised name field, which most Japanese companies leave empty — try the Japanese name (e.g. "トヨタ自動車" rather than "Toyota Motor").'
          : ' Try a shorter fragment of the name — matching is partial, not fuzzy.'),
    );
  }
  // An exact name match wins over partial ones: "トヨタ自動車" should not be
  // ambiguous just because 軽井沢トヨタ自動車 also contains it.
  //
  // The comparison strips the corporate-form token first, because nobody types
  // it and every legal name carries it: the registered name is
  // トヨタ自動車株式会社, so a bare "トヨタ自動車" matched ten filers exactly
  // until this normalisation existed. 株式会社 is written both before and after
  // the name depending on the company, so both positions go.
  const bare = (n: string) =>
    n.replace(/(株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|公益社団法人|一般財団法人|公益財団法人|独立行政法人|国立大学法人)/g, '')
      .replace(/[\s\u3000]/g, '')
      .trim();
  const wanted = bare(term);
  const exact = hits.filter((r) => bare(String(r.name ?? '')) === wanted);
  const chosen = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (!chosen) {
    const list = hits.slice(0, 8).map((r) => `${r.corporate_number} ${r.name}`).join('; ');
    bad(`"${term}" matches ${hits.length} filers in gBizINFO — pass the corporate number of the one you mean: ${list}.`);
  }
  return { cn: String(chosen.corporate_number), resolvedFrom: `${term} → ${chosen.name}` };
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Latin letters with no CJK — the shape that silently searches the wrong field. */
function isLatinOnly(s: string): boolean {
  return /[A-Za-z]/.test(s) && !/[　-ヿ㐀-䶿一-鿿ｦ-ﾟ]/.test(s);
}

const SOURCE_CODES: Record<string, string> = {
  procurement: '1',
  commendation: '2',
  certification: '3',
  subsidy: '4',
  patent: '5',
  finance: '6',
};

function profile(h: Record<string, unknown>) {
  return {
    corporate_number: h.corporate_number ?? null,
    name: h.name ?? null,
    name_kana: h.kana ?? null,
    name_romanised: h.name_en ?? null,
    location: h.location ?? null,
    postal_code: h.postal_code ?? null,
    representative: h.representative_name ?? null,
    capital_stock_yen: h.capital_stock ?? null,
    employee_number: h.employee_number ?? null,
    date_of_establishment: h.date_of_establishment ?? null,
    business_summary: h.business_summary ?? null,
    company_url: h.company_url ?? null,
    status: h.status ?? null,
    close_date: h.close_date ?? null,
  };
}

const KEY_ARG = {
  _apiKey: {
    type: 'string',
    description: 'Optional. Your own gBizINFO API token, if you would rather use your own quota than the shared one. Register free at https://info.gbiz.go.jp/hojin/various_registration/form — pick 個人利用者 (individual) unless you have a Japanese 法人番号.',
  },
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'gbiz_company_search',
    description:
      'Find Japanese companies and their 13-digit corporate numbers (法人番号) in gBizINFO, the Japanese government corporate registry run by METI. Search by company name, prefecture, corporate form, capital, employee count, revenue, or by whether the company has government procurement awards, subsidies, patents or filed financials. Returns each match with its corporate number, Japanese legal name, romanised name, registered address, capital and headcount.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Company name, partial match. PASS THE JAPANESE NAME WHERE YOU CAN ("トヨタ自動車"): a Latin-script query is matched against the romanised name field, which is sparse and dominated by municipal bodies — "Toyota" returns Toyota City property wards, not トヨタ自動車株式会社. The response flags this when it applies.',
        },
        prefecture: { type: 'string', description: 'Prefecture code, 2 digits from the JIS local-government code (13 = Tokyo, 23 = Aichi, 27 = Osaka).' },
        city: { type: 'string', description: 'Municipality code from the same JIS scheme.' },
        corporate_type: { type: 'string', description: 'Corporate form code: 301 株式会社 (joint-stock), 302 有限会社, 303 合名会社, 304 合資会社, 305 合同会社, 201 local government, 101 national body.' },
        has: { type: 'string', description: `Restrict to companies that have records of a given kind: ${Object.keys(SOURCE_CODES).join(', ')}.` },
        capital_min: { type: 'number', description: 'Minimum capital stock in yen.' },
        capital_max: { type: 'number', description: 'Maximum capital stock in yen.' },
        employees_min: { type: 'number', description: 'Minimum employee count.' },
        employees_max: { type: 'number', description: 'Maximum employee count.' },
        founded_year: { type: 'string', description: 'Year of establishment, or several comma-separated.' },
        limit: { type: 'number', description: 'Companies to return, 1-100 (default 20).' },
        page: { type: 'number', description: 'Result page, 1-10 (default 1).' },
        ...KEY_ARG,
      },
    },
  },
  {
    name: 'gbiz_company_profile',
    description:
      'Registry profile for one Japanese company by its 13-digit corporate number (法人番号), from gBizINFO (METI). Returns the Japanese legal name, kana and romanised forms, registered address and postcode, representative director, capital stock in yen, employee count, date of establishment, business summary and corporate website, plus dissolution date if the company has closed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        corporate_number: { type: 'string', description: 'The company: its 13-digit Japanese corporate number (法人番号), e.g. "1180301018771", or its name. A name is resolved to a corporate number, and the Japanese name resolves far more reliably than a romanised one — "トヨタ自動車" over "Toyota Motor".' },
        ...KEY_ARG,
      },
      required: ['corporate_number'],
    },
  },
  {
    name: 'gbiz_company_procurement',
    description:
      'Japanese government contracts awarded to one company, by its 13-digit corporate number, from gBizINFO (METI). Each award returns the order date, the contract title, the amount in yen and the ministry or agency that placed it — the Japanese counterpart to a USAspending award history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        corporate_number: { type: 'string', description: 'The company: its 13-digit Japanese corporate number (法人番号) or its name — a name is resolved, and the Japanese form resolves far more reliably than a romanised one.' },
        limit: { type: 'number', description: 'Awards to return, newest first, 1-500 (default 50).' },
        ...KEY_ARG,
      },
      required: ['corporate_number'],
    },
  },
  {
    name: 'gbiz_company_subsidies',
    description:
      'Japanese government subsidies and grants received by one company, by its 13-digit corporate number, from gBizINFO (METI). Each record returns the approval date, the subsidy programme name, the amount in yen and the granting ministry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        corporate_number: { type: 'string', description: 'The company: its 13-digit Japanese corporate number (法人番号) or its name — a name is resolved, and the Japanese form resolves far more reliably than a romanised one.' },
        limit: { type: 'number', description: 'Subsidies to return, newest first, 1-500 (default 50).' },
        ...KEY_ARG,
      },
      required: ['corporate_number'],
    },
  },
  {
    name: 'gbiz_company_records',
    description:
      'Patents and trademarks, statutory certifications, government commendations, filed financial results, or workplace statistics for one Japanese company, by its 13-digit corporate number, from gBizINFO (METI). Pick the record type with `kind`. Workplace statistics carry headcount by sex, average tenure, average age, overtime hours and childcare-leave take-up — the disclosure Japanese employers file under the 女性活躍推進法.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        corporate_number: { type: 'string', description: 'The company: its 13-digit Japanese corporate number (法人番号) or its name — a name is resolved, and the Japanese form resolves far more reliably than a romanised one.' },
        kind: { type: 'string', description: 'Which record set: "patent", "certification", "commendation", "finance" or "workplace".' },
        limit: { type: 'number', description: 'Records to return, 1-500 (default 50).' },
        ...KEY_ARG,
      },
      required: ['corporate_number', 'kind'],
    },
  },
];

const SOURCE = 'gBizINFO, Ministry of Economy, Trade and Industry (METI), Japan';
const RECORD_KINDS: Record<string, string> = {
  patent: 'patent',
  certification: 'certification',
  commendation: 'commendation',
  finance: 'finance',
  workplace: 'workplace',
};

async function companySearch(args: Record<string, unknown>) {
  const token = requireKey(args);
  const limit = asInt(args.limit, 20, 1, 100);
  const page = asInt(args.page, 1, 1, 10);

  const p = new URLSearchParams({ limit: String(limit), page: String(page) });
  const name = args.name ? String(args.name).trim() : '';
  if (name) p.set('name', name);
  if (args.prefecture) p.set('prefecture', String(args.prefecture));
  if (args.city) p.set('city', String(args.city));
  if (args.corporate_type) p.set('corporate_type', String(args.corporate_type));
  if (args.capital_min !== undefined) p.set('capital_stock_from', String(asInt(args.capital_min, 0, 0, Number.MAX_SAFE_INTEGER)));
  if (args.capital_max !== undefined) p.set('capital_stock_to', String(asInt(args.capital_max, 0, 0, Number.MAX_SAFE_INTEGER)));
  if (args.employees_min !== undefined) p.set('employee_number_from', String(asInt(args.employees_min, 0, 0, 10_000_000)));
  if (args.employees_max !== undefined) p.set('employee_number_to', String(asInt(args.employees_max, 0, 0, 10_000_000)));
  if (args.founded_year) p.set('founded_year', String(args.founded_year));
  if (args.has) {
    const code = SOURCE_CODES[String(args.has).toLowerCase()];
    if (!code) bad(`"${args.has}" is not a record kind gBizINFO indexes. Use one of: ${Object.keys(SOURCE_CODES).join(', ')}.`);
    p.set('source', code);
  }
  // An unfiltered search would page the whole national registry, so refuse it
  // rather than return the first 20 companies in id order as if they answered
  // something. Counted explicitly: URLSearchParams key iteration needs a lib
  // this pack should not depend on.
  if (p.toString() === new URLSearchParams({ limit: String(limit), page: String(page) }).toString()) {
    bad('gbiz_company_search needs at least one filter — a name, a prefecture, a corporate_type, a size range, or `has`.');
  }

  // emptyOn404: on a SEARCH a 404 means zero matches, which is an answer.
  const rows = await gbizGet(`/v2/hojin?${p}`, token, true);
  const companies = rows.map(profile);

  if (companies.length === 0) {
    return {
      found: false,
      reason: 'no_matching_companies',
      hint: name && isLatinOnly(name)
        ? `No company matched "${name}". A Latin-script name is matched against the romanised name field, which most Japanese companies leave empty — search the Japanese name instead (e.g. "トヨタ自動車" rather than "Toyota Motor").`
        : 'No company matched those filters. Widen the size range, drop `has`, or search a shorter fragment of the name — matching is partial, not fuzzy.',
      source: SOURCE,
    };
  }

  return {
    found: true,
    returned: companies.length,
    page,
    // gBizINFO returns no count and no next-page marker, so nothing here claims
    // a total. A full page means there is probably another one.
    more_pages_possible: companies.length === limit && page < 10,
    ...(name && isLatinOnly(name)
      ? {
          match_note:
            `"${name}" is Latin script, so it was matched against the romanised name field rather than the Japanese legal name. ` +
            'That field is sparse and heavily municipal — check `name` on each result, and search the Japanese name for a specific company.',
        }
      : {}),
    companies,
    source: SOURCE,
  };
}

async function companyProfile(args: Record<string, unknown>) {
  const token = requireKey(args);
  const { cn, resolvedFrom } = await corpNumber(args, token);
  const rows = await gbizGet(`/v2/hojin/${cn}`, token, false);
  if (!rows.length) throw new Error(`not_found: gBizINFO holds no record for corporate number ${cn}.`);
  return { found: true, ...profile(rows[0]), ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}), source: SOURCE };
}

/** The per-company legs share one shape: one envelope row holding a named array. */
async function companyLeg(args: Record<string, unknown>, leg: string, field: string, label: string, dflt = 50) {
  const token = requireKey(args);
  const { cn, resolvedFrom } = await corpNumber(args, token);
  const limit = asInt(args.limit, dflt, 1, 500);
  const rows = await gbizGet(`/v2/hojin/${cn}/${leg}`, token, false);
  const row = rows[0] ?? {};
  const all = Array.isArray(row[field]) ? (row[field] as Array<Record<string, unknown>>) : [];

  if (all.length === 0) {
    // A 200 with an empty array is gBizINFO's normal way of saying a real
    // company simply has none of this — Toyota's /subsidy is empty. It is not
    // an error and must not be reported as one.
    return {
      found: false,
      reason: `no_${field}_records`,
      hint: `gBizINFO holds no ${label} for ${String(row.name ?? cn)}. The company exists and its profile is available via gbiz_company_profile; it simply has no ${label} on record.`,
      corporate_number: cn,
      name: row.name ?? null,
      ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}),
      source: SOURCE,
    };
  }

  return {
    found: true,
    corporate_number: cn,
    name: row.name ?? null,
    location: row.location ?? null,
    ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}),
    returned: Math.min(all.length, limit),
    total_on_record: all.length,
    [field]: all.slice(0, limit),
    source: SOURCE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gbiz_company_search':
      return companySearch(args);
    case 'gbiz_company_profile':
      return companyProfile(args);
    case 'gbiz_company_procurement':
      return companyLeg(args, 'procurement', 'procurement', 'government procurement awards');
    case 'gbiz_company_subsidies':
      return companyLeg(args, 'subsidy', 'subsidy', 'government subsidies');
    case 'gbiz_company_records': {
      const kind = String(args.kind ?? '').toLowerCase();
      const leg = RECORD_KINDS[kind];
      if (!leg) bad(`"${args.kind}" is not a gBizINFO record kind. Use one of: ${Object.keys(RECORD_KINDS).join(', ')}. For procurement awards use gbiz_company_procurement, and for subsidies gbiz_company_subsidies.`);
      return companyLeg(args, leg, leg, `${kind} records`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
