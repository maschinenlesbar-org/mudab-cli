// The request engine: turns logical (method, path, body) calls into HTTP requests
// via a Transport, applies retry/backoff for transient statuses (429, 503), and
// decodes JSON responses.
//
// MUDAB is POST-only with a JSON body (the FilterRequest); every parameter travels
// in the body, so there is no query-string builder. There is no authentication.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import {
  MudabApiError,
  MudabError,
  MudabNetworkError,
  MudabParseError,
  MudabValidationError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements";
const DEFAULT_USER_AGENT = "mudab-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a MudabValidationError.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to the canonical geoportal.bafg.de MUDAB base. An
   * absolute http(s) URL without a query, fragment, surrounding whitespace or control
   * characters (`baseUrlProblem`), else a MudabValidationError.
   */
  baseUrl?: string;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in
   * any case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and
   * turns whatever it throws, or a malformed response, into a `MudabNetworkError`.
   */
  transport?: Transport;
  /**
   * Value of the User-Agent header: not blank, Latin-1 without control characters
   * (tab is fine), else a MudabValidationError.
   */
  userAgent?: string;
  /** Extra headers sent on every request; names must be tokens, values follow the `userAgent` rule. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most MAX_TIMEOUT_MS, 2^31 - 1 ms). Enforced by the
   * engine for every transport: the request's `signal` aborts then.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10; default 2). A reset connection, a refused one, a DNS failure and a timeout are
   * not retried: every MUDAB call is a POST that may fetch a whole table, and the host
   * has blocked clients before. Each waits `retryDelayMs * attempt`, or the response's
   * `Retry-After` when that is longer (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried, and the error names the requested wait).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200). A
   * `Retry-After` can make a wait longer, never shorter. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most Number.MAX_SAFE_INTEGER. Enforced by the engine on the body any transport
   * returns (the default transport also stops reading early).
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Longest error `detail` we keep — a hostile body must not fill the terminal. */
const MAX_DETAIL_LENGTH = 200;

/**
 * Strip C0/C1 control characters (including DEL) out of a string that originates
 * in an attacker-controlled response — the error `detail`. `JSON.parse` decodes a
 * unicode escape such as backslash-u-001b in an error body into a real ESC byte,
 * so without this a hostile or MITM'd endpoint could drive ANSI/OSC escape
 * sequences into the user's terminal when the message is printed to stderr.
 * This only needs to cover text that flows into an error message: the CLI's JSON
 * output is escaped separately (`escapeControlChars` in cli/shared.ts), as
 * `JSON.stringify` alone leaves DEL and the C1 range raw. Checked by char code so
 * the source stays free of control bytes.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * A server-provided message made safe for an error message: control characters
 * stripped and cut at MAX_DETAIL_LENGTH characters.
 */
