// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, the FilterRequest builder, and JSON rendering.

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { MudabClientOptions } from "@maschinenlesbar.org/mudab-client/internal/client";
import { MudabError, MudabValidationError } from "@maschinenlesbar.org/mudab-client/internal/errors";
import { baseUrlProblem, headerValueProblem } from "@maschinenlesbar.org/mudab-client/internal/validate";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type RetryEvent } from "@maschinenlesbar.org/mudab-client/internal/engine";
import { DEFAULT_PAGE_SIZE, MAX_RANGE_END } from "@maschinenlesbar.org/mudab-client/internal/client";
import type { ListRequest, Range } from "@maschinenlesbar.org/mudab-client/internal/types";

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

/**
 * Make giving a single-value option twice a usage error, on `command` and every subcommand
 * (`--x may be given only once.`, exit 2, no request), instead of commander's "the last one
 * wins": `--timeout 5 … --timeout 60` silently ran with 60. A repeatable option, declared the
 * commander way with an array default (`.option("--tag <t>", …, collect, [])`), is left alone:
 * each value adds to the list; so is a plain flag (`--compact --compact` means the same).
 *
 * A boolean that can be switched both ways is guarded too: an optional-value option
 * (`--x [bool]`) and a negatable pair (`--x` / `--no-x`). commander calls no value parser for a
 * bare `--x`, so `--x false --x` turned into true silently. Those are counted per attribute from
 * commander's `option:<name>` events, which fire for every occurrence. (mudab declares none
 * today; the rule is the kit's.) Call it once on a freshly built program: the check counts per
 * program.
 */
export function forbidRepeatedOptions(command: Command): void {
  const switches = new Set(command.options.filter((o) => o.negate || o.optional).map((o) => o.attributeName()));
  const seen = new Set<string>();
  for (const option of command.options) {
    const attribute = option.attributeName();
    if (switches.has(attribute)) {
      const names = command.options.filter((o) => o.attributeName() === attribute).map((o) => o.long ?? o.short);
      command.on(`option:${option.name()}`, () => {
        if (seen.has(attribute)) command.error(`error: ${names.join(" / ")} may be given only once.`, { code: "commander.optionRepeated" });
        seen.add(attribute);
      });
      continue;
    }
    if (!option.required || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
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

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}

/**
 * Printing the answer failed: it is nested too deeply or too large to print. An ERROR record of
 * `mudab.output`, exit 1.
 */
export class OutputError extends MudabError {}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1)
 * that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print", with
 *   the way out that always helps here, paging with --from/--count.
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hints = [...(!compact && compactPrints(value) ? ["try --compact"] : []), ...(deep ? [] : ["page it with --from/--count"])];
    const hint = hints.length === 0 ? "" : `; ${hints.join(", or ")}`;
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
 * an action, so they never warn; nor does the offline `compartments`, which sends nothing
 * and doesn't run through here.
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
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
