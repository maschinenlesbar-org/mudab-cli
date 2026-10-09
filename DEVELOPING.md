# Developing `mudab-cli`

Architecture, testing, and the (many) live-API quirks of the MUDAB
(Meeresumweltdatenbank) API. Read this before changing the client or CLI.

## What this is

A typed client + CLI for the MUDAB REST API, part of the `*-cli` family. It follows
the shared two-layer blueprint (a dependency-free `client/` usable as a library, and
a commander `cli/` over it), with the family's two test seams. Where MUDAB diverges
from the family defaults, this file documents why — **match this repo, not the
generic blueprint.**

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # pretest builds, then `node --test --test-timeout=5000 dist/test/*.test.js`
npm start -- --help # run the built CLI
```

## Layout

```
src/
  client/        # typed API client, usable independently of the CLI
    types.ts     # row-item interfaces + the FilterRequest body
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, POST+JSON, retry/backoff, JSON decode, error mapping
    errors.ts    # MudabError / MudabApiError / MudabNetworkError / MudabValidationError / MudabParseError
    validate.ts  # the Problem type + assertValid(): input rules shared by library and CLI
    client.ts    # MudabClient — one method per endpoint, defensive row extraction
    index.ts
  cli/
    io.ts        # injectable I/O (CliDeps / CliIO), the logger and the clock — no env seam (no auth)
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global->engine mapping, the range builder, JSON render
    commands/list.ts  # every list command + the offline `compartments` table (the library's COMPARTMENT_CODES)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry (exports client + error types)
