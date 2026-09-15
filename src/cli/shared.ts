// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, the FilterRequest builder, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { MudabClientOptions } from "../client/client.js";
import { MudabValidationError } from "../client/errors.js";
import type { FilterRequest } from "../client/types.js";

/** Default `range.count` — MUDAB returns the WHOLE table when no range is sent. */
export const DEFAULT_COUNT = 100;

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals (`0x10`, `0b10`, `1e3`), signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent).
 * Rejects control characters — a CR/LF (or other C0/DEL byte) would otherwise
 * reach Node's HTTP layer and throw an opaque `ERR_INVALID_CHAR`, which escapes
 * typed-error handling and surfaces as an ugly "Unexpected error". Tab (0x09) is
 * allowed; checked by char code so the source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
  }
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
    .option("--from <n>", "skip this many rows (range.from)", parseIntArg)
    .option("--count <n>", `max rows to return (default ${DEFAULT_COUNT})`, parseIntArg)
    .option(
      "--all",
      "return the whole table (omit the range — can be very large; not combinable with --from/--count)",
    );
}

/**
 * Build the request body from parsed list options — a `range` (paging) only.
 *
 * `range` is omitted entirely with `--all`; otherwise `count` defaults to
 * {@link DEFAULT_COUNT} so a bare command never dumps a whole table, and `from`
 * defaults to 0 (the server answers a count-only range with an HTTP 500).
 */
export function buildFilterRequest(opts: ListOptions): FilterRequest {
  if (opts.all) {
    if (opts.from !== undefined || opts.count !== undefined) {
      throw new MudabValidationError("--all cannot be combined with --from/--count.");
    }
    return {};
  }
  return { range: { from: opts.from ?? 0, count: opts.count ?? DEFAULT_COUNT } };
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

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
