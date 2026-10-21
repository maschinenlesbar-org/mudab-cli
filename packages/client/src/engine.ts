// The request engine: turns logical (method, path, body) calls into HTTP requests
// via a Transport, applies retry/backoff for transient statuses (429, 503), and
// decodes JSON responses.
//
// MUDAB is POST-only with a JSON body (the FilterRequest); every parameter travels
// in the body, so there is no query-string builder. There is no authentication.

import { constants as bufferConstants } from "node:buffer";
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
  MAX_MESSAGE_VALUE_LENGTH,
  credentialsIn,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  quoteValue,
  redactCredentials,
  redactSecrets,
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
  baseUrl?: string | undefined;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in
   * any case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and
   * turns whatever it throws, or a malformed response, into a `MudabNetworkError`.
   */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header: not blank, Latin-1 without control characters
   * (tab is fine), else a MudabValidationError.
   */
  userAgent?: string | undefined;
  /** Extra headers sent on every request; names must be tokens, values follow the `userAgent` rule. */
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most MAX_TIMEOUT_MS, 2^31 - 1 ms). Enforced by the
   * engine for every transport: the request's `signal` aborts then.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10; default 2). A reset connection, a refused one, a DNS failure and a timeout are
   * not retried: every MUDAB call is a POST that may fetch a whole table, and the host
   * has blocked clients before. Each waits `retryDelayMs * attempt`, or the response's
   * `Retry-After` when that is longer (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried, and the error names the requested wait).
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200). A
   * `Retry-After` can make a wait longer, never shorter. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most Number.MAX_SAFE_INTEGER. Enforced by the engine on the body any transport
   * returns (the default transport also stops reading early).
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503;
   * never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`POST <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `mudab.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a 64-bit id). The value of a declared
   * member is delivered as its exact literal, as written, as a JSON string (`"5"`), so its type
   * never depends on its size. A declared member whose value is not a number (a string, `null`,
   * an object) is left as it is. Every undeclared number keeps the rule: exact, or a
   * MudabParseError. Matched by name anywhere in a JSON answer, an escaped name included.
   * Defaults to none (no MUDAB field is a number past 2^53); anything but a set or list of
   * non-empty strings makes the constructor throw a MudabValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
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
 * stripped and cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair).
 */
export function cleanDetail(raw: string): string {
  const clean = sanitizeServerText(raw);
  return clean.length > MAX_DETAIL_LENGTH ? `${cutText(clean, MAX_DETAIL_LENGTH)}…` : clean;
}

/**
 * True for U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069: the bidi controls, which
 * reorder the text that follows on a terminal. The CLI escapes them in its JSON output too.
 */
export function isBidiControl(n: number): boolean {
  return n === 0x061c || n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
}

/**
 * Server text that one of the client's own messages quotes — the messages of an error list
 * sent with status 200 — made safe and short: whitespace (line breaks, U+2028/U+2029
 * included) folded to one space, so it stays on one line; control characters
 * (`sanitizeServerText`) and the bidi controls dropped; trimmed and cut at `max`
 * characters (200). The error's `body` keeps the server's text as it came.
 */
export function serverTextForMessage(text: string, max = MAX_DETAIL_LENGTH): string {
  let clean = "";
  for (const ch of sanitizeServerText(text.replace(/\s+/g, " "))) {
    if (!isBidiControl(ch.codePointAt(0) ?? 0)) clean += ch;
  }
  clean = clean.trim();
  return clean.length > max ? `${cutText(clean, max)}…` : clean;
}

/**
 * Server text quoted as a JSON string in one of the client's own messages — a wrapper key,
 * a row's field name, the start of a body that is not JSON: `JSON.stringify`, which
 * escapes C0, and then DEL, C1 (U+009B is the 8-bit CSI), U+2028, U+2029 and the bidi
 * controls, which it leaves raw, escaped as `\uXXXX` too. Unlike `serverTextForMessage`,
 * which drops them, the quote keeps every character visible. The caller cuts.
 */
export function quoteServerText(text: string): string {
  let out = "";
  for (const ch of JSON.stringify(text)) {
    const n = ch.codePointAt(0) ?? 0;
    out += (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || isBidiControl(n) ? `\\u${n.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
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
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
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
      // A string is quoted, so `"5000"` doesn't read like the number 5000.
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ` +
        `${cutForMessage(typeof value === "string" ? JSON.stringify(value) : String(value))}.`,
    );
  }
  return value;
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function throws a `MudabValidationError`. A string `transport` used to fail only at the
 * first request, and a bad `sleep` as a raw TypeError on the first retry.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new MudabValidationError(`Invalid option ${name}: expected a function, got ${value === null ? "null" : typeof value}.`);
  }
  return value;
}