```

Two seams make it testable in-process: **`Transport`** (the only HTTP seam; tests
inject a mock) and **`CliDeps`** (a client factory + I/O; `run.ts` returns an exit
code rather than calling `process.exit`).

## How the API works (and where it lies)

MUDAB is a `BaseController/FilterElements` service. Every endpoint is a **POST** to
`{base}/{RESOURCE}` with an `application/json` **FilterRequest** body
(`{ filter, range, orderby }`), returning a single-key object wrapping a row array.
**No authentication.** The following were all verified against the live API — the
OpenAPI spec (`bundesAPI/mudab-api`) is unreliable, so trust the live behaviour:

| Quirk | Reality | Where handled |
|---|---|---|
| **Base URL** | `https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements`. The older `MUDABAnwendung` path 301-redirects away. | `engine.ts` `DEFAULT_BASE_URL` |
| **Response wrapper key** | A single-key object, but the key is NOT reliably the path name (`/STATION_SMALL` → key `V_STATION_SMALL`); it is fixed per resource (see `plan.md`). | `client.ts` `WRAPPER_KEYS` (exported) maps each resource to its key; `extractRows` takes the array under that key only (or a bare array), and every row must be an object. An error envelope sent with 200 (`{"errors":[…]}`, `{"error":…}`) is a `MudabApiError` with the server's messages (`reportedErrors`, exported; quoted through `serverTextForMessage`, also exported: whitespace folded to one space, control and bidi characters dropped, cut at 200 characters, so the message stays one clean line); any other reply — another table's rows, an error object, a second key, `null`, a non-object row, an empty body — is a `MudabParseError` naming what came back. Both exit 1, never `[]`. If the live API ever renames a wrapper key, every call on that resource fails with a message naming the new key: update `WRAPPER_KEYS` |
| **`range` requires `from`** | A count-only range (`{count}` without `from`) is answered with **HTTP 500**. | `client.ts` `normalizeRange` always sends `from` (default 0), so `{ range: { count: 5 } }` goes out as `{ from: 0, count: 5 }`, as `--count 5` does |
| **Range end is a 32-bit int** | `from + count` above 2³¹−1 (2147483647) gets an HTML **403 Forbidden** from the front end; on 2026-09-26 the host then stopped answering the client altogether. | `client.ts` `MAX_RANGE_END` + `normalizeRange` (the defaulted count included); the CLI bounds `--from`/`--count` each (exit 2) and reports the library's range-end error as a usage error with an `--all` hint |
| **`range` is the only selection** | The server honours `range` (and nothing else). | `client.ts` `filterList`: a reply with more rows than `range.count` means the range was ignored (for `from` > 0 the rows start at 0), so it is a `MudabParseError` (exit 1) that points at `{ all: true }` / `--all`, never a silently larger page |
| **`filter` / `orderby` ignored** | Despite every endpoint being a "filterbare Liste", the live server **ignores** filter and orderby — a filter that should match nothing still returns the full page. | The CLI exposes NO filter/sort options; `FilterRequest` documents the no-op |
| **`Compartment` enum incomplete** | Spec lists `BL/CW/CS/CF`; the data also contains `MM`. | `types.ts` types `Compartment` as an open `string`; `client.ts` exports the known codes with labels and `parameters()` endpoints as `COMPARTMENT_CODES`, which `mudab compartments` prints |
| **Empty body** | Returns the WHOLE table (measurements ≈ 187,000 rows / 42 MB on 2026-09-15). | The client sends a default page: `normalizeRange` fills `from` 0 and `count` `DEFAULT_PAGE_SIZE` (100); `{ all: true }` (CLI `--all`) sends no range. The CLI passes `--from`/`--count`/`--all` through and has no default of its own |

Redirects are **not** followed — following a cross-origin POST redirect blindly is a
footgun, and the canonical host answers directly. A 3xx surfaces as a `MudabApiError`
(exit 1) whose message names the target (`redirect to <url> not followed`, resolved,
userinfo redacted, sanitised; `location` field); when `--base-url` is not the default,
the CLI adds a hint pointing at the canonical base URL.

## Testing

`node --test` on the compiled `dist/test/` — no jest/vitest. Files:

- `http.test.ts` — the real transport against a loopback `http.createServer` (POST
  with a body, protocol rejection, size cap).
- `engine.test.ts` — POST/JSON, retry, no-redirect, JSON + non-JSON error surfacing,
  parse errors, headers. Uses a mock transport.
- `client.test.ts` — endpoint routing, compartment routing, and the defensive
  `extractRows` (incl. the `V_STATION_SMALL` wrapper-key mismatch, another table's key,
  non-object rows) and the 200 error envelope.
- `cli.test.ts` — the full CLI via `run()` with a mocked client: paging defaults,
  `--all`, `--compartment`, the offline `compartments`, the `--user-agent`
  control-char guard, and exit codes.
- `validate.test.ts` — `assertValid`, the `run.ts` mapping of `MudabValidationError`,
  and the `parity()` helper (`test/helpers.ts`), which sends one input through `run()`
  and through the library, each on a recording mock transport, so a test can assert
  both give the same outcome.
- `io.test.ts` — `handleOutputErrors` and `stderrAfterStdout` on fake streams: a stdout
  write error is an ERROR record of `mudab.output` (the pipe cases are P7's), and a record is
  held behind stdout's backlog.
- `log.test.ts` — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`, `installWarningLog`); the CLI-level checks are P23's.
- `conformance-p*.test.ts` — the workspace's shared conformance checks from the
  2026-10-05 review (P1 credential redaction in CLI output, P2 in library objects, P4 base-URL
  validation, P5 the transport contract, P6 retries, P7 pipes, P8/P9/P13 charset, 2xx
  bodies and error classes); copied across the `*-cli` repos, only the adapter block at
  the top differs. The follow-up round of 2026-10-06 added P20 (a remote plain `http:` base
  URL gets one `WARN` record of `mudab.http` on stderr from the library's `cleartextProblem`, logged by
  `action()` in `shared.ts` before the client is built — so not by the offline `compartments`, which sends nothing; no base-URL variable and no secret
  but the URL's own credentials here, so those two cases are skipped) and P21 (every
  relative link in `README.md` points to a file `package.json` `files` ships, since npmjs.com
  shows the README; other documents are linked by their GitHub URL).

## Conventions to keep

- **Zero runtime HTTP deps** — `node:http`/`https` only; the CLI's only runtime dep is
  `commander`.
- **Strict TS** (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`) and ESM
  (`module: NodeNext`). Keep passing on Node 22/24 (`engines`: `>=22.12`, the floor of
  `commander` 15).
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- **Retry/backoff:** transient `429`/`503` retried up to `maxRetries`. The linear
  backoff (`retryDelayMs * attempt`) is the floor; a `Retry-After` (delay-seconds or an
  IMF-fixdate, parsed strictly by `parseRetryAfter`) can only lengthen a wait, up to
  `MAX_RETRY_AFTER_MS` (30 s). A longer one is not retried: the error surfaces at once,
  names the requested wait and carries it as `MudabApiError.retryAfterMs`. Network failures, resets
  included, are **not** retried: every call is a POST that may fetch a whole table, and
  the host has blocked clients before.
  Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
  `{ retry` (1-based), `maxRetries`, `delayMs`, `status`, `url` (userinfo redacted) `}`) is called
  once per retry right before the sleep, never when there is none, and a throw in it is
  swallowed. The CLI's `action()` sets it to log one `WARN` record of `mudab.http`,
  `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole seconds, ms
  under 1 s). Tests: `test/engine.test.ts`, `test/retry-log.test.ts`.
