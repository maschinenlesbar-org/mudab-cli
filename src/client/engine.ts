// The request engine: turns logical (method, path, body) calls into HTTP requests
// via a Transport, applies retry/backoff for transient statuses (429, 503), and
// decodes JSON responses.
//
// MUDAB is POST-only with a JSON body (the FilterRequest); every parameter travels
// in the body, so there is no query-string builder. There is no authentication.

import { nodeHttpTransport, type Transport } from "./http.js";
import { MudabApiError, MudabParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements";
const DEFAULT_USER_AGENT = "mudab-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to the canonical geoportal.bafg.de MUDAB base. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Longest error `detail` we keep — a hostile body must not fill the terminal. */
const MAX_DETAIL_LENGTH = 200;

/**
 * Strip C0/C1 control characters (including DEL) out of a string that originates
 * in an attacker-controlled response — the error `detail`. `JSON.parse` decodes a
 * unicode escape such as backslash-u-001b in an error body into a real ESC byte,
 * so without this a hostile or MITM'd endpoint could drive ANSI/OSC escape
 * sequences into the user's terminal when the message is printed to stderr.
 * The success path is already safe (`JSON.stringify` escapes these), so this only
 * needs to cover text that flows into an error message. Checked by char code so
 * the source stays free of control bytes.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
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
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
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
   * surfaces as an error, with a hint to use the canonical base URL.
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
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** POST a JSON payload and parse the JSON reply into `T`. */
  async postJson<T>(path: string, payload: unknown): Promise<T> {
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
    const res = await this.request("POST", path, { accept: "application/json", body });
    const text = res.data.toString("utf8");
    // A 204 or empty body is not a parse failure — surface it as null.
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new MudabParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): MudabApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    if (status >= 300 && status < 400) {
      detail = "unexpected redirect — use the canonical base URL (default " + DEFAULT_BASE_URL + ")";
    } else {
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
          const clean = sanitizeServerText(raw);
          detail = clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
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
    }
    return new MudabApiError({ status, url, method, body: text, detail });
  }
}