export function cleanDetail(raw: string): string {
  const clean = sanitizeServerText(raw);
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` or `Location` in any case: the engine then saw no
 * Retry-After (falling back to its 200 ms backoff) and no Location. Such an object
 * (anything with `get` and `forEach`, a `Headers` or a `Map`) is copied into a record; a
 * plain record gets its names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** The first value of a header that may have been given as a list. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxRetries: Infinity` retried a 503 without end.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new MudabValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Check a value bound for an HTTP header (`headerValueProblem`) and return it, or
 * throw a MudabValidationError (`Invalid <name>: <reason>`). The engine runs it on
 * `userAgent` and every `defaultHeaders` value before any request.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Check every `defaultHeaders` name (a token) and value; returns a copy. */
function checkedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Check the base URL here, not only in the default transport: a library
    // consumer that injects a custom transport would otherwise get no gating at all,
    // and could be steered to a non-http(s) scheme. The raw value is checked, before
    // the trailing slashes are stripped: surrounding whitespace or a control
    // character, which new URL() drops silently, would end up in every request URL
    // (`/x%20/STATION_SMALL`). A bad base URL is a configuration error, so
    // MudabValidationError (`Invalid baseUrl: <reason>`), not MudabNetworkError,
    // which a caller may treat as "retry later".
    this.#baseUrl = assertValid("baseUrl", options.baseUrl ?? DEFAULT_BASE_URL, baseUrlProblem).replace(
      /\/+$/,
      "",
    );
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Header values are checked up front: a blank one would be sent as is, a CR/LF
    // would reach a custom transport, and the default transport would fail late with
    // a raw TypeError outside the MudabError hierarchy.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.defaultHeaders = checkedHeaders(options.defaultHeaders ?? {});
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `MudabNetworkError` only; an injected one may throw anything (a string, a
   * `TypeError` from fetch). Every failure becomes a `MudabNetworkError` — a `MudabError` a
   * caller and the CLI can rely on — with the base URL's credentials scrubbed from its
   * message and cause chain; any other `MudabError` passes through, and a clean
   * `MudabNetworkError` stays as it is.
   */
  private transportError(cause: unknown): MudabError {
    if (cause instanceof MudabError && !(cause instanceof MudabNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = sanitizeServerText(this.scrub(reason));
    const scrubbed = this.scrubCause(cause);
    if (cause instanceof MudabNetworkError && message === cause.message && scrubbed === cause) return cause;
    return new MudabNetworkError(message, { cause: scrubbed });
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new MudabNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build a fully-qualified URL from a path (all parameters travel in the body). */
  buildUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.#baseUrl}${normalizedPath}`;
  }

  /**
   * Perform a request with Accept negotiation and transient-error retries.
   *
   * Redirects are deliberately NOT followed: the canonical host answers directly,
   * and following a cross-origin 3xx blindly is a footgun. A 3xx therefore
   * surfaces as a MudabApiError naming the redirect target (`location`).
   */
  async request(
    method: string,
    path: string,
    options: { accept: string; body?: Buffer } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(options.body.length);
    }

    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          ...(options.body !== undefined ? { body: options.body } : {}),
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // Not retried, whatever the failure (a reset included): see `maxRetries`.
        throw this.transportError(cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError (or, without a status, as success).
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new MudabNetworkError(`The transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new MudabNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can make the wait longer,
        // never shorter: `Retry-After: 0` or a date in the past turned the retries into a
        // zero-delay burst against a server that had just asked for less load. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once and
        // names the wait the server asked for.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
      }

      const contentType = String(firstValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        const tooLong = retryable && retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
        throw this.toApiError(
          method,
          url,
          status,
          body,
          firstValue(responseHeaders["location"]),
          tooLong ? retryAfter : undefined,
        );
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * POST a JSON payload and parse the JSON reply into `T`. Every MUDAB endpoint
   * answers with a JSON document, so an empty body (or a 204) is a
   * `MudabParseError`, not an empty result.
   */
  async postJson<T>(path: string, payload: unknown): Promise<T> {
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
    const res = await this.request("POST", path, { accept: "application/json", body });
    const text = decodeBody(res.data, res.contentType, path);
    if (res.status === 204 || text.trim().length === 0) {
      throw new MudabParseError(`Empty response body from ${path}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new MudabParseError(`Failed to parse JSON response from ${path}`, { cause: this.scrubCause(cause) });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    retryAfterMs?: number,
  ): MudabApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
      let raw: string | undefined;
      if (typeof parsed?.detail === "string") raw = parsed.detail;
      else if (typeof parsed?.message === "string") raw = parsed.message;
      else if (typeof parsed?.error === "string") raw = parsed.error;
      if (raw !== undefined) {
        // The parsed string is attacker-controlled: strip control bytes so ANSI/OSC
        // escapes can't reach the terminal, and cap length so a hostile body can't
        // flood stderr.
        detail = cleanDetail(raw);
      }
    } catch {
      // Not JSON. Surface a short, whitespace-collapsed snippet of a textual
      // body so the failure isn't context-free; skip HTML pages (start with "<").
      // Strip control bytes too — `\s+` collapses whitespace but leaves ESC/C0
      // intact, so a hostile plain-text body could still smuggle ANSI/OSC escapes.
      const snippet = sanitizeServerText(text.trim().replace(/\s+/g, " "));
      if (snippet.length > 0 && !snippet.startsWith("<")) {
        detail = snippet.length > MAX_DETAIL_LENGTH ? `${snippet.slice(0, MAX_DETAIL_LENGTH)}…` : snippet;
      }
    }
    // Redirects are not followed; name the target so the user can see where it points.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new MudabApiError({ status, url, method, body: text, detail, location, retryAfterMs });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none; the live API declares `application/json;charset=UTF-8`). TextDecoder drops a
 * leading byte order mark, which Buffer#toString keeps and JSON.parse then rejects, so
 * a BOM added by a proxy cannot turn a valid answer into a parse error; a Latin-1 body
 * declared as such keeps its umlauts and `µ` instead of turning them into U+FFFD. An
 * unknown charset label is a MudabParseError.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new MudabParseError(`Unsupported response charset "${sanitizeServerText(charset).slice(0, 100)}" from ${path}.`);
  }
  return decoder.decode(body);
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  let target: string;
  try {
    target = redactUrl(new URL(location, requestUrl).href);
  } catch {
    target = location;
  }
  const clean = sanitizeServerText(target).trim();
  return clean === "" ? undefined : clean;
}
