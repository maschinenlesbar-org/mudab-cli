---
name: mudab-measurements
description: >
  Retrieve marine-monitoring measurement values from MUDAB (Meeresumweltdatenbank)
  using the mudab-cli — individual station measurements and HELCOM PLC river-load
  values for the North and Baltic Sea. Trigger when the user asks "get water
  temperature measurements from a Baltic station", "what are the nutrient loads of
  German rivers into the sea?", "pull MUDAB measurement values for a station", or
  wants actual numbers (dates, values, units), not just station or parameter lists.
version: 1.0.0
userInvocable: true
---

# MUDAB Measurements

The actual measured values. Two datasets: per-station measurements
(`MV_STATION_MSMNT`) and HELCOM PLC river-load values (`V_MESSWERTE_PLC`, annual
pollutant loads carried by rivers into the sea).

## Tooling

This skill drives the `mudab` command. **Before anything else, validate it is available** — run `command -v mudab` (or `mudab --version`). If it is not on your PATH, STOP and inform the user that the `mudab` CLI (`@maschinenlesbar.org/mudab-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The API does **no server-side filtering or sorting** — the `filter`/`orderby` in its OpenAPI spec are silently ignored by the live server. So fetch a page and filter/sort **client-side with `jq`** on `--compact` output. Page with `--from`/`--count` (default 100 rows); `--all` fetches the whole table. Data is © the data providers via the Bundesanstalt für Gewässerkunde / Umweltbundesamt — see the repo's DATA_LICENSE.md; the terms are not stated as open, so don't assume redistribution rights.

## The two datasets

| Command | Row (key fields) |
|---|---|
| `mudab measurements` (MV_STATION_MSMNT) | `STATNAME_ST` (station), `PARAMCODE_PM` (parameter), `DATE_STM` (YYYYMMDD), `TIME_STM` (HHMM), `VALUE_MS` (value, a string) |
| `mudab plc-measurements` (V_MESSWERTE_PLC) | `STATION_NAME`, `NAME` (parameter, e.g. "Ptot"), `VALUE` (number), `VAL_UNIT`, `PERIOD_NAME` (year), `LAND_CD`, `ST_LAT`/`ST_LON` |

## The size problem — page, do not dump

`measurements` is a **very large** table (millions of rows). **Never** run
`mudab measurements --all` blindly — it can exceed the response-size cap (raise it
with `--max-response-bytes` only if you truly mean to). Instead page:

```bash
mudab measurements --from 0 --count 200 --compact | jq '.[] | {STATNAME_ST, PARAMCODE_PM, DATE_STM, VALUE_MS}'
mudab measurements --from 200 --count 200 --compact   # next page
```

`plc-measurements` is much smaller and can usually be taken with `--all`.

## Recipes (filter client-side)

```bash
# Water-temperature values at station OMMVZBA15
mudab measurements --all --compact \
  | jq '[.[] | select(.STATNAME_ST=="OMMVZBA15" and (.PARAMCODE_PM|test("temp";"i")))
             | {DATE_STM, TIME_STM, VALUE_MS}]'

# Total-phosphorus (Ptot) river loads for Mecklenburg rivers, with units
mudab plc-measurements --all --compact \
  | jq '[.[] | select(.NAME=="Ptot" and .LAND_CD=="MV") | {STATION_NAME, PERIOD_NAME, VALUE, VAL_UNIT}]'
```

## Traps

- **No server-side filter/sort** — every selection above is `jq`. If a user expects a
  `--station`/`--parameter` flag, explain it does not exist and filter client-side.
- **`measurements` is millions of rows** — always `--from/--count` page it; only `--all`
  the small tables (`plc-measurements`, stations, parameters).
- **`VALUE_MS` is a string, `VALUE` (PLC) is a number** — cast before arithmetic
  (`(.VALUE_MS|tonumber)`), and expect the odd non-numeric flag.
- **Dates are strings** `YYYYMMDD` / times `HHMM` — no separators; parse accordingly.
- **Units matter and vary per parameter** — always carry `VAL_UNIT` (PLC) alongside a
  value; MV_STATION_MSMNT rows encode unit/method inside `PARAMETERID_PM`.
- **Cite the source** — © Statistik/data providers via BfG/UBA; the data terms are not
  stated as open (see DATA_LICENSE.md).
