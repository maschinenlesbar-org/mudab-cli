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
npm test            # pretest builds, then `node --test dist/test/*.test.js`
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
    client.ts    # MudabClient — one method per endpoint, defensive row extraction
    index.ts
  cli/
    io.ts        # injectable I/O (CliDeps / CliIO) — no env seam (no auth)
    shared.ts    # option parsers, global->engine mapping, the range builder, JSON render
    commands/list.ts  # every list command + the offline `compartments` table
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
| **Response wrapper key** | A single-key object, but the key is NOT reliably the path name (`/STATION_SMALL` → key `V_STATION_SMALL`). | `client.ts` `extractRows` takes the array under the one key (or a bare array); any other 200 reply — an error object, a second key, `null`, an empty body — is a `MudabParseError` naming what came back (exit 1), never `[]` |
| **`range` requires `from`** | A count-only range (`{count}` without `from`) is answered with **HTTP 500**. | `shared.ts` `buildFilterRequest` always sends `from` (default 0); the client rejects a count-only range (`MudabValidationError`) |
| **Range end is a 32-bit int** | `from + count` above 2³¹−1 (2147483647) gets an HTML **403 Forbidden** from the front end; on 2026-09-26 the host then stopped answering the client altogether. | `client.ts` `MAX_RANGE_END` + `assertRange`; the CLI bounds `--from`/`--count` and their sum (exit 2) |
| **`filter` / `orderby` ignored** | Despite every endpoint being a "filterbare Liste", the live server **ignores** filter and orderby — a filter that should match nothing still returns the full page. | The CLI exposes NO filter/sort options; `FilterRequest` documents the no-op |
| **`Compartment` enum incomplete** | Spec lists `BL/CW/CS/CF`; the data also contains `MM`. | `types.ts` types `Compartment` as an open `string` |
| **Empty body** | Returns the WHOLE table (measurements ≈ 187,000 rows / 42 MB on 2026-09-15). | CLI defaults `range.count` to 100; `--all` omits the range |

Redirects are **not** followed (a 3xx surfaces as an error with a hint to use the
canonical base URL) — following a cross-origin POST redirect blindly is a footgun,
and the canonical host answers directly.

## Testing

`node --test` on the compiled `dist/test/` — no jest/vitest. Files:

- `http.test.ts` — the real transport against a loopback `http.createServer` (POST
  with a body, protocol rejection, size cap).
- `engine.test.ts` — POST/JSON, retry, no-redirect, JSON + non-JSON error surfacing,
  parse errors, headers. Uses a mock transport.
- `client.test.ts` — endpoint routing, compartment routing, and the defensive
  `extractRows` (incl. the `V_STATION_SMALL` wrapper-key mismatch).
- `cli.test.ts` — the full CLI via `run()` with a mocked client: paging defaults,
  `--all`, `--compartment`, the offline `compartments`, the `--user-agent`
  control-char guard, and exit codes.

## Conventions to keep

- **Zero runtime HTTP deps** — `node:http`/`https` only; the CLI's only runtime dep is
  `commander`.
- **Strict TS** (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`) and ESM
  (`module: NodeNext`). Keep passing on Node 20/22/24.
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- **Retry/backoff:** transient `429`/`503` retried up to `maxRetries`, honouring
  `Retry-After` (delay-seconds or an IMF-fixdate, parsed strictly by `parseRetryAfter`)
  up to `MAX_RETRY_AFTER_MS` (30 s; a longer one is not retried, the error surfaces at
  once), else linear backoff (`retryDelayMs * attempt`).
- **Library input is checked before any request** (`MudabValidationError`): the numeric
  engine options (`timeoutMs` 0..2³¹−1, `maxRetries` 0..`MAX_RETRIES` = 10 — shared with
  `--max-retries` —, `retryDelayMs` 0..30 000, `maxResponseBytes` 0..2⁵³−1), the
  request's `range` (see the quirks table) and `parameters()`'s compartment.
- `--base-url` is trusted input but only `http:`/`https:` is accepted: a `file:`,
  `ftp:` or malformed value, a query or fragment (paths are appended as a string, so
  they would swallow every resource path) or surrounding whitespace is a usage error
  at parse time (`parseBaseUrl`), the engine constructor rejects a non-http(s) base
  URL or one with a query/fragment with `MudabNetworkError` (so a custom transport
  never receives one), and the default transport checks every hop. Userinfo is kept
  for the request and redacted (`redactUrl`) in every error message.
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