/** True for a loopback host name: `localhost`, `127.0.0.0/8`, `::1` (as `URL.hostname` gives them). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * What travels unencrypted when requests go to `baseUrl`, as one sentence for a
 * warning (the CLI logs it as a `WARN` record) — or `undefined` when nothing does: an `https:` URL, a URL that does
 * not parse (the base-URL check reports that), or a loopback host (`localhost`,
 * `127.0.0.0/8`, `::1`). The sentence names the host (`url.host`, host and port) and what
 * is sent with each request: the base URL's own credentials (userinfo) and any other
 * secret passed as a noun phrase in `secrets` (e.g. `"the API key"`). It never contains
 * a password or key. The CLI prints it once per run, before the first request.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const sent = [...secrets];
  if (url.username !== "" || url.password !== "") sent.push("the base URL's credentials");
  if (sent.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  // "the base URL's credentials" and any pair are plural; a single secret phrase is not.
  const verb = sent.length === 1 && secrets.length === 1 ? "is" : "are";
  return `${sent.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
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
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new MudabValidationError(
      `Invalid option defaultHeaders: expected an object of header names and values, got ` +
        `${headers === null ? "null" : Array.isArray(headers) ? "an array" : typeof headers}.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

/** Every EngineOptions key, in the order the unknown-option message lists them. */
const OPTION_NAMES = [
  "baseUrl",
  "transport",
  "userAgent",
  "defaultHeaders",
  "timeoutMs",
  "maxRetries",
  "retryDelayMs",
  "maxResponseBytes",
  "sleep",
  "onRetry",
  "onWarning",
  "bigIntegerKeys",
] as const satisfies ReadonlyArray<keyof EngineOptions>;

/**
 * Throw for a key that is not an EngineOptions name. A JavaScript caller's typo (`timeout` for
 * `timeoutMs`) was ignored silently and the default applied; TypeScript catches it at compile
 * time, JavaScript does not. An unset key (`proxy: undefined` from a spread config) changes
 * nothing and passes.
 */
