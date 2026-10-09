// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import { DEFAULT_BASE_URL } from "../client/engine.js";
import {
  MudabApiError,
  MudabError,
  MudabNetworkError,
  MudabValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, a
 * missing resource, a transport failure, and a catch-all.
 */
const EXIT = {
  /** Usage / parse / client-side validation error. */
  USAGE: 2,
  /** 404 — resource not found. */
  NOT_FOUND: 4,
  /** Network / transport failure (DNS, connection, timeout, size-cap). */
  NETWORK: 6,
  /** Any other error. */
  OTHER: 1,
} as const;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints on stdout and stderr. Commander echoes rejected values in its errors
 * (`option '--base-url <url>' argument '…' is invalid`), and its other messages name
 * unknown commands and surplus arguments: whatever path a credential takes, the exact
 * userinfo (as `credentialsIn` finds it, plus its JSON-quoted form) is replaced by `***`.
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without credentials in the arguments the output passes unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  // Every record goes through the redacted `io.err`, so a secret is kept out of the
  // log in either format.
  const redacted = deps;
  deps = {
    ...deps,
    log: createLogger({ format: logFormatFromArgv(argv), write: (line) => redacted.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) }),
  };
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; every genuine usage/parse error maps to a
      // single USAGE code (commander's own exitCode is 1, indistinguishable from
      // the catch-all).
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    const log = logOf(deps);
    // Client-side validation (e.g. --all combined with --from/--count) — a usage error.
    if (err instanceof MudabValidationError) {
      log.error("cli", err.message);
      if (/^Invalid range: from \+ count/.test(err.message)) {
        log.info("cli", "--from + --count is the end of the range; use --all for the whole table.");
      }
      return EXIT.USAGE;
    }
    if (err instanceof MudabApiError) {
      log.error("api", err.message);
      if (err.status === 404) return EXIT.NOT_FOUND;
      // Redirects are not followed; the message names the target. A --base-url other
      // than the canonical one (e.g. the legacy MUDABAnwendung path) is the likely
      // cause, so point there — but not when the default host itself redirected
      // (maintenance, a moved API), where the base URL is not the user's mistake.
      if (err.status >= 300 && err.status < 400) {
        const baseUrl = (program.opts() as { baseUrl?: string }).baseUrl;
        if (baseUrl !== undefined && baseUrl.replace(/\/+$/, "") !== DEFAULT_BASE_URL) {
          log.info("api", `--base-url redirects; the canonical base URL is ${DEFAULT_BASE_URL} (the default).`);
        }
      }
      return EXIT.OTHER;
    }
    if (err instanceof MudabNetworkError) {
      log.error("http", err.message);
      if (/maxResponseBytes/.test(err.message)) {
        log.info(
          "http",
          "The response exceeded the size cap. Narrow with --from/--count " +
            "or raise --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof MudabError) {
      log.error("cli", err.message);
      return EXIT.OTHER;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
