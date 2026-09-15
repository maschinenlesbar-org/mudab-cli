---
name: mudab-stations
description: >
  Find and list German marine-monitoring stations from MUDAB (Meeresumweltdatenbank)
  using the mudab-cli. Trigger when the user asks "which marine monitoring stations
  are there in the North Sea?", "list MUDAB measurement stations", "what project
  stations does the BSH run?", "show HELCOM PLC river stations in Mecklenburg", or
  wants station names, types, regions and compartments. Covers measurement stations,
  project stations and HELCOM PLC stations, and explains the compartment codes.
version: 1.0.0
userInvocable: true
---

# MUDAB Stations

MUDAB (the German marine environment database) organises data around stations. This
skill lists them and explains the station model, so a follow-up parameter or
measurement lookup has the right station name/code.

## Tooling

This skill drives the `mudab` command. **Before anything else, validate it is available** — run `command -v mudab` (or `mudab --version`). If it is not on your PATH, STOP and inform the user that the `mudab` CLI (`@maschinenlesbar.org/mudab-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The API does **no server-side filtering or sorting** — the `filter`/`orderby` in its OpenAPI spec are silently ignored by the live server. So fetch a page and filter/sort **client-side with `jq`** on `--compact` output. Page with `--from`/`--count` (default 100 rows); `--all` fetches the whole table. Data is © the data providers via the Bundesanstalt für Gewässerkunde / Umweltbundesamt — see the repo's DATA_LICENSE.md; the terms are not stated as open, so don't assume redistribution rights.

## Station kinds

| Command | Dataset | What it is |
|---|---|---|
| `mudab stations` | measurement stations (STATION_SMALL) | where samples are taken; has `STATNAME_ST`, `STATIONTYPE_ST`, `COMPT_DS` |
| `mudab project-stations` | project stations (PROJECTSTATION_SMALL) | the monitoring project a station belongs to; has `NAME_PS`, `REGION` (Nordsee/Ostsee), `INSTITUT` |
| `mudab plc-stations` | HELCOM PLC stations (V_PLC_STATION) | Baltic load-monitoring points: river stations, municipal treatment plants and unmonitored-area pseudo-stations (`MON_TYPE`); has `STATION_NAME`, `STATION_CODE`, `LAND_CD`, `ST_LAT`/`ST_LON` |

## Compartments (COMPT_DS)

`mudab compartments` prints the code table (offline, no request):

| Code | Compartment |
|---|---|
| `CW` | Wasser (water) |
| `CS` | Sediment |
| `CF` | Biota |
| `BL` | Biologie (biology) |

> The set is **not exhaustive** — other codes (e.g. `MM`) also occur in the data.

## Recipes

Because the API cannot filter, fetch a page and filter with `jq`:

```bash
# North Sea project stations run by the BSH
mudab project-stations --all --compact | jq '[.[] | select(.REGION=="Nordsee" and .INSTITUT=="BSH")]'

# HELCOM PLC river stations in Mecklenburg-Vorpommern (LAND_CD "MV"), with coordinates
mudab plc-stations --all --compact \
  | jq '[.[] | select(.LAND_CD=="MV" and .MON_TYPE=="MON_RIVER_LOAD") | {STATION_NAME, STATION_CODE, ST_LAT, ST_LON}]'

# Measurement stations in the biology compartment (unique: the table repeats rows)
mudab stations --all --compact | jq '[.[] | select(.COMPT_DS=="BL")] | unique'
```

## Traps

- **No server-side filter/sort.** Never present `--filter`-style options — they don't
  exist; do the selection in `jq`.
- **`stations` and `project-stations` are different tables** joined by `NAME_PS`
  (the project-station name). A measurement station's `NAME_PS` points at its project,
  but the join is not one-to-one: on 2026-09-15 `project-stations` had 1,948 rows for
  1,862 names, and 8 names carry conflicting `REGION`/`INSTITUT` (`L1` is BSH/Nordsee and
  IOW/Ostsee, `Darss Sill` BSH and IOW, `Cuxhaven` WGEHH and DENI, some with `INSTITUT`
  `null`). Report every match for such a name instead of picking one. Many project
  stations have no measurement station at all (e.g. every `BFN` row).
- **`stations` repeats rows.** It had 83,916 rows but only 68,571 distinct ones
  (2026-09-15), so counts of rows overstate stations. Apply `unique` (or count distinct
  `STATNAME_ST`) before counting. At ~9 MB, `stations --all` is fine to fetch once.
- **PLC stations are not all rivers.** `MON_TYPE` is `MON_RIVER_LOAD`, `MUNCP_FL_LD`
  (municipal treatment plants), `STAT_FL_CONC` (flow gauges) or `UNMONITORED` (two
  pseudo-stations with coordinates 0/0). Filter on it when the user means rivers.
- **Region lives on project stations** (`REGION`), not on measurement stations.
- **Labels are German** (`Nordsee`, `Ostsee`) — keep them verbatim.
- Hand off to **mudab-parameters** (what is measured) or **mudab-measurements** (values).
