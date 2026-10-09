// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, the FilterRequest builder, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { MudabClientOptions } from "../client/client.js";
import { MudabError, MudabValidationError } from "../client/errors.js";
import { baseUrlProblem, headerValueProblem } from "../client/validate.js";
import { DEFAULT_BASE_URL, cleartextProblem } from "../client/engine.js";
import { DEFAULT_PAGE_SIZE, MAX_RANGE_END } from "../client/client.js";
import type { ListRequest, Range } from "../client/types.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals (`0x10`, `0b10`, `1e3`), signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  return parseBoundedInt(0, Number.MAX_SAFE_INTEGER)(value);
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * Build a commander value-parser for an integer constrained to [min, max]. A
 * well-formed number that is too large (even beyond 2^53) says so, rather than
 * "Expected a non-negative integer".
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    if (!/^[0-9]+$/.test(value)) {
      throw new InvalidArgumentError("Expected a non-negative integer.");
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    return n;
  };
}

/**
 * commander value-parser for `--from` / `--count`: 0..MAX_RANGE_END (2^31 - 1). The
 * server takes the end of the range as a 32-bit integer and refuses anything larger
 * with an HTML 403 from its front end.
 */
export const parseRangeInt = parseBoundedInt(0, MAX_RANGE_END);

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's `headerValueProblem` (not blank, Latin-1 without control characters;
 * tab is fine), whose reason becomes the usage error. The engine runs the same rule
 * on `userAgent`.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's `baseUrlProblem` rule (an
 * absolute http(s) URL without a query, fragment, surrounding whitespace or control
 * characters), whose reason becomes a usage error at parse time, before any request.
 * The engine enforces the same rule for library callers.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/**
 * Options shared by every list command. Only paging (range) is offered: the API's
 * OpenAPI spec advertises `filter` and `orderby` on every endpoint, but the live
 * server silently ignores both (verified — a filter that should match nothing
 * still returns the full page), so exposing them would be a filter that doesn't
 * filter. Filter/sort client-side instead (e.g. pipe `--compact` output to `jq`).
 */
export interface ListOptions {
  from?: number;
  count?: number;
  all?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): MudabClientOptions {
  const options: MudabClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Add the shared list options (range / filter / orderby) to a command.
 * Kept in one place so every list command exposes an identical surface.
 */
export function addListOptions(cmd: Command): Command {
  return cmd
    .option("--from <n>", `skip this many rows (range.from; from + count at most ${MAX_RANGE_END})`, parseRangeInt)
    .option("--count <n>", `max rows to return (default ${DEFAULT_PAGE_SIZE})`, parseRangeInt)
    .option(
      "--all",
      "return the whole table (omit the range — can be very large; not combinable with --from/--count)",
    );
}

/**
 * Map the parsed list options onto the library's {@link ListRequest}: `--all` becomes
 * `{ all: true }`, `--from`/`--count` the range. The library completes the range to
 * its default page (`from` 0, `count` `DEFAULT_PAGE_SIZE`) and checks it, end of
 * range included, before any request. `--all` with `--from`/`--count` is a usage
 * error here, worded with the flags.
 */
export function buildFilterRequest(opts: ListOptions): ListRequest {
  if (opts.all) {
    if (opts.from !== undefined || opts.count !== undefined) {
      throw new MudabValidationError("--all cannot be combined with --from/--count.");
    }
    return { all: true };
  }
  const range: Range = {};
  if (opts.from !== undefined) range.from = opts.from;
  if (opts.count !== undefined) range.count = opts.count;
  return opts.from === undefined && opts.count === undefined ? {} : { range };
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. Two RangeErrors become a MudabError with a clear
 * message instead of "Unexpected error: …":
 *
 * - an output longer than Node's longest string (about 512 MiB of text, "Invalid string
 *   length") — a big flat table, pretty-printed (which adds about a third), hits it
 *   first, so the pretty message suggests --compact, and both suggest paging;
 * - a deeply nested value (a hostile or broken response) overflows the stack — the
 *   pretty form far sooner than the compact one.
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError && /invalid string length/i.test(err.message)) {
      throw new MudabError(
        "The output is too large to build as one string (Node.js holds at most about 512 MiB of text); " +
          (compact ? "page it with --from/--count." : "try --compact, which is smaller, or page it with --from/--count."),
        { cause: err },
      );
    }
    if (err instanceof RangeError) {
      throw new MudabError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Before the client is built (so before the first request) it logs one
 * WARN record of `mudab.http` to stderr when the base URL is plain `http:` to a host
 * other than loopback (cleartextProblem). Help, version and usage errors never reach
 * an action, so they never warn.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
