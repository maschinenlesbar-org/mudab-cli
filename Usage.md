# Usage

`mudab` — a CLI for the MUDAB (Meeresumweltdatenbank) API. No API key needed.

```bash
mudab [global options] <command> [command options]
```

Each command lists one dataset and prints a JSON array of rows to stdout.

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default the canonical `geoportal.bafg.de` MUDAB base). http(s) only, no query (`?`) or fragment (`#`), no surrounding whitespace or control characters; a path prefix is fine. Userinfo (`user:pw@`) is sent as Basic auth and shown as `***@` in every message the CLI prints; a `%` in it must start an escape (write a literal `%` as `%25`). |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value (not blank; no control characters or characters above U+00FF — HTTP headers can't carry them) |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10, default 2). Each retry waits the server's `Retry-After` (seconds or an HTTP date) up to 30 s; without one it backs off linearly (200 ms, 400 ms, …). A `Retry-After` above 30 s is not retried: the error surfaces at once (exit 1). Network failures (a reset or refused connection, a DNS failure, a timeout) are not retried (exit 6). |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
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

# Phosphorus river loads for Mecklenburg (LAND_CD "MV")
mudab plc-measurements --all --compact \
  | jq '[.[] | select(.NAME=="Ptot" and .LAND_CD=="MV") | {STATION_NAME, PERIOD_NAME, VALUE, VAL_UNIT}]'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (a redirect included — it is not followed, the message names its target), a reply that is not the expected row wrapper (e.g. an error object or an empty body sent with status 200), or a catch-all |
| `2` | usage error (bad flags, unknown command, `--all` with `--from/--count`, `--from` + `--count` above 2147483647) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **`measurements` is the largest table.** On 2026-09-15 `--all` returned ~187,000 rows,
  ~42 MB, in about 10 s, under the default 100 MiB `--max-response-bytes`. The server
  cannot filter, so any selection needs the whole table: fetch it once and filter the
  result. If it outgrows the cap (exit 6), raise `--max-response-bytes`.
- **A `range` always sends `from`.** The server answers a count-only range with an
  HTTP 500, so the client always includes `from` (default 0).
- The data is © its providers — see [DATA_LICENSE.md](DATA_LICENSE.md); terms are not
  stated as open.
