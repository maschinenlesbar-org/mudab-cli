# Developing `mudab-cli`

Architecture, testing, and the (many) live-API quirks of the MUDAB
(Meeresumweltdatenbank) API. Read this before changing the client or CLI.

## What this is

A typed client + CLI for the MUDAB REST API, part of the `*-cli` family. It follows
the shared two-layer blueprint (a dependency-free client, `packages/client`, usable as a
library, and a commander CLI, `apps/cli`, over it), with the family's two test seams.
Where MUDAB diverges from the family defaults, this file documents why — **match this
repo, not the generic blueprint.**

## Commands

```bash
npm install
npm run build       # compiles every workspace (tsc -b) to its dist/
npm run typecheck   # tsc -b over every workspace, as build
npm test            # pretest builds, then `node --test` over each workspace's dist/test
npm run coverage    # the same tests in one run, with a coverage report
npm start -- --help # run the CLI from the build (node apps/cli/dist/src/cli/index.js)
npm run bump -- <patch|minor|major>  # bump every published app (apps/cli, apps/mcp), commit, tag vX.Y.Z
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

CI (`ci.yml`) type-checks, builds and tests on Node 22/24/26, then packs each published app
(the CLI and the MCP server), checks the pack left nothing behind, installs it globally with the
registry out of reach and runs its bins; its `interop` job runs the MCP server against the
official MCP client. `images.yml` builds, smoke-tests and scans both container images on every
push and weekly (see [Container image](#container-image)). `release.yml` (on a `v*` tag, made by `npm run bump`) has three jobs. **pack**
(read-only): verify the tag against `apps/cli/package.json`, test, `npm pack --workspace
apps/cli`, record the tarball's and the notes' sha256 as job outputs. **sbom** (read-only):
`npm ci --ignore-scripts`, then the CycloneDX tool from the isolated, lockfile-pinned
`tools/sbom/` (`npm ci --ignore-scripts --prefix tools/sbom`, run from its `node_modules/.bin`,
never `npx`), two SBOMs scoped to the `apps/cli` workspace. **release** (the only job with
`contents: write`): download both artifacts, check them against the pack job's digests, create
the GitHub Release with `gh`. So no third-party code runs where the tarball is built or where
the write token is. Update the tool by changing its version in `tools/sbom/package.json` and
running `npm install --package-lock-only --ignore-scripts` there; don't chain its install into
an npm script. Conformance test P31 (`apps/cli/test/conformance-p31-release-pipeline.test.ts`)
reads the workflow and the lockfile and checks it. The release also carries both image archives,
their SBOMs, `SHA256SUMS` and signed provenance. `publish.yml` (manual dispatch from the tag)
publishes the release's own files: both tarballs to npm via OIDC Trusted Publishing with
provenance, and both images to ghcr.io, each checked first against the immutable release and the
provenance `release.yml` signed.

## Layout

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/mudab-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/mudab-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/mudab-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers and fixtures (a mock of the API)
apps/mcp/            # @maschinenlesbar.org/mudab-mcp — the MCP server, released with the CLI
packages/log/        # the log records (text/jsonl), shared by both apps
tools/image/         # the container images of both apps (build, push, smoke, SBOM)
tools/interop/       # the built MCP server against the official MCP client (own lockfile)
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag of every published app (npm run bump)
tools/sbom/          # the CycloneDX SBOM tool, own lockfile (release.yml's sbom job only)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so the MCP app shares it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { MudabClient } from
  "@maschinenlesbar.org/mudab-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/mudab-client/internal/engine`) for what the CLI
  needs beyond that; `"./test/*"` reaches the client's test helpers and fixtures from the
  CLI's tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`** (and, the same, in `apps/mcp/package.json`).
  The root has none; a plain `npm version` at the root is refused. Release with
  `npm run bump -- <patch|minor|major>`, which bumps every published app together, commits (the
  bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    types.ts     # row-item interfaces + the FilterRequest body
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, POST+JSON, retry/backoff, JSON decode, error mapping
    errors.ts    # MudabError / MudabApiError / MudabNetworkError / MudabValidationError / MudabParseError
    validate.ts  # the Problem type + assertValid(): input rules shared by library and CLI
    client.ts    # MudabClient — one method per endpoint, defensive row extraction
    operations.ts # the skills' use cases: findStations / findParameters / getMeasurements / getRiverLoads / listRows
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O (CliDeps / CliIO), the logger and the clock — no env seam (no auth)
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global->engine mapping, the range builder, JSON render
    commands/list.ts  # every list command + the offline `compartments` table (the library's COMPARTMENT_CODES)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
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
userinfo redacted, the base URL's credentials scrubbed in its path and query before it is
resolved, sanitised; `location` field); when `--base-url` is not the default,
the CLI adds a hint pointing at the canonical base URL.

## Testing

