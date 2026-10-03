// The request engine: turns logical (method, path, body) calls into HTTP requests
// via a Transport, applies retry/backoff for transient statuses (429, 503), and
// decodes JSON responses.
//
// MUDAB is POST-only with a JSON body (the FilterRequest); every parameter travels
// in the body, so there is no query-string builder. There is no authentication.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import {
  MudabApiError,
  MudabNetworkError,
  MudabParseError,
  MudabValidationError,
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
  /** Base URL of the API. Defaults to the canonical geoportal.bafg.de MUDAB base. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
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
   * only idle gaps (0 disables; at most MAX_TIMEOUT_MS, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10; default 2). Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly); used without a
   * Retry-After. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most Number.MAX_SAFE_INTEGER.
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

/**
 * Reject a base URL whose scheme is not http(s), or that has a query or fragment.
 * The default transport already gates the scheme per hop, but the engine is
 * exported as a library and may be handed a custom transport that does no such
 * check, so gate the configured base URL here too (a `file:`/`ftp:` base URL fails
 * fast with a typed error). Request paths are appended to the base URL as a string,
 * so a `?` or `#` in it would swallow every path: `http://h/?x=1` posts to
 * `/?x=1/STATION_SMALL` and `http://h/#f` to `/`.
 */
function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new MudabNetworkError(`Invalid base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MudabNetworkError(
      `Unsupported protocol "${url.protocol}" in base URL: ${redactUrl(baseUrl)}`,
    );
  }
  if (/[?#]/.test(baseUrl)) {
    throw new MudabNetworkError(`Base URL must not contain a query or fragment: ${redactUrl(baseUrl)}`);
  }
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
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Re-check the base-URL scheme here, not only in the default transport: a
    // library consumer that injects a custom transport would otherwise get no
    // gating at all, and could be steered to a non-http(s) scheme. The raw value is
    // checked, before the trailing slashes are stripped: surrounding whitespace or a
    // control character, which new URL() drops silently, would end up in every
    // request URL (`/x%20/STATION_SMALL`).
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    assertHttpScheme(baseUrl);
    this.baseUrl = assertValid("baseUrl", baseUrl, baseUrlProblem).replace(/\/+$/, "");
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

  /** Build a fully-qualified URL from a path (all parameters travel in the body). */
  buildUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
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
      const response = await this.transport({
        method,
        url,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, response.headers["location"]);
      }

      return { data: response.body, contentType, status };
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
    const text = res.data.toString("utf8");
    if (res.status === 204 || text.trim().length === 0) {
      throw new MudabParseError(`Empty response body from ${path}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new MudabParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
  ): MudabApiError {
    const text = body.toString("utf8");
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
    return new MudabApiError({ status, url, method, body: text, detail, location });
  }
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
