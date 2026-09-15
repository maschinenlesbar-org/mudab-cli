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
(`MV_STATION_MSMNT`) and HELCOM PLC values (`V_MESSWERTE_PLC`: annual loads into the
Baltic Sea from monitored rivers, municipal treatment plants and unmonitored areas, plus
river flow).

## Tooling

This skill drives the `mudab` command. **Before anything else, validate it is available** — run `command -v mudab` (or `mudab --version`). If it is not on your PATH, STOP and inform the user that the `mudab` CLI (`@maschinenlesbar.org/mudab-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The API does **no server-side filtering or sorting** — the `filter`/`orderby` in its OpenAPI spec are silently ignored by the live server. So fetch a page and filter/sort **client-side with `jq`** on `--compact` output. Page with `--from`/`--count` (default 100 rows); `--all` fetches the whole table. Data is © the data providers via the Bundesanstalt für Gewässerkunde / Umweltbundesamt — see the repo's DATA_LICENSE.md; the terms are not stated as open, so don't assume redistribution rights.

## The two datasets

| Command | Row (key fields) |
|---|---|
| `mudab measurements` (MV_STATION_MSMNT) | `STATNAME_ST` (station), `PARAMCODE_PM` (parameter), `DATE_STM` (YYYYMMDD), `TIME_STM` (HHMM), `VALUE_MS` (value, a number) |
| `mudab plc-measurements` (V_MESSWERTE_PLC) | `STATION_NAME`, `NAME` (parameter, e.g. "Ptot"), `VALUE` (number or `null`), `VAL_UNIT`, `PERIOD_NAME` (year), `MON_TYPE` (row kind, see Traps), `LAND_CD`, `ST_LAT`/`ST_LON` |

## Size: one full download, not one per question

The server cannot filter, so selecting a station or parameter always means fetching the
whole table and filtering it with `jq`. `measurements` is the largest table: on
2026-09-15 it held ~187,000 rows (dates 1986–2025; 14 parameter codes for weather and
sea observations such as `AIRTEMP`, `SurTemp`, `SECCI`, `_CLOUD`), and `mudab measurements --all
--compact` returned ~42 MB in about 10 s, under the default 100 MiB
`--max-response-bytes` cap. Paging it 200 rows at a time would take ~940 requests. So
take `--all` **once** per task and do all the selections in one `jq` program on that
output (or, if the user agrees on a file name, save it once and query the file), rather
than downloading it again for each question. Use a small page only to look at the row
shape first:

```bash
mudab measurements --from 0 --count 5 --compact | jq '.[] | {STATNAME_ST, PARAMCODE_PM, DATE_STM, VALUE_MS}'
```

`plc-measurements --all` is ~19,000 rows / ~7 MB (2026-09-15).

## Recipes (filter client-side)

```bash
# Water-temperature values at station OMMVZBA15 (SurTemp = sea-surface temperature;
# a test("temp") would also catch AIRTEMP)
mudab measurements --all --compact \
  | jq '[.[] | select(.STATNAME_ST=="OMMVZBA15" and .PARAMCODE_PM=="SurTemp")
             | {DATE_STM, TIME_STM, VALUE_MS}]'

# Total-phosphorus (Ptot) river loads for Mecklenburg rivers, with units
mudab plc-measurements --all --compact \
  | jq '[.[] | select(.NAME=="Ptot" and .LAND_CD=="MV" and .MON_TYPE=="MON_RIVER_LOAD")
             | {STATION_NAME, PERIOD_NAME, VALUE, VAL_UNIT}]'

# Largest river Ntot loads in 2024 (monitored rivers only, nulls dropped)
mudab plc-measurements --all --compact \
  | jq '[.[] | select(.NAME=="Ntot" and .PERIOD_NAME=="2024" and .MON_TYPE=="MON_RIVER_LOAD" and .VALUE != null)]
        | sort_by(-.VALUE) | .[:5] | map({STATION_NAME, SUBCM_NAME, VALUE, VAL_UNIT})'
```

## Traps

- **No server-side filter/sort** — every selection above is `jq`. If a user expects a
  `--station`/`--parameter` flag, explain it does not exist and filter client-side.
- **Download a big table once.** `measurements --all` is ~42 MB and `stations --all`
  ~9 MB (83,916 rows) on 2026-09-15; both fit the 100 MiB cap, but repeating them per
  question is slow and wasteful. If the cap is ever hit (exit 6 with a size-cap hint),
  raise `--max-response-bytes` rather than paging hundreds of times.
- **`VALUE_MS` and `VALUE` are JSON numbers** (all ~187,000 `VALUE_MS` on 2026-09-15), so
  no casting is needed. `VALUE` can be `null` (38 PLC rows then) — drop nulls before sorting
  or summing.
- **PLC rows are not all river loads.** `MON_TYPE` says what a row is: `MON_RIVER_LOAD`
  (monitored river loads), `MUNCP_FL_LD` (municipal treatment plants, e.g.
  `ZKW LÜBECK`: flow in `m3/a` and loads), `STAT_FL_CONC` (river flow, `FLOW` in `m3/s`)
  and `UNMONITORED` (loads from unmonitored areas, as two pseudo-stations `WEBDELAND` and
  `BAPDELAND` with `LAND_CD` `UNMON` and coordinates 0/0). For 2024 `Ntot` (checked
  2026-09-15) they were the 1st and 3rd largest values, so filter on `MON_TYPE` before
  ranking rivers. `LAND_CD` is `MV`, `SH`, `UNMON` or `XX`.
- **Dates are strings** `YYYYMMDD` / times `HHMM` — no separators; parse accordingly.
- **Units matter and vary per parameter** — always carry `VAL_UNIT` (PLC) alongside a
  value; MV_STATION_MSMNT rows encode unit/method inside `PARAMETERID_PM`.
- **Cite the source** — © Statistik/data providers via BfG/UBA; the data terms are not
  stated as open (see DATA_LICENSE.md).