`node --test` on each workspace's compiled `dist/test/` — no jest/vitest. The client's
tests are in `packages/client/test/` (`http`, `engine`, `client`, `operations`), with the transport
helpers and the fixtures (`helpers.ts`, `fixtures.ts`, and the mock API `tables.ts`, see
[MCP server](#mcp-server-appsmcp)); everything that drives the CLI is
in `apps/cli/test/`, and `apps/cli/test/helpers.ts` re-exports the client's helpers next
to the CLI's own. Files:

- `http.test.ts` — the real transport against a loopback `http.createServer` (POST
  with a body, protocol rejection, size cap).
- `engine.test.ts` — POST/JSON, retry, no-redirect, JSON + non-JSON error surfacing,
  parse errors, headers. Uses a mock transport.
- `client.test.ts` — endpoint routing, compartment routing, and the defensive
  `extractRows` (incl. the `V_STATION_SMALL` wrapper-key mismatch, another table's key,
  non-object rows) and the 200 error envelope.
- `types.test.ts` — the exported option types: a consumer compiled by `tsc` with
  `exactOptionalPropertyTypes` passes `undefined` for every optional field of `EngineOptions`,
  `ListRequest`, `FilterRequest`, `Range`, `Filter` and `OrderBy` (each is `?: T | undefined`; it
  starts a process, so it gets 30 s), and a runtime check that `undefined` means the default.
- `cli.test.ts` — the full CLI via `run()` with a mocked client: paging defaults,
  `--all`, `--compartment`, the offline `compartments`, the `--user-agent`
  control-char guard, and exit codes.
- `validate.test.ts` — `assertValid`, the `run.ts` mapping of `MudabValidationError`,
  and the `parity()` helper (`apps/cli/test/helpers.ts`), which sends one input through `run()`
  and through the library, each on a recording mock transport, so a test can assert
  both give the same outcome.
- `io.test.ts` — `handleOutputErrors` and `stderrAfterStdout` on fake streams: a stdout
  write error is an ERROR record of `mudab.output` (the pipe cases are P7's), and a record is
  held behind stdout's backlog.
- `log.test.ts` — the record helpers of `apps/cli/src/cli/log.ts` on their own
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
  shows the README; other documents are linked by their GitHub URL). The kit round of 2026-10-21 added P24 (an input is
  canonicalised or refused, a refusal shows an invisible character escaped: its adapter lists no
  text filter and no list, since the CLI has neither — the server ignores filters —, and one
  token, `--compartment`, read back from the endpoint path it picks) and P25 (a number
  the answer can't carry exactly, or an empty answer, is exit 1 with an ERROR record of
  `mudab.api` naming the request, checked on `stations --all`). The fix round of 2026-10-21
  (`.reviews/2026-10-21-exploratory/fix-plan.md`) added P27, big and odd answers: a large flat
  answer and one full of DEL characters print within a small heap, or past V8's longest string are
  one ERROR record of `mudab.output`; a lone surrogate or invalid bytes are replaced with U+FFFD
  and reported in a WARN of `mudab.api`; an answer in two million one-byte chunks is read within
  a 256 MB heap (the built-in transport joins small chunks as they arrive, `COALESCE_CHUNKS` /
  `COALESCE_BYTES`, so its memory follows the bytes, not the chunk count) (it starts the built
  bin, so 30 s). P26 output integrity:
  mudab has no `-o`, so its adapter sets `HAS_OUTPUT_OPTION = false` and only the stdout case
  runs (stdout redirected to a file and cut short under `ulimit -f` exits 1 with an ERROR record
  of `mudab.output`, never 0).
- **P28–P31** (security audit 2026-10-27, reference `create-cli-template`): P28 hostile error
  answers (the number scan and server-text cleaning linear and memory-bounded; the base URL's
  credential scrubbed from decoded text, from a 2xx value the client quotes — `quotedBody` is an
  object that is not the row wrapper, whose `message` the shape error quotes — and from a
  redirect's Location; `REDIRECT_ERROR` is `HTTP 302`, as redirects are not followed). Its
  lone-surrogate case is skipped: the body reads the WARN of a GET and every MUDAB call is a POST;
  `hostile-error-answers.test.ts` runs the same case with POST, next to the large plain-text and
  error-envelope bodies. P29 base-URL credentials (a token userinfo scrubbed, a backslash and a
  scheme without exactly `//` refused, requests to the parsed host, linear stdout redaction). P30
  output links: no `-o`, so `HAS_OUTPUT_OPTION = false` with stand-ins for the kit's `io.ts` types,
  and every case is skipped. P31 the release pipeline (no adapter).

## Conventions to keep

- **Zero runtime HTTP deps** — `node:http`/`https` only; the CLI's only runtime dep is
  `commander`.
- **Strict TS** (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`) and ESM
  (`module: NodeNext`). Keep passing on Node 22/24/26 (`engines`: `>=22.12`, the floor of
  `commander` 15).
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- **One value per option** (`forbidRepeatedOptions`, `shared.ts`, run by `buildProgram` over the
  whole tree): a single-value option given twice is a usage error (`--x may be given only
  once.`, exit 2, no request), never commander's "the last one wins". Flags may repeat. A
  boolean that can be switched both ways (an optional value `--x [bool]`, or a pair `--x` /
  `--no-x`; mudab has none today) may be given only once, counted per attribute through
  commander's `option:<name>` events. An
  option meant to be repeated would be declared with an array default (`collect, []`); there
  is none today.
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
  under 1 s). Tests: `packages/client/test/engine.test.ts`,
  `apps/cli/test/retry-log.test.ts`.
- **The engine enforces the transport contract** for any transport, not only the
  built-in one: it runs each call under the `timeoutMs` deadline (passing an
  `AbortSignal` as `HttpRequest.signal`, which the built-in transport honours), checks
  the body size against `maxResponseBytes` after the call, reads headers from a
  `Headers` object, a `Map` or any key case (`plainHeaders`), takes any ArrayBuffer view
  or ArrayBuffer as the body (`bodyBytes`), and turns a malformed response (no or a
  non-HTTP status, no headers, another body type) or anything thrown into a
  `MudabNetworkError`. The size-limit message names `maxResponseBytes` and
  `--max-response-bytes`; the default `timeoutMs` is `DEFAULT_TIMEOUT_MS` (30 000, exported, shown
  in `--help`), for the whole response, and a timeout gets an INFO record of `mudab.http` in
  `run.ts` naming `--timeout`, its value and the way out. Every network error names the request, like
  `POST https://***@host/…/STATION_SMALL failed: <reason>` (userinfo redacted, the URL cut at 500
  characters): a timeout, the size cap, a reset or refused connection, a DNS failure and an
  invalid transport response; the original error, scrubbed, is its `cause`.
- **Numbers are carried exactly or refused.** `JSON.parse` turns a number out of a double's
  range into Infinity (printed as `null`), rounds one past 2^53 (`12345678901234567890`, also as
  `…890.0`, `9007199254740993e0`, `9007199254740992.5`), turns a non-zero one too small
  (`1e-400`) into 0 and a subnormal into the nearest one it can hold (`3e-324` into `5e-324`), all
  silently. `postJson` scans the text once before parsing
  (`scanNumbers`, `exactAtTheEdges` in `engine.ts`; it skips strings) and makes such an answer a
  `MudabParseError` (exit 1): `POST <url>: the number <N> cannot be represented exactly.` Past 2^53 the check compares the number as written with the number as
  printed (`String(value)`, `decimalOf`): `1E23` or `1.7976931348623157E308`, a double a server
  printed in its shortest form, prints as the same number and passes. So does a subnormal (below
  2.2250738585072014e-308, the smallest normal double, `MIN_NORMAL`), where a double has fewer
  digits: `5e-324` and `1e-310` pass, `3e-324` is refused. Between those, below 2^53, a decimal fraction keeps a double's precision, as JSON means
  it, so the measured values (`VALUE_MS`, `VALUE`) pass as they are; no MUDAB field is a number
  past 2^53 (ids are small integers). `extractRows` still refuses a non-finite field in rows a
  library caller hands it. The one exception is the engine option `bigIntegerKeys` (a set or list
  of non-empty member names, copied; default none, and mudab declares none): the number value of a
  declared member is delivered as its exact literal, as written, as a JSON string
  (`"1858054135406919680"`, `"5"`), whatever its size, so its type is stable. The same scan quotes
  those values in place before `JSON.parse` (no reviver); P25 checks it with `BIG_INTEGER_KEYS`.
- **Bodies are decoded by their declared charset** (`decodeBody` in `engine.ts`):
  `TextDecoder` with the Content-Type's `charset` (UTF-8 when none is named; the live
  API declares `application/json;charset=UTF-8`), a leading byte order mark dropped. An
  unknown charset label is a `MudabParseError`. **Text is never changed silently:** the decode is
  fatal first; bytes not valid in the charset are then decoded with U+FFFD and counted (a U+FFFD
  the server sent is not), and a lone surrogate written as a JSON escape (`\ud800`, which
  `JSON.parse` would make half a character and `jq` refuse) is rewritten as `\ufffd`
  (`wellFormedEscapes`, one linear pass, only when the text holds a surrogate escape). The
  answer is delivered, and the engine option `onWarning` is told `POST <url>: N characters of the
  answer were not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`; the
  CLI's `action()` logs it as a `WARN` record of `mudab.api` (exit 0). A body too large for one
  string (V8's `ERR_STRING_TOO_LONG`, from either decode) is the `MudabParseError` below.
- **Library input is checked before any request** (`MudabValidationError`): the numeric
  engine options (`timeoutMs` 0..2³¹−1, `maxRetries` 0..`MAX_RETRIES` = 10 — shared with
  `--max-retries` —, `retryDelayMs` 0..30 000, `maxResponseBytes` 0..2⁵³−1), the
  request's `range` and `all` (see the quirks table; `normalizeRange`, exported, shows
  what a list method sends), `parameters()`'s compartment (`compartmentProblem`, exported, which
  `--compartment` uses too: a token by the kit's rule, `tokenProblem` — not blank, not only
  invisible characters or combining marks, no control or format character such as a zero-width
  space or soft hyphen, no lone surrogate —, compared after `normalizeToken`, trim and NFC, with
  the four names; `" wasser "` is `wasser`, `"wasser\u200b"` is refused), and the header options:
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
  must be an object (`null` is none) with only the `EngineOptions` names (`assertKnownOptions`:
  a misspelled `timeout` for `timeoutMs` is `Invalid options: unknown option "timeout" (did you
  mean timeoutMs?).`, not silently the default; a key set to `undefined` passes), `transport`,
  `sleep`, `onRetry` and `onWarning` functions, `defaultHeaders` an object. Server text an own
  message carries as text — an error `detail`, a plain-text error body, a transport's error text,
  a redirect target — goes through `sanitizeServerText` (exported from `engine.ts`): whole escape
  sequences (CSI, OSC and other control strings, a control string ending at its terminator, an ESC
  or the next introducer, so the pattern is linear in the text) dropped, then C0, C1, DEL and every format
  character (bidi controls, zero-width characters, the soft hyphen), and whitespace folded to one
  space, so `err.message` is one clean line a library caller can print as it is (a forged
  `Error:` line, `[31m` remnants or a live RLI can't get through). It reads at most the first
  16 384 characters of the text (`serverTextForMessage` too) and is linear in them, so a large
  error body costs neither seconds nor the heap. Echoed values and server text are cut at 500 characters (`cutForMessage`,
  `MAX_MESSAGE_VALUE_LENGTH`, exported), and so is every other value an own message quotes
  (a transport's error text, a redirect target — `location` keeps it whole —, a header name,
  a base URL's scheme), so `err.message` stays bounded for a library caller; every cut is made by `cutText` (exported), which never
  splits a surrogate pair, so a message is well-formed; server text an own message
  quotes as a JSON string (a wrapper key, a row's field name, the start of a body) goes
  through `quoteServerText` (exported), which also escapes DEL, C1, U+2028/U+2029 and the bidi
  controls that `JSON.stringify` leaves raw; a string option value is quoted, and a refused input
  value with `quoteValue` (exported), which escapes DEL, C1, U+2028/2029, every format character
  and a lone surrogate, so a refusal shows why (`"wasser\u200b" contains an invisible or control
  character (U+200B).`). commander's own echo of a rejected value (`argument '…' is invalid`) is
  escaped the same way in `run.ts` (`escapeCommanderError`), and the redaction knows a secret's
  escaped form. `validate.ts` also has the kit's `splitList` and `listProblem` (exported; no mudab
  command takes a list). **Every error about
  an answer names the request**, `POST <url>: …` (`describeUrl`: the absolute URL, userinfo
  redacted, cut at 500 characters), as a network error does: an empty body, a body that is not
  JSON, an unknown charset, a number that can't be carried exactly, the wrong shape (`extractRows`,
  which takes the request as its third argument), a non-finite field, more rows than asked for,
  and a body too large to read as text. A body that is
  not JSON (`POST <url>: the answer is not valid JSON: <reason>. …`) names the parser's reason (its line breaks folded, so the message is one line), the content type, the size and how the body starts
  (an HTML page is called one); a body above Node's longest string (~512 MiB) is a
  `MudabParseError` saying so (`POST <url>: the answer is too large to read as text (N bytes; …)`),
  whatever `maxResponseBytes` allows.
- **Input validation** ([`validate.ts`](packages/client/src/validate.ts)): a rule is a pure
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
  every resource path), a backslash (WHATWG ends an http(s) host at one, text-based code
  reads on: `https://u:pw@a.example\@b.example`), surrounding whitespace or a control
  character anywhere (`new URL()` drops them silently), a `%` in the user name or password
  that doesn't start an escape (write a literal `%` as `%25`; Node would fail to decode it for
  the Authorization header at request time), and a scheme not followed by exactly `//` and
  the host (`http:host`, `http:/host`, `http:///host`, which WHATWG repairs silently:
  `Expected an absolute http(s) URL ("https://" and the host).`). The engine requests the base
  URL as WHATWG parses it (`new URL(baseUrl).href`: host lower-cased, a default port dropped,
  the path percent-encoded where WHATWG does it), the reading every check makes, and
  `credentialsIn` reads a userinfo where WHATWG does: after any slashes and backslashes a
  special scheme skips (`http:///u:pw@h`), up to a backslash too. The
  CLI's `parseBaseUrl` calls it at parse time (usage error); the engine constructor
  checks the raw `baseUrl` before stripping trailing slashes and throws
  `MudabValidationError` (`Invalid baseUrl: <reason>`), so a custom transport never
  receives a bad one. A bad base URL is a configuration error, not a transport
  failure: `MudabNetworkError` is kept for the default transport's per-hop scheme
  check. Userinfo is kept
  for the request and redacted (`redactUrl`) in every error message.
