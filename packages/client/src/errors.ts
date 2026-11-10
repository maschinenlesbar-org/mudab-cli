// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo is returned unchanged; one that does not parse has its
 * userinfo cut out by text (`credentialsIn`).
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * A scheme WHATWG parses as special (`ftp`, `file`, `http(s)`, `ws(s)`) at the start of a value,
 * with the slashes and backslashes it skips after it (`http:`, `http:///`, `https:\\` all start
 * the authority): a special scheme's authority starts after them, and also ends at a backslash.
 */
const SPECIAL_SCHEME = /^(?:ftp|file|https?|wss?):[/\\]*/i;

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme counts (`^[A-Za-z][A-Za-z0-9+.-]*://`, or a special one such as `http:` with
 * any slashes or backslashes after it, as WHATWG reads `http:///alice:pw@host` and
 * `http:alice:pw@host`): a bare `a:b@c` is a User-Agent, a typed value or a search text as
 * often as a credential, and the base URL always has a scheme. It works on URLs that don't
 * parse too: the userinfo is everything between the scheme's slashes and the last `@` before
 * the host. Used to redact those exact strings from text that echoes the value (usage errors,
 * help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  // WHATWG skips any number of "/" and "\" after a special scheme, so its userinfo starts after them.
  const special = SPECIAL_SCHEME.exec(value);
  const scheme = special ?? /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#", and for a special scheme such as http(s) a "\", where WHATWG ends
  // it too: `https://u:pw@a.example\@b.example` sends `u:pw` to a.example); in one that doesn't,
  // at the last "@" of the value.
  const end = special !== null ? /[/?#\\]|$/ : /[/?#]|$/;
  const authority = parses ? rest.slice(0, rest.search(end)) : rest;
  const at = authority.lastIndexOf("@");
  return at > 0 ? [rest.slice(0, at)] : [];
}

/**
 * The userinfo of a value meant as a URL (a base URL, a request URL), however its scheme is
 * typed: as `credentialsIn` reads it when the value has a scheme; else as if it had `http://`
 * (`user:password@host`, `TOKEN:@host`); else, for a scheme mistyped before slashes
 * (`http//user:pw@host` with the colon left out, `http/…`, `htp:/…`), everything between the
 * first run of slashes or backslashes and the last `@`, as `credentialsIn` reads a URL that
 * doesn't parse. Such a value is refused, but the refusal (commander's, the transport's) quotes
 * it, so its userinfo has to be found to be redacted. Only for a value known to be a URL: in
 * other text a bare `a/b@c` is no credential.
 */
export function typedUrlCredentials(value: string): string[] {
  if (value === "" || credentialsIn(value).length > 0 || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return credentialsIn(value);
  const prefixed = credentialsIn(`http://${value}`);
  if (prefixed.length > 0) return prefixed;
  const slashes = /[/\\]+/.exec(value);
  const at = value.lastIndexOf("@");
  if (slashes === null || slashes.index + slashes[0].length >= at) return [];
  return [value.slice(slashes.index + slashes[0].length, at)];
}

/** A character a URL scheme may hold after its first letter (RFC 3986: ALPHA / DIGIT / "+" / "-" / "."). */
function isSchemeChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/** An ASCII letter, with which a scheme starts. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Where the scheme of the `://` at `at` starts: the first letter of the run of scheme characters
 * before it, looking back no further than `from`; -1 when there is none (`1://`, ` ://`). A run
 * led by other scheme characters (`-https://`) starts at its first letter.
 */
function schemeStart(text: string, at: number, from: number): number {
  let start = at;
  while (start > from && isSchemeChar(text.charCodeAt(start - 1))) start--;
  while (start < at && !isLetter(text.charCodeAt(start))) start++;
  return start < at ? start : -1;
}

/**
 * `text` with the userinfo of every URL in it replaced by `***` (`https://user:secret@host`
 * becomes `https://***@host`): the pattern backstop for text no exact secret matches. Text-based,
 * so it also covers a URL that does not parse; the userinfo ends at the last `@` before the first
 * whitespace, `/`, `?`, `#` or `'` after `://`. Linear in `text`, however many URLs it holds: each
 * `://` is found with `indexOf`, its scheme by walking back no further than the previous `://`,
 * and the search goes on right after each `://` (as the CLI's `urlsWithin`), not after the
 * authority it read: a URL glued onto the one before it (`https://host://u:p@h`,
 * `https://u:p@x://v:q@w`) starts inside that authority, which ends at its `/`. An authority holds
 * no `/`, so no `://` lies wholly inside one, and every character is read a bounded number of
 * times: by the authority loop and `indexOf` forwards, by `schemeStart` backwards.
 */
export function redactUrlUserinfo(text: string): string {
  const parts = new TextBuilder();
  let copied = 0;
  let from = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", from)) {
    const begin = at + 3;
    let end = begin;
    let lastAt = -1;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x27 || /\s/.test(text[end] as string)) break;
      if (c === 0x40) lastAt = end;
    }
    if (lastAt !== -1 && schemeStart(text, at, from) !== -1) {
      parts.push(text.slice(copied, begin), "***");
      copied = lastAt;
    }
    from = begin;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.toString();
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a text and their replacements), joined in
 * batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text, not to
 * the number of pieces: one `+=` per piece makes a rope node each, and one array of every piece
 * a slot each.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body, in this order: the
 * `Authorization: Basic` value (base64 of the decoded `user:password`, UTF-8 as Node's transport
 * sends it), the decoded `user:password` itself, and the secret alone when it is at least 4
 * characters long. The secret is the password; in a userinfo without one (`TOKEN@host`,
 * `TOKEN:@host`) it is the user name, a token, which Node sends as Basic `TOKEN:`. `[]` for an
 * empty userinfo. None of them has an `@` to anchor on, so they are replaced as exact strings
 * ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? "" : decode(userinfo.slice(colon + 1));
  const secret = password === "" ? user : password;
  if (secret === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (secret.length >= 4) forms.push(secret);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the escaped forms of each credential, as its messages escape values.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * Longest echoed value or server text (in characters) an error message shows. A huge
 * input would otherwise put itself whole on one stderr line, and server text could flood
 * a CI log. Properties such as `MudabApiError.body` keep the full value.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters (never inside a surrogate pair), ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${cutText(text, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it leaves
 * raw although a terminal acts on it or a reader can't see it: DEL, the C1 controls, every
 * Unicode format character (bidi overrides, zero-width characters, the soft hyphen), the line and
 * paragraph separators U+2028/U+2029, and a lone surrogate (half a character). A compartment
 * with a zero-width space then reads `"wasser\u200b"`, not `"wasser"`, so the user can see why it
 * was refused. A value longer than MAX_MESSAGE_VALUE_LENGTH characters is cut, and the "…" goes
 * after the closing quote (`"AAAA"…`), so it does not read as part of the value. The quoted part
 * stays a valid JSON string.
 */
export function quoteValue(value: string): string {
  const cut = value.length > MAX_MESSAGE_VALUE_LENGTH;
  let out = "";
  for (const ch of JSON.stringify(cut ? cutText(value, MAX_MESSAGE_VALUE_LENGTH) : value)) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return cut ? `${out}…` : out;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Base class for every error originating from this client. */
export class MudabError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present. For a 3xx — the
 * client does not follow redirects — `location` holds the redirect target
 * (absolute, sanitised, userinfo redacted, the base URL's credentials scrubbed) and the
 * message names it.
 */
export class MudabApiError extends MudabError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  /**
   * The body as the server sent it, the base URL's credentials scrubbed. A JSON body that spells
   * one with escapes (`\"`, `\u00e4`) is kept as its decoded JSON written again, scrubbed; such a
   * body too deeply nested to write again is left out (""). For an error list sent with 200, the
   * decoded answer written again (`JSON.stringify`), scrubbed.
   */
  readonly body: string;
  readonly location: string | undefined;
  /**
   * For a 429/503 that was not retried because its `Retry-After` asked for longer than the
   * client waits (`MAX_RETRY_AFTER_MS`): the requested wait in milliseconds.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    retryAfterMs?: number;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.retryAfterMs !== undefined) {
      parts.push(
        `the server asks to retry after ${Math.ceil(args.retryAfterMs / 1000)} s, longer than ` +
          `the 30 s this client waits, so it was not retried (more retries won't help; try again later)`,
      );
    }
    if (args.status >= 300 && args.status < 400) {
      parts.push(
        args.location
          ? `redirect to ${cutForMessage(args.location)} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    super(`HTTP ${args.status} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class MudabNetworkError extends MudabError {}

/**
 * A rejected input (a bad option, range or compartment), raised by the library before
 * any request is made. Every library-side input rule throws it, with the message
 * `Invalid <name>: <reason>`; the CLI reports it as a usage error (exit 2).
 */
export class MudabValidationError extends MudabError {}

/** The response body could not be parsed as the expected JSON shape. */
export class MudabParseError extends MudabError {}
