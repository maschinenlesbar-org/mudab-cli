# Usage

`mudab` — a CLI for the MUDAB (Meeresumweltdatenbank) API. No API key needed.

```bash
mudab [global options] <command> [command options]
```

Each command lists one dataset and prints a JSON array of rows to stdout.

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default the canonical `geoportal.bafg.de` MUDAB base). http(s) only, no query (`?`) or fragment (`#`), no surrounding whitespace or control characters; a path prefix is fine. Userinfo (`user:pw@`) is sent as Basic auth and shown as `***@` in every message the CLI prints; a `%` in it must start an escape (write a literal `%` as `%25`). A plain `http:` URL to a non-loopback host (not `localhost`, `127.0.0.0/8`, `::1`) gets one `WARN` record of `mudab.http` on stderr, `… sent unencrypted (http:, not https:)`, naming the host (and the URL's credentials, never printed); stdout and the exit code are unchanged. |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value (not blank; no control characters or characters above U+00FF — HTTP headers can't carry them) |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10, default 2). Each retry backs off linearly (200 ms, 400 ms, …), or waits the server's `Retry-After` (seconds or an HTTP date) when that is longer, up to 30 s; a `Retry-After` of 0 or in the past never shortens the backoff. A `Retry-After` above 30 s is not retried: the error surfaces at once (exit 1) and names the requested wait. Network failures (a reset or refused connection, a DNS failure, a timeout) are not retried (exit 6). |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = no cap; default 100 MiB). Whatever the cap, a reply above about 512 MiB can't be decoded (Node.js's longest string): it fails with exit 1 and a message saying so; page it with `--from`/`--count`. |
| `--log-format <format>` | how errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [mudab.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-V, --version` / `-h, --help` | version / help |

## Paging options (every list command)

| Option | Description |
|---|---|
| `--from <n>` | skip this many rows (`range.from`, default 0) |
| `--count <n>` | max rows to return (default **100**) |
| `--all` | return the whole table (omit the range — can be very large) |

`--from`, `--count` and their sum are each at most 2147483647 (2³¹−1): the server
computes the end of the range as a 32-bit integer and its front end refuses a larger
one with an HTML `403 Forbidden` (after which the host stopped answering the client for
a while on 2026-09-26). The CLI rejects such values before sending anything (exit 2);
for the whole table use `--all`.

> **No filter or sort options.** The API's OpenAPI spec advertises `filter` and
> `orderby` on every endpoint, but the **live server ignores both** (a filter that
> should match nothing still returns the full page — verified). Exposing them would
> be a filter that does not filter, so this CLI omits them. Filter and sort
> client-side, e.g. with `jq` on `--compact` output.

## Commands

| Command | Dataset |
|---|---|
| `mudab stations` | measurement stations (`STATION_SMALL`) |
| `mudab project-stations` | project / monitoring-programme stations (`PROJECTSTATION_SMALL`) |
| `mudab parameters [--compartment biologie\|biota\|wasser\|sediment]` | measured parameters (`MV_PARAMETER`, or a compartment-specific endpoint) |
| `mudab measurements` | individual station measurements (`MV_STATION_MSMNT`) — a very large table |
| `mudab plc-stations` | HELCOM PLC river-load stations (`V_PLC_STATION`) |
| `mudab plc-parameters` | parameters measured at PLC stations (`V_GEMESSENE_PARA_PLC`) |
| `mudab plc-measurements` | measured values at PLC stations (`V_MESSWERTE_PLC`) |
| `mudab compartments` | print the compartment (`COMPT_DS`) code table — offline, no request |

## Examples

```bash
# First 5 measurement stations, pretty-printed
mudab stations --count 5

# All water parameters, filtered to a substance with jq
mudab parameters --compartment wasser --all --compact \
  | jq '[.[] | select(.PARAM_NAME | test("mercury";"i"))]'

# Look at a few measurement rows, then take the whole table once and filter it
mudab measurements --from 0 --count 5 --compact
mudab measurements --all --compact | jq '[.[] | select(.STATNAME_ST=="OMMVZBA15")] | length'

# Phosphorus river loads for Mecklenburg (LAND_CD "MV"); MON_TYPE keeps out the
# treatment plants (MUNCP_FL_LD) and unmonitored areas, which are PLC rows too
mudab plc-measurements --all --compact \
  | jq '[.[] | select(.NAME=="Ptot" and .LAND_CD=="MV" and .MON_TYPE=="MON_RIVER_LOAD") | {STATION_NAME, PERIOD_NAME, VALUE, VAL_UNIT}]'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0, and so does a run whose output reader stops early (`\| head`) |
| `1` | API/logical error (a redirect included — it is not followed, the message names its target; an error list sent with status 200, `{"errors":[…]}`, included — the message carries its text), a reply that is not the resource's row wrapper (an error object, another table's rows, a row that is not an object, or an empty body sent with status 200), more rows than `--count` asked for (the server ignored the range), or a catch-all |
| `2` | usage error (bad flags, unknown command, `--all` with `--from/--count`, `--from` + `--count` above 2147483647) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

A failed run keeps its exit code when the reader of stderr has gone away (`2>&1 | true`).

## Notes

- **`measurements` is the largest table.** On 2026-09-15 `--all` returned ~187,000 rows,
  ~42 MB, in about 10 s, under the default 100 MiB `--max-response-bytes`. The server
  cannot filter, so any selection needs the whole table: fetch it once and filter the
  result. If it outgrows the cap (exit 6), raise `--max-response-bytes` — up to about
  512 MiB, the most Node.js can decode in one piece; beyond that, page with `--from`/`--count`.
- **A `range` always sends `from`.** The server answers a count-only range with an
  HTTP 500, so the client always includes `from` (default 0).
- The data is © its providers — see [DATA_LICENSE.md](DATA_LICENSE.md); terms are not
  stated as open.