- **No credential in the CLI's output:** `run.ts` (`redactionFor`, `withRedactedOutput`) takes the exact
  userinfo of every URL argument (`credentialsIn`, exported; a base URL is read as a URL however its scheme is typed,
`typedUrlCredentials`: missing, `alice:pw@host`, or mistyped, `http//alice:pw@host` with the
colon left out, whose userinfo is everything between the first slashes and the last `@`) and replaces it with `***` in
  everything it prints — commander's usage errors, which echo a rejected `--base-url`
  value, and its other messages — so a password with spaces, quotes, `#`, `?` or `/` is
  caught as well as an ordinary one. Only a URL with a scheme counts (a bare
  `a:b@c` is a User-Agent or a typed value as often as a credential), except as the
  `--base-url` value, where a `user:password@host` typed without its scheme is still a
  credential. It is found anywhere in an argument (`urlsWithin`), not only at its start: a
  padded `" https://user:pw@host"`, one after a dash or inside a phrase is echoed by a refusal
  (a `--compartment`, a `--base-url`), by commander or as a surplus argument just the same. Each `://` is found with `indexOf` and its scheme by walking back, so the search stays linear in a long argument, and at most 64 URLs are read from one argument. Behind the exact strings, the userinfo of any URL in the printed text is replaced too (`redactUrlUserinfo`, `internal/errors`), in one linear pass over the text: stdout carries the whole answer, and the regex it replaced was quadratic in a run like `a.a.a…`. The log replaces them in each record's *message*,
  before the record is cut and escaped, and writes it to the raw stderr: the frame (time,
  level, topic) is never touched, and a password with DEL, C1 or bidi characters is matched
  in its raw form. `redactUrl` (exported) falls back to the same
  text-based cut for a value that doesn't parse as a URL.
