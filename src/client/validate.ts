// Input validation shared by the library and the CLI. Each rule is a pure
// `<thing>Problem(value)` function that returns the reason a value is invalid, or
// undefined when it is valid. The library enforces a rule with assertValid() before
// any request; the CLI's commander parsers call the same function and turn its reason
// into a usage error, so one input gets one outcome on both sides.

import { MudabValidationError, cutForMessage } from "./errors.js";

/** Why `value` is invalid (for example `"Expected a non-empty value."`), or undefined when it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Return `value` when `problem(value)` finds nothing; otherwise throw a
 * {@link MudabValidationError} with the message `Invalid <name>: <reason>`.
 * A client method that returns a promise calls it inside its async body, so a
 * rejected input rejects the promise, and no request is sent.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new MudabValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** A value as it appears in a validation message: strings quoted, the rest as is. */
function show(value: unknown): string {
  return cutForMessage(typeof value === "string" ? JSON.stringify(value) : String(value));
}

/**
 * Why `value` cannot be sent as an HTTP header value (`userAgent`, a `defaultHeaders`
 * value), or undefined when it can: it must be a non-blank string with no control
 * character other than tab (a CR/LF would inject a header into a custom transport)
 * and no DEL, and nothing above U+00FF. Node's HTTP layer refuses those at request
 * time with a raw `TypeError` ("Invalid character in header content"). The engine
 * enforces it, and the CLI's `--user-agent` parser calls it. Checked by char code so
 * the source stays free of control bytes.
 */
export const headerValueProblem: Problem<string> = (value) => {
  if (typeof value !== "string") return `Expected a string, got ${show(value)}.`;
  if (value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** Why `name` cannot be an HTTP header name (an RFC 9110 token, e.g. `X-Trace-Id`), or undefined. */
export const headerNameProblem: Problem<string> = (name) =>
  typeof name === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    ? undefined
    : `Expected an HTTP header name (a token), got ${show(name)}.`;

/**
 * Why `value` cannot be used as the base URL, or undefined when it can. The engine
 * appends every request path to the base URL as a string, so the rules guard the
 * request URL it builds:
 *
 * - it must parse as an absolute URL with an `http:` or `https:` scheme (a `file:` or
 *   `ftp:` base URL would otherwise reach a custom transport that does no such check);
 * - no `?` or `#`: either would swallow every path (`http://h/?x=1` posts to
 *   `/?x=1/STATION_SMALL`, `http://h/#f` to `/`);
 * - no surrounding whitespace and no control character anywhere: `new URL()` trims or
 *   drops them silently, but the raw string is what gets sent, so `"https://h/x "`
 *   would post to `/x%20/STATION_SMALL`.
 *
 * Userinfo (`user:pw@`) is allowed: it is sent as Basic auth and redacted in every
 * error message. A `%` in it must start a valid escape (`%25` for a literal one), as
 * Node decodes it for the Authorization header. The reasons never repeat the value, so a credential in it cannot
 * reach a message. The engine enforces it (`Invalid baseUrl: <reason>`), and the
 * CLI's `--base-url` parser calls it.
 */
export const baseUrlProblem: Problem<string> = (value) => {
  if (typeof value !== "string") return `Expected a string, got ${show(value)}.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${cutForMessage(url.protocol)}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  // Node decodes the userinfo into the Authorization header and throws "URI malformed" for a
  // "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};
