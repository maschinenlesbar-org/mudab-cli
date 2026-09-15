# Usage

`mudab` — a CLI for the MUDAB (Meeresumweltdatenbank) API. No API key needed.

```bash
mudab [global options] <command> [command options]
```

Each command lists one dataset and prints a JSON array of rows to stdout.

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default the canonical `geoportal.bafg.de` MUDAB base) |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-V, --version` / `-h, --help` | version / help |

## Paging options (every list command)

| Option | Description |
|---|---|
| `--from <n>` | skip this many rows (`range.from`, default 0) |
| `--count <n>` | max rows to return (default **100**) |
| `--all` | return the whole table (omit the range — can be very large) |

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

# Page through the measurements table (never --all it)
mudab measurements --from 0 --count 200 --compact > page1.json
mudab measurements --from 200 --count 200 --compact > page2.json

# Phosphorus river loads for Mecklenburg (LAND_CD "MV")
mudab plc-measurements --all --compact \
  | jq '[.[] | select(.NAME=="Ptot" and .LAND_CD=="MV") | {STATION_NAME, PERIOD_NAME, VALUE, VAL_UNIT}]'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error, or a catch-all |
| `2` | usage error (bad flags, unknown command, `--all` with `--from/--count`) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **`measurements` is enormous.** Omitting a range returns the whole table; `--all`
  on it can blow past `--max-response-bytes`. Page it with `--from`/`--count`.
- **A `range` always sends `from`.** The server answers a count-only range with an
  HTTP 500, so the CLI always includes `from` (default 0).
- The data is © its providers — see [DATA_LICENSE.md](DATA_LICENSE.md); terms are not
  stated as open.