- **The engine enforces the transport contract** for any transport, not only the
  built-in one: it runs each call under the `timeoutMs` deadline (passing an
  `AbortSignal` as `HttpRequest.signal`, which the built-in transport honours), checks
  the body size against `maxResponseBytes` after the call, reads headers from a
  `Headers` object, a `Map` or any key case (`plainHeaders`), takes any ArrayBuffer view
  or ArrayBuffer as the body (`bodyBytes`), and turns a malformed response (no or a
  non-HTTP status, no headers, another body type) or anything thrown into a
  `MudabNetworkError`. The size-limit message names `maxResponseBytes` and
  `--max-response-bytes`.
- **Bodies are decoded by their declared charset** (`decodeBody` in `engine.ts`):
  `TextDecoder` with the Content-Type's `charset` (UTF-8 when none is named; the live
  API declares `application/json;charset=UTF-8`), a leading byte order mark dropped. An
  unknown charset label is a `MudabParseError`.
- **Library input is checked before any request** (`MudabValidationError`): the numeric
  engine options (`timeoutMs` 0..2³¹−1, `maxRetries` 0..`MAX_RETRIES` = 10 — shared with
  `--max-retries` —, `retryDelayMs` 0..30 000, `maxResponseBytes` 0..2⁵³−1), the
  request's `range` and `all` (see the quirks table; `normalizeRange`, exported, shows
  what a list method sends), `parameters()`'s compartment, and the header options:
  `userAgent` and every `defaultHeaders` value must be non-blank Latin-1 without
  control characters (tab is fine), and header names must be tokens
  (`headerValueProblem`/`headerNameProblem`, exported, which `--user-agent` uses too).
  The default transport also turns a header Node refuses into a `MudabNetworkError`,
  never a raw `TypeError`.
