# mudab-cli

[![CI](https://github.com/maschinenlesbar-org/mudab-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/mudab-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/mudab-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/mudab-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/mudab-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/mudab-cli)

**Website:** [English](https://maschinenlesbar.org/mudab-cli/) · [Deutsch](https://maschinenlesbar.org/mudab-cli/de/) — command reference, guides and API docs

A tiny, dependency-light **TypeScript client + CLI** for the **MUDAB**
(Meeresumweltdatenbank — the German marine environment database) REST API:
marine-monitoring data from the coastal Bundesländer and research institutions,
hosted by the Bundesanstalt für Gewässerkunde (BfG) and surfaced by the
Umweltbundesamt (UBA). A [bund.dev](https://bund.dev) API.

- **No API key.** The API is open — no auth, no account.
- **Zero runtime HTTP dependencies.** Built on `node:http`/`https`; the CLI's only
  runtime dependency is `commander`.
- **Library + CLI.** Use the typed `MudabClient` in code, or the `mudab` command.

> **We provide the tool, not the data.** The data is © its providers (see
> [DATA_LICENSE.md](DATA_LICENSE.md)); its terms are **not** stated as open — check
> before redistributing.

## Install

```bash
npm install -g @maschinenlesbar.org/mudab-cli   # the `mudab` command
# or as a library:
npm install @maschinenlesbar.org/mudab-cli
```

Requires **Node.js 22.12+**.

### Docker

From 0.9.0 every release is also a container image for linux/amd64 and linux/arm64 on the
GitHub Container Registry, made from the same tarball as the npm package. It needs no Node.js and no
install:

```bash
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/maschinenlesbar-org/mudab-cli:latest plc-stations --all
```

The image's entrypoint is the program, so the command follows the image name directly;
`… mudab-cli:latest mudab plc-stations --all` works too.

In a container with a memory limit (`--memory`) the default `--max-response-bytes` is an eighth
of that limit (at most the usual 100 MiB), so an oversized answer is refused with a clear
error instead of the container being killed for memory. `measurements --all` is about 42 MB:
give it `--memory 512m` or more, or page with `--from`/`--count`. The CLI needs at least 12
processes and threads (`--pids-limit 12`): below that it refuses with an error, and with 4 or
fewer Node.js itself hangs before the CLI can check.

`latest` is the newest release. For scripts, name a release and pin its digest, which the
[release notes](https://github.com/maschinenlesbar-org/mudab-cli/releases) give:
`…/mudab-cli:0.9.0@sha256:<digest>`. Each image carries signed build provenance; check it with

```bash
gh attestation verify oci://ghcr.io/maschinenlesbar-org/mudab-cli:latest \
  --repo maschinenlesbar-org/mudab-cli
```

### MCP server

From 0.9.0 MUDAB is also an [MCP](https://modelcontextprotocol.io/) server for AI agents,
`@maschinenlesbar.org/mudab-mcp` (command `mudab-mcp`, image
`ghcr.io/maschinenlesbar-org/mudab-mcp`): five read-only tools, finding stations (with the
region and institute of their project station), finding parameters (with every compartment that
measures them), station measurements, the HELCOM river loads into the Baltic, and the raw rows of
any table, with MUDAB's traps handled (the server filters nothing, stations counted by name,
conflicting regions kept, units kept apart, river loads only unless asked), on stdio or
Streamable HTTP. Setup for Claude Code, Claude Desktop and VS Code:
[MCP.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/MCP.md). The data has no
open licence: running the server as a service for others may need the provider's permission
(see [DATA_LICENSE.md](DATA_LICENSE.md)).

```bash
npm i -g @maschinenlesbar.org/mudab-mcp
claude mcp add mudab -- mudab-mcp
```

## CLI

Every command lists one dataset. Results are paged with `--from`/`--count`
(default **100** rows); `--all` fetches the whole table.

```bash
mudab stations --count 5                      # measurement stations
mudab project-stations                        # monitoring projects (region, institute)
mudab parameters --compartment wasser         # water parameters
mudab measurements --from 0 --count 200       # station measurements (page it — huge)
mudab plc-stations                            # HELCOM PLC river-load stations
mudab plc-measurements --all                  # river pollutant loads
mudab compartments                            # compartment code table (offline)
```

> **The API does no server-side filtering or sorting.** Its OpenAPI spec advertises
> `filter`/`orderby` on every endpoint, but the live server **ignores** them, so the
> CLI does not offer filter flags. Fetch a page and filter with `jq`:
>
> ```bash
> mudab parameters --all --compact | jq '[.[] | select(.COMPT_DS=="CW")]'
> ```

Global flags: `--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--log-format`, `--compact`. A `--base-url` on plain `http:` to a
host other than loopback (`localhost`, `127.0.0.0/8`, `::1`) logs one `WARN` record of
`mudab.http`, `requests to <host> are sent unencrypted (http:, not https:)`, on stderr
before the first request (not for the offline `compartments`, which sends none) (naming the URL's credentials instead when it carries any,
never printing them); stdout and the exit code are unchanged. See [Usage.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/Usage.md)
for the full reference.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`mudab.cli` for usage
errors, `mudab.api` for the API's answers, a malformed answer included, `mudab.http` for the connection, `mudab.output`
for a failed or cut-short write to stdout or an answer too deeply nested or too large to print). An error about an answer names the request (`POST <url>: the
answer is not valid JSON: …`). Text in an answer is never changed silently: bytes that are not
valid in its charset and half characters (lone surrogates) are replaced with U+FFFD, so the output
stays readable for `jq`, and a `WARN` record of `mudab.api` says how many. By default
it is written log4j style; `--log-format jsonl` writes one JSON object per line instead. A
record is always one line: a line break, a control character or a bidi control in a message
(a server's text, a value you typed) is written as an escape (`\n`, `\u001b`, `\u202e`), so
it can neither split a record nor forge another one, nor steer the terminal; a message longer
than 4000 characters is cut and ends in `… (N more characters)`:

```text
2026-10-09T14:03:12.481Z WARN  [mudab.http] requests to mirror.test are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.700Z WARN  [mudab.http] HTTP 503 from geoportal.bafg.de: retry 1 of 2 in 200 ms
2026-10-09T14:03:12.902Z ERROR [mudab.api] HTTP 404 for POST https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements/STATION_SMALL
```

```bash
mudab --log-format jsonl stations 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"mudab.api","msg":"HTTP 404 …"}
```

## Library

```ts
import { MudabClient } from "@maschinenlesbar.org/mudab-cli";

const mudab = new MudabClient();
const stations = await mudab.stations({ range: { from: 0, count: 10 } });
const waterParams = await mudab.parameters({ range: { from: 0, count: 50 } }, "wasser");
```

Each method returns a typed row array (the client extracts it from the API's
single-key wrapper object). Only `range` is honoured by the server — see the note in
`FilterRequest`.

> **List methods return a 100-row page by default.** Without a `range`, every method
> fetches rows 0–99 (`DEFAULT_PAGE_SIZE`); pass `{ range: { from, count } }` for another
> page, or `{ all: true }` for the whole table (`measurements` ≈ 187,000 rows / 42 MB).
> Since 0.1.0 — before, a call without a range returned the whole table.

The skills' use cases are library functions too, with MUDAB's traps built in (whole tables read
in pages and selected here, stations counted by name, a substance's compartments from each
compartment's list, units kept apart, river loads only unless asked):

```ts
import { findParameters, findStations, getMeasurements, getRiverLoads } from "@maschinenlesbar.org/mudab-cli";

await findStations(mudab, { kind: "project", institute: "BSH", region: "Nordsee" });
await findParameters(mudab, { name: "mercury" }); // HG in water, sediment and biota
await getMeasurements(mudab, { station: "OMMVZBA15", parameter: "SurTemp" }); // series per unit, newest first
await getRiverLoads(mudab, { parameter: "Ntot", year: 2024, limit: 5 }); // monitored rivers, largest first
```

## Documentation

- [Usage.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/Usage.md) — full command reference and exit codes
- [DEVELOPING.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/DEVELOPING.md) — architecture, testing, the live-API quirks
- [GLOSSARY.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/GLOSSARY.md) — MUDAB domain terms (stations, compartments, PLC)
- [DATA_LICENSE.md](DATA_LICENSE.md) — upstream data terms (distinct from the code license)
- [SKILLS.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/SKILLS.md) — the Claude Code skills this repo ships
- [MCP.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/MCP.md) — the MCP server: tools, setup, options

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