function assertKnownOptions(options: object): void {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || (OPTION_NAMES as readonly string[]).includes(key)) continue;
    const lower = key.toLowerCase();
    const hint = OPTION_NAMES.find((name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()));
    throw new MudabValidationError(
      `Invalid options: unknown option ${quoteValue(key)}` +
        (hint === undefined ? `; the options are ${OPTION_NAMES.join(", ")}.` : ` (did you mean ${hint}?).`),
    );
  }
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a MudabValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new MudabValidationError("Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
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
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined. Anything
    // else that is not an object would read as "no options" and drop what the caller meant.
    options = options ?? {};
    if (typeof options !== "object" || Array.isArray(options)) {
      throw new MudabValidationError(
        `Invalid options: expected an object, got ${Array.isArray(options) ? "an array" : typeof options}.`,
      );
    }
    assertKnownOptions(options);
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
    this.#echoed = credentialsIn(this.#baseUrl)
      .flatMap(echoedCredentialForms)
      .sort((a, b) => b.length - a.length);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
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
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning =
      options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport text
   * (fetch's "Failed to fetch <url>") can carry them.
   */
  scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
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
    if (message === cause.message && inner === cause.cause && this.scrub(cause.stack ?? "") === (cause.stack ?? "")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /** `POST <url> failed: `, the start of a network error's message (userinfo redacted, cut). */
  private failedPrefix(method: string, url: string): string {
    return `${method} ${cutForMessage(redactUrl(url))} failed: `;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `MudabNetworkError` only; an injected one may throw anything (a string, a
   * `TypeError` from fetch). Every failure becomes a `MudabNetworkError` — a `MudabError` a
   * caller and the CLI can rely on — that names the request (`POST <url> failed: <reason>`:
   * Node's "socket hang up" or "connect ECONNREFUSED" says nothing about which request
   * failed), with the base URL's credentials scrubbed from its message and the original,
   * scrubbed, as its `cause`; any other `MudabError` passes through.
   */
  private transportError(cause: unknown, method: string, url: string): MudabError {
    if (cause instanceof MudabError && !(cause instanceof MudabNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = cutForMessage(sanitizeServerText(this.scrub(reason)));
    return new MudabNetworkError(`${this.failedPrefix(method, url)}${message}`, { cause: this.scrubCause(cause) });
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
   * The request URL as error messages show it: absolute (so a message names the host that gave
   * a bad answer, which matters with a custom base URL), userinfo redacted and cut at
   * MAX_MESSAGE_VALUE_LENGTH characters.
   */
  describeUrl(path: string): string {
    return cutForMessage(redactUrl(this.buildUrl(path)));
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
        throw this.transportError(cause, method, url);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError (or, without a status, as success).
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new MudabNetworkError(`${this.failedPrefix(method, url)}The transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new MudabNetworkError(`${this.failedPrefix(method, url)}${sizeLimitMessage(this.maxResponseBytes)}`);
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
          await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), url, status);
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
   * `MudabParseError`, not an empty result, and so is a number JSON.parse cannot carry
   * exactly (`firstInexactNumber`): out of a double's range, past 2^53 in any written form,
   * or non-zero and too small, which would print as `null`, a rounded value or 0. Every error
   * about the answer names the request (`POST <url>: …`, userinfo redacted).
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async postJson<T>(path: string, payload: unknown): Promise<T> {
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
    const res = await this.request("POST", path, { accept: "application/json", body });
    const request = `POST ${this.describeUrl(path)}`;
    const decoded = decodeBody(res.data, res.contentType, request);
    const text = decoded.text;
    if (res.status === 204 || text.trim().length === 0) {
      // A broken answer, not "no rows": printed as nothing with exit 0, it would let a script
      // carry on as if the table were empty.
      throw new MudabParseError(`${request}: empty response body.`);
    }
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const repaired = wellFormedEscapes(text);
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      throw new MudabParseError(this.parseFailure(request, res, text, cause), { cause: this.scrubCause(cause) });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    if (inexact !== undefined) {
      throw new MudabParseError(
        `${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`,
      );
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
  }

  /**
   * Why a body is not JSON, for the parse error: the parser's reason, the content type and
   * size, and how the body starts (an HTML maintenance page, a byte-order mark, truncation),
   * all from server text, so control characters are stripped, the parser's reason folded to
   * one line, credentials scrubbed and the whole cut. "Not valid JSON" alone left the user guessing.
   */
  private parseFailure(request: string, res: RawResponse, text: string, cause: unknown): string {
    // V8's reason quotes the body's first characters raw (`"<html>\r\n<h"... is not valid
    // JSON`): fold their line breaks, so the message stays one line.
    const reason = serverTextForMessage(cause instanceof Error ? cause.message : String(cause), MAX_MESSAGE_VALUE_LENGTH);
    const head = text.trimStart();
    const kind = head.startsWith("<")
      ? " It looks like an HTML page (a maintenance or error page from a proxy?), not JSON."
      : "";
    const start = head.length > 80 ? `${cutText(head, 80)}…` : head;
    const contentType = res.contentType === "" ? "no content type" : `content type ${JSON.stringify(res.contentType)}`;
    return cutForMessage(
      sanitizeServerText(
        this.scrub(
          `${request}: the answer is not valid JSON: ${reason}. The reply (${contentType}, ` +
            `${res.data.byteLength} bytes) starts with ${quoteServerText(start)}.${kind}`,
        ),
      ),
    );
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    retryAfterMs?: number,
  ): MudabApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it. A body
    // too large to become a string (above ~512 MiB) is left out rather than crashing here.
    let text = "";
    try {
      text = this.scrub(body.toString("utf8"));
    } catch {
      // ERR_STRING_TOO_LONG: no detail, the status says enough.
    }
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
        detail = snippet.length > MAX_DETAIL_LENGTH ? `${cutText(snippet, MAX_DETAIL_LENGTH)}…` : snippet;
      }
    }
    // Redirects are not followed; name the target so the user can see where it points.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new MudabApiError({ status, url, method, body: text, detail, location, retryAfterMs });
  }
}

/** Node's longest string, in UTF-16 code units (2^29 - 24 on 64-bit builds). */
const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none; the live API declares `application/json;charset=UTF-8`). TextDecoder drops a
 * leading byte order mark, which Buffer#toString keeps and JSON.parse then rejects, so
 * a BOM added by a proxy cannot turn a valid answer into a parse error; a Latin-1 body
 * declared as such keeps its umlauts and `µ`. An unknown charset label is a
 * MudabParseError naming `request` (`POST <url>`). Bytes that are not valid in the charset
 * become U+FFFD, and `replaced` counts them: exactly for UTF-8 and the single-byte charsets; for
 * UTF-16 a U+FFFD the server sent counts too. A body above Node's longest string (about 512 MiB
 * of text) can't be decoded, whatever maxResponseBytes allows, from either decode: a
 * MudabParseError saying so, never a raw ERR_STRING_TOO_LONG ("Unexpected error" on the CLI).
 */
function decodeBody(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new MudabParseError(`${request}: unsupported response charset "${cutText(sanitizeServerText(charset), 100)}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch (err) {
    if (isStringTooLong(err)) throw tooLargeForText(request, body, err);
    // Not valid in the charset: decode with replacement, and count what was replaced.
    let text: string;
    try {
      text = new TextDecoder(decoder.encoding).decode(body);
    } catch (again) {
      if (isStringTooLong(again)) throw tooLargeForText(request, body, again);
      throw again;
    }
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** True for V8's error for a string past its longest one (2^29 − 24 characters on 64-bit). */
function isStringTooLong(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_STRING_TOO_LONG";
}

/** The parse error for a body too large to decode into one string. */
function tooLargeForText(request: string, body: Buffer, cause: unknown): MudabParseError {
  return new MudabParseError(
    `${request}: the answer is too large to read as text (${body.byteLength} bytes; the longest ` +
      `string is ${MAX_STRING_LENGTH} characters, whatever maxResponseBytes allows). Fetch it in ` +
      `pages (range; --from/--count on the CLI).`,
    { cause },
  );
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  let out = "";
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out += json.slice(copied, i) + "\\ufffd";
    copied = i + 6;
    replaced++;
    i += 5;
  }
  return replaced === 0 ? { json, replaced } : { json: out + json.slice(copied), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
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

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"id":
 *   1858054135406919680` becomes `"id":"1858054135406919680"`), so JSON.parse delivers it
 *   exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it (a measured value such as `0.0123`). {@link scanNumbers} without
 * declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