- **Every rejected input is a `MudabValidationError`, every failure a `MudabError`.** A
  list method's request must be an object with only `filter`, `range`, `orderby`, `all`
  (`null`/`undefined` mean no request), and `range` only `from`/`count`: a number, a
  string, an array, or an unknown key (`{ count: 5 }` outside `range`, a misspelled
  `rnage`) is rejected before any request instead of being ignored. The client options
  must be an object (`null` is none), `transport` and `sleep` functions, `defaultHeaders`
  an object. Echoed values and server text are cut at 500 characters (`cutForMessage`,
  `MAX_MESSAGE_VALUE_LENGTH`, exported), and so is every other value an own message quotes
  (a transport's error text, a redirect target — `location` keeps it whole —, a header name,
  a base URL's scheme), so `err.message` stays bounded for a library caller; every cut is made by `cutText` (exported), which never
  splits a surrogate pair, so a message is well-formed; server text an own message
  quotes as a JSON string (a wrapper key, a row's field name, the start of a body) goes
  through `quoteServerText` (exported), which also escapes DEL, C1, U+2028/U+2029 and the bidi
  controls that `JSON.stringify` leaves raw; a string option value is quoted. A body that is
  not JSON names the parser's reason (its line breaks folded, so the message is one line), the content type, the size and how the body starts
  (an HTML page is called one); a body above Node's longest string (~512 MiB) is a
  `MudabParseError` saying so, whatever `maxResponseBytes` allows.
- **Input validation** ([`validate.ts`](src/client/validate.ts)): a rule is a pure
  `<thing>Problem(value)` function that returns why a value is invalid, or `undefined`.
  The library enforces it with `assertValid(name, value, problem)` before any request,
  which throws `MudabValidationError` (extends `MudabError`, exported) with the message
  `Invalid <name>: <reason>`; a method that returns a promise rejects with it. The CLI's
  option parsers call the same `…Problem` functions, so an input gets the same outcome
  on both sides, and `run.ts` reports a `MudabValidationError` raised in an action as a
  usage error (an `ERROR` record of `mudab.cli`, exit 2).
- `--base-url` is trusted input but only `http:`/`https:` is accepted. One rule,
  `baseUrlProblem` (`validate.ts`, exported), covers it: a `file:`, `ftp:` or malformed
  value, a query or fragment (paths are appended as a string, so they would swallow
  every resource path), surrounding whitespace or a control character anywhere
  (`new URL()` drops them silently, but the raw string is what the engine joins), and
  a `%` in the user name or password that doesn't start an escape (write a literal `%`
  as `%25`; Node would fail to decode it for the Authorization header at request time). The
  CLI's `parseBaseUrl` calls it at parse time (usage error); the engine constructor
  checks the raw `baseUrl` before stripping trailing slashes and throws
  `MudabValidationError` (`Invalid baseUrl: <reason>`), so a custom transport never
  receives a bad one. A bad base URL is a configuration error, not a transport
  failure: `MudabNetworkError` is kept for the default transport's per-hop scheme
  check. Userinfo is kept
  for the request and redacted (`redactUrl`) in every error message.
- **No credential in the CLI's output:** `run.ts` (`redactionFor`, `withRedactedOutput`) takes the exact
  userinfo of every URL argument (`credentialsIn`, exported) and replaces it with `***` in
  everything it prints — commander's usage errors, which echo a rejected `--base-url`
  value, and its other messages — so a password with spaces, quotes, `#`, `?` or `/` is
  caught as well as an ordinary one. Only a value that starts with a scheme counts (a bare
  `a:b@c` is a User-Agent or a typed value as often as a credential), except as the
  `--base-url` value, where a `user:password@host` typed without its scheme is still a
  credential. The log replaces them in each record's *message*,
  before the record is cut and escaped, and writes it to the raw stderr: the frame (time,
  level, topic) is never touched, and a password with DEL, C1 or bidi characters is matched
  in its raw form. `redactUrl` (exported) falls back to the same
  text-based cut for a value that doesn't parse as a URL.
- **No credential in a logged client or error:** the engine keeps the base URL in a real
  `#private` field (so `console.log(client)`, `util.inspect` and `JSON.stringify` never
  show it), and scrubs its userinfo (raw and percent-decoded) from error bodies, details
  (a 200 error list's included, `reportedErrors(res, scrub)`),
  transport error text and the `cause` chain — and with it the forms a server echoes it
  back in (`echoedCredentialForms`, exported): the `Authorization: Basic` value, the decoded
  `user:password`, and the password alone from 4 characters on (`redactSecrets`, exported).
  The CLI replaces the Basic value and the pair on stdout and stderr, the bare password on
  stderr only (on stdout a short password may well occur in the data). Whatever a custom transport throws reaches
  the caller as a `MudabNetworkError` (the original, scrubbed, as `cause`).
- **Scaffold origin:** this repo was scaffolded from `entgeltatlas-cli`; the API-key /
  X-API-Key machinery was stripped because MUDAB needs no auth.

## Website

The project website — <https://maschinenlesbar-org.github.io/mudab-cli/> in English and
<https://maschinenlesbar-org.github.io/mudab-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/mudab-cli/
```

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `mudab.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`,
exported from `errors.ts`), and a message longer than `MAX_RECORD_MESSAGE` (4000
characters, exported) is cut at a code point and ends in `… (N more characters)`. The areas are `cli` (usage errors and the `--from`/`--count` range hint,
commander's messages, unexpected errors, an output too large or nested too deeply to
print), `api` (the API's answers: HTTP errors, an error list sent with status 200, a
malformed answer — a `MudabParseError`: bad JSON, the wrong shape, an empty body, more rows
than asked for, an unknown charset, a field beyond the double range — and the
`--base-url` redirect hint), `http` (the connection: network errors, the size-cap hint,
the cleartext warning) and `output` (a failed write to stdout). A failed write to stdout
other than a closed pipe (`handleOutputErrors`, in the bin shim, outside `run()`) is an
ERROR record of `mudab.output` (`Could not write to stdout: …`), and the shim's
last-resort `Unexpected error: …` an ERROR of `mudab.cli`, both in the format argv asks
for and redacted like the run's log (`processLogger`), and so are Node's own process
warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`), WARN records of `mudab.cli`: the shim installs
`installWarningLog`, which removes Node's default `warning` listener and logs
`(node) <name>: <message>`. In `defaultDeps` a record waits for stdout
(`stderrAfterStdout`): it is held while stdout has a backlog and written, in order, once it
is gone, so with `2>&1 |` and a slow reader it never lands inside the data. Code logs through `logOf(deps)` and never writes diagnostics with
`io.err` directly. `run()` builds the logger from argv before commander parses it (`logFormatFromArgv`,
used only for the records of a parse error: it takes the last `--log-format`, as commander
does, and skips the value of the program's own value options, as commander does; a
`preAction` hook then sets the format commander parsed, so `--user-agent
--log-format=jsonl` logs text), so commander's own usage errors are records too: its `error: …` an ERROR of `cli` (a
`(Did you mean …?)` line joined to it), the help it shows after one an INFO record per
line, and a run with global options but no command (`mudab --compact`), or `help` for an
unknown command, an ERROR "missing command: `mudab <subcommand>`" before that help, so
every failed run has an ERROR record (`writeCommanderErr`). The log is built with the
run's redaction
(`withRedactedOutput`), which replaces a secret in the message only, before it is escaped:
the frame is never touched, and a secret is kept out of the log in either format. `CliDeps.now` makes the timestamps
testable. stdout carries data only. Conformance test P23 checks all of this, and its body
is shared across the *-cli repos.