- **No credential in a logged client or error:** the engine keeps the base URL in a real
  `#private` field (so `console.log(client)`, `util.inspect` and `JSON.stringify` never
  show it), and scrubs its userinfo (raw and percent-decoded, as typed and as WHATWG sends it)
  from error bodies, details (a 200 error list's included, `reportedErrors(res, scrub)`), the
  server text a shape or parse error quotes (`extractRows(res, path, request, scrub)`: keys, a
  message, a field name; the start of a body that is not JSON, its content type and charset),
  transport error text and the `cause` chain — and with it the forms a server echoes it
  back in (`echoedCredentialForms`, exported): the `Authorization: Basic` value, the decoded
  `user:password`, and the password alone from 4 characters on — for a userinfo without a
  password (`https://TOKEN@host`, `TOKEN:@host`) the user name, a token, which Node sends as
  Basic `TOKEN:` (`redactSecrets`, exported), each
  matched whole (a password with an inner space too), percent-encoded as in a URL and escaped as
  in a JSON string. Server text is scrubbed *before* it is cut or quoted, and decoded text
  (a JSON `detail`) again after decoding: a JSON escape (`\"`, `\u00e4`) hides an echo from the
  scrub of the body as sent. `MudabApiError.body` stays as sent (scrubbed) unless it is JSON whose
  decoded text still holds an echoed form behind an escape; then it is the decoded JSON written
  again (`JSON.stringify`) with the form replaced, and `""` for such a body too deeply nested to
  write again (`scrubBody`).
  The CLI replaces the Basic value and the pair on stdout and stderr, the bare password (or token) on
  stderr only (on stdout a short password may well occur in the data). Whatever a custom transport throws reaches
  the caller as a `MudabNetworkError` (the original, scrubbed, as `cause`).
- **Printing JSON** (`renderJson`, `shared.ts`): `escapeControlChars` writes the characters
  `JSON.stringify` leaves raw although a terminal acts on them — DEL, C1 (U+0080–U+009F) and the
  bidi controls (`isBidiControl`, exported from `engine.ts`) — as `\uXXXX`. It measures the
  escaped length first (past V8's longest string it is an `OutputError`, "The answer is too large
  to print (N characters once its control characters are escaped)") and builds the text in 64 Ki
  chunks joined once, so an answer full of DEL characters prints within a small heap instead of
  crashing it. Pretty by default. An answer that can't be printed is an
  `OutputError`, an ERROR record of `mudab.output` (exit 1) that names the cause, never a stack
  trace: "nested too deeply" (the stack overflowed) or "too large (more than 536870888 characters
  of JSON)" (V8's longest string, `Invalid string length`), which adds "page it with
  --from/--count". "try --compact" is added only when the compact form of that very answer prints
  (`compactPrints`, probed, not assumed from the Node version). `--compact` takes V8's fast path (`JSON.stringify(value)`) unless the
  answer holds a string or key of 64 Mi characters or more (`holdsHugeString`: iterative, walks arrays by index and objects with `for…in`, no allocation
  per value), which goes
  through the gap path (`JSON.stringify(value, null, "")`, the same text): on Node 26 the fast
  path aborts the process on a ~250 MB string, but only it prints very deep nesting there.
- **Scaffold origin:** this repo was scaffolded from `entgeltatlas-cli`; the API-key /
  X-API-Key machinery was stripped because MUDAB needs no auth.

## MCP server (apps/mcp)

`apps/mcp` is the second published app, `@maschinenlesbar.org/mudab-mcp` (bin `mudab-mcp`),
released in lockstep with the CLI: `npm run bump` bumps every published app under `apps/`
together, one version, one tag. Its npm README is the root `MCP.md` (prepack packs `<APP>.md`
for an app that has one).

| Module | Role |
|---|---|
| `packages/client/src/operations.ts` | The skills' use cases as library functions, with their traps built in. The server filters nothing, so each reads its table with `readPages` (one ranged POST after the other, `PAGE_ROWS` rows each so a page stays under ~7 MB: measurements 30,000, stations 60,000, the PLC values 25,000, the small tables one page; up to `maxPages`, else said to be incomplete) and selects here. `findStations` (mudab-stations): measurement stations once per name (the table repeats rows and lists a station per compartment; `total` counts names, `rows` table rows), with their compartments and types and the regions and institutes of their project station (joined on `NAME_PS`; a name with several, such as L1 (BSH/Nordsee and IOW/Ostsee), keeps all, said in notes); project stations by name, region, institute; HELCOM PLC stations once per code (the table repeats them, some under XX as well as their Land), by station, river or code, Land, monitoring type, with coordinates missing and the two pseudo-stations said. `findParameters` (mudab-parameters): reads every compartment's own list and the combined table, so a parameter names every compartment that measures it (the combined table puts mercury under biota only); English names (an empty answer says so), null groups, `*deprecated*` last; `plc` gives the PLC parameters with stations, values and last year. `getMeasurements` (mudab-measurements): the station measurement table (weather and sea observations only, 14 codes, `MEASUREMENT_PARAMETERS` with German and English words) in columns, exact copies dropped (the table repeats most rows: 187,707 rows, 36,919 distinct in a whole read and 40,239 in a paged read on 2026-11-19, the paged read holding every row of the whole one; the upstream view isn't stable between reads), cached per client for `MEASUREMENTS_CACHE_MS` (15 minutes; it is ~42 MB upstream, ~190,000 rows, about 15 s in 7 pages); a series is a station, a parameter and a unit (`unitOf`: the method id's token before the institute; WAVHT is in m and on a scale, many AIRTEMP and AIRPRES rows state none); a station name exact or unique, else `ambiguous` (OMMVZBA15 and OMMVZBA15_CW are different stations). `getRiverLoads` (mudab-measurements): the PLC values, river loads (`MON_RIVER_LOAD`) unless `kind` says otherwise (FLOW: the flow gauges), parameters by code, name or German word (`PLC_PARAMETERS`), nulls dropped and counted, rows ranked or totalled per station, year, kind or Land, per unit (the 2014 river loads and some unmonitored years say kg/a at the size of t/a values: never added across), a last year with under 75 % of the year before's rows said to be incomplete, rows without a Land (XX) left out of a Land filter and counted. `listRows`: the generic tool's raw rows, a page or a field's exact value across the whole table. Public API of both packages. |
| `packages/log` | The log records (text/jsonl), shared by both apps; `createLogger({ program })`. |
| `src/mcp/tools.ts` | This repo's: the five tools (flat input schemas with limits, no root combinators; one object output schema each; descriptions under 2000 characters), the instructions, the licence (no open licence: the provider's terms, the citation DATA_LICENSE.md asks for, where to ask), the hints the server's messages give. |
| `src/mcp/api.ts` | This repo's: how the kit reaches the client (`MudabClient` as `Client`, `MudabError` as `ClientError`, `MudabNetworkError` as `NetworkError`, `apiBase`). `apiBase` is the base URL (default `https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements`), so a result's `source` is the endpoint POSTed to (`…/STATION_SMALL`, `…/V_MESSWERTE_PLC`). |
| `src/mcp/server.ts` | The McpServer factory, the tool types, `callTool`: deadline (`--call-timeout`, after which a tool has a moment to answer with the part it has read) plus the client's cancellation, cleaned and fitted answers, failures as `isError` results. |
| `src/mcp/result.ts` | `cleanStrings` (control, bidi, zero-width characters dropped in the value), `fitResult` (whole list entries dropped under `--max-result-chars`, `nextOffset`). |
| `src/mcp/limiter.ts` | One per process around the upstream transport: 2 in flight, 120 a minute, a pause of at most 30 s on 429, a bounded queue; a request they would hold past its deadline refused at once. The method doesn't matter to it: MUDAB's requests are POSTs. |
| `src/mcp/http.ts` | node:http adapter for the SDK's `createMcpHandler`: POST /mcp, /healthz, Host and Origin checks (the SDK does neither), 1 MiB body, 8 requests at once, timeouts. |
| `src/mcp/config.ts`, `run.ts`, `index.ts` | Options (`node:util` parseArgs), argv -> exit code, the bin (console into log records, SIGINT/SIGTERM, stdin's end). |
| `src/mcp/credentials.ts`, `auth.ts` | The credentials hook (api.ts's `findCredentials`; this API needs none) and the secrets redacted from results and records; the HTTP bearer token of `--auth-token-file`. |

The protocol is the SDK's: `@modelcontextprotocol/server` 2.4.0, bundled with its core and zod
(prepack). It serves the 2026-07-28 revision and the 2025 handshake (2025-11-25, 2025-06-18)
statelessly, on stdio (`serveStdio`) and HTTP. The SDK bundles AJV 8.18 into its own code to
validate tool arguments against the input schemas; an SBOM doesn't list that copy.

Accepted SDK behaviour on stdio: a client that sends `notifications/initialized` and a request
before the answer to its `initialize` (the MCP lifecycle says it must wait) gets its answers
late, at the next event on the connection, because `serveStdio` decides the protocol era from
the opening exchange. Real clients wait, so nothing is worked around here.

The server reads at most 16 MiB per upstream answer (the kit's `MAX_UPSTREAM_BYTES`), so no tool
asks for a whole big table at once (`{ all: true }`): `PAGE_ROWS` keeps every page under ~7 MB
(2026-11-19: 30,000 measurement rows 6.4 MB in about 2 s). The default `--max-pages` (10) reads
up to 300,000 measurement rows; the table had 187,707. The first call that needs the measurement
table takes about 15–20 s of the 45 s call deadline; later calls answer from memory for 15
minutes (about 10 MB for the whole table in columns).

**The kit.** Everything in `apps/mcp` but `tools.ts`, `api.ts`, `test/helpers.ts`,
`test/tools.test.ts` and the conformance tests' adapter blocks, plus `packages/log`,
`apps/cli/src/cli/limits.ts`, `tools/image/` (but `smoke.json`), `tools/interop/` (but
`interop.json`), `tools/bump.mjs`, `tools/pack/` and the workflows `ci.yml`, `images.yml`,
`release.yml` and `publish.yml`, is the kit of `create-cli-template` (in the api-cli workspace),
the same in every repository with an MCP server: a fix lands there first and comes here with
`npm run sync-kit -- ../mudab-cli` (run in create-cli-template; `--check` lists the drift).

Tests (`apps/mcp/test`) run in-process over the SDK's InMemoryTransport with raw JSON-RPC (the kit's
`harness.ts`). The rules every server follows are the shared conformance tests `conformance-m1-…` to
`conformance-m12-…` (protocol and tool rules, HTTP, Host and Origin, stdio with the built bin,
config, limiter, result shaping, drain, call errors, MCP.md, credentials, the HTTP bearer token of
`--auth-token-file`: `auth.ts`, required where `api.ts` exports `HTTP_NEEDS_AUTH_TOKEN = true`, for
an API called with a personal account), each with an adapter block naming this repo's calls and mock
answers (this API needs no credentials, so the credentials tests are skipped); `tools.test.ts` holds
this server's own (the five tools, the traps). The mock API is the client's `test/tables.ts`
(`mudabApi`, `sampleTables`, `apiLog`): every endpoint answers POST only (anything else 405),
honours the body's range and nothing else, as the live server does, and wraps the rows under the
live key; the rows are live rows of 2026-11-19, a few per trap (a station in two compartments, L1's
two regions, mercury in three compartment lists but under biota in the combined one, WAVHT in m and
on a scale, AIRTEMP without a unit, PLC nulls, a 2014 kg/a value, a short last year, a station under
XX and SH, the unmonitored area). The stdio tests start the built bin (30 s each). `tools/interop/`
checks the built server against the official client 2.4.0 (stdio and HTTP; legacy, auto and pinned
2026-07-28) in ci.yml's `interop` job; it has its own lockfile and is never installed by the
workspace, release or publish runs; the calls it makes and the mock's answers (live rows) are in
`tools/interop/interop.json`. Both mocks answer by path, whatever the method, so MUDAB's POSTs reach
them.

## Container image

`tools/image/` builds both apps' images (Dockerfile targets `cli` and `mcp`) from their release
tarballs (`npm pack` output), never from source: `ADD` unpacks it onto distroless Node 24 (Debian
13, `nonroot`, uid 65532), so the image holds exactly the files npm users get. The base,
BuildKit, the test registry, skopeo (local runs only), syft and grype are pinned in `pins.json`;
bump them in the deps round. A Node or Debian security fix reaches the image only through a new
base digest, so it means a patch release.

| Script | What it does |
|---|---|
| `build.mjs` | Multi-arch OCI archive (amd64, arm64), reproducible: no provenance or SBOM attestation, timestamps from `SOURCE_DATE_EPOCH` (default: the HEAD commit's time). Two builds give the same index digest; compare index digests, not files. |
| `push.mjs` | Copies the archive to a registry with skopeo (`--all --preserve-digests`) and checks the digest the registry serves. Used for the local test registry and for ghcr.io. |
| `smoke.mjs` | Runs the image read-only, without capabilities, as an arbitrary uid: `--version`, `--help`, a network error (exit 6), one request to a mock upstream (`smoke.json`: `plc-stations --count 5` against three recorded stations; the mock answers the POST by path), and `docker stop`, which must end a waiting call with 143 in under 5 s. |
| `sbom.mjs` | One CycloneDX SBOM per platform with syft, and with `--gate true` grype over them: a fixable high or critical finding fails. Accepted findings go into `.grype.yaml` with a reason. CI only. |

Locally (colima; the scripts never read your docker config, so no credential helper is asked;
on macOS port 5000 is often taken by the AirPlay receiver, hence 5055):

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
npm pack --workspace apps/cli --pack-destination dist-artifacts
node tools/image/build.mjs --app cli --tarball dist-artifacts/<tarball>.tgz --out dist-artifacts/cli.oci.tar
docker run -d -p 127.0.0.1:5055:5000 <registry pin from pins.json>
node tools/image/push.mjs --archive dist-artifacts/cli.oci.tar --to 127.0.0.1:5055/mudab-cli:dev
node tools/image/smoke.mjs --app cli --image 127.0.0.1:5055/mudab-cli@<index digest>
```

In CI: `images.yml` does all of it on every push and weekly, with the arm64 image smoke-tested on
an arm64 runner and the vulnerability gate. In `release.yml` the job `image` builds from the
checked tarball and records the archive's digest, `image-sbom` makes the SBOMs (no gate: the
scanner's database changes daily), `attest` signs build provenance for the tarball, the archive
and the image index, and the release attaches the archive, the image SBOMs and `SHA256SUMS`.
`publish.yml` publishes the release's own files: both tarballs to npm and both archives to
`ghcr.io/maschinenlesbar-org/mudab-cli` and `…/mudab-mcp` (with the run's `GITHUB_TOKEN`), each
checked first against the immutable release (`gh release verify-asset`) and the provenance
`release.yml` signed for that tag (`gh attestation verify`).
`apps/cli/test/conformance-p32-image-pipeline.test.ts` (shared) pins these rules.

As PID 1 the bin shim listens for SIGINT, SIGTERM and SIGHUP (`exitOnSignalsAsPid1`): without
a listener the kernel drops them, and `docker stop` would wait 10 s and kill. In a container
the CLI reads the cgroup limits (`limits.ts`): under a memory limit the default
`--max-response-bytes` is an eighth of it, under a pids limit below 12 it refuses before any
request, and a leading program name (`docker run <image> mudab plc-stations`) is dropped.

## Website

The project website — <https://maschinenlesbar.org/mudab-cli/> in English and
<https://maschinenlesbar.org/mudab-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` (which
also says where the published manifest and the built program are: `manifest:
apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

Every page carries a description and Open Graph tags for link previews, and the home
pages schema.org JSON-LD (`SoftwareApplication`); the preview image and the icons are the
organisation website's. `site/404.html` is this site's not-found page, in both languages.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/mudab-cli/
```

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
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
commander's messages, unexpected errors), `api` (the API's answers: HTTP errors, text replaced with U+FFFD (a WARN), an error list sent with status 200, a
malformed answer — a `MudabParseError`: bad JSON, the wrong shape, an empty body, more rows
than asked for, an unknown charset, a number that can't be represented exactly — and the
`--base-url` redirect hint), `http` (the connection: network errors, the size-cap hint,
the cleartext warning) and `output` (a failed or cut-short write to stdout, an answer too deeply
nested or too large to print). When stdout is a regular file, `defaultIO.out` writes every byte
itself (`stdoutWriter`, a loop over `writeSync`): a write cut short (EFBIG, ENOSPC) is emitted as
stdout's `error` rather than lost with exit 0. A failed write to stdout
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
