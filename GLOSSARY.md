# Glossary

MUDAB domain terms, as the CLI surfaces them. Labels in the data are German; keep
them verbatim.

| Term | In the CLI | What it is |
|---|---|---|
| **MUDAB** | — | Meeresumweltdatenbank, the German marine environment database: quality-assured marine-monitoring data from the coastal Bundesländer and research institutions, hosted by the Bundesanstalt für Gewässerkunde (BfG) and surfaced by the Umweltbundesamt (UBA). |
| **Measurement station** (Messstation) | `stations` | A physical monitoring location where samples are taken. Fields: `STATNAME_ST` (name), `STATIONTYPE_ST` (type), `COMPT_DS` (compartment), `NAME_PS` (its project station). |
| **Project station** (Projektstation) | `project-stations` | The monitoring project / programme a station belongs to. Fields: `NAME_PS`, `REGION` (`Nordsee`/`Ostsee`), `INSTITUT` (e.g. `BSH`). |
| **Parameter** | `parameters` | A measured variable — a pollutant, nutrient, or biological/physical metric. Fields: `PARAMETER` (abbreviation), `PARAM_NAME` (name), `PARAMETERGRUPPE`/`PARAMGROUP_NAME` (group), `COMPT_DS`. |
| **Compartment** (Kompartiment, `COMPT_DS`) | `compartments` | The environmental medium a value belongs to. Known codes: `CW` = Wasser (water), `CS` = Sediment, `CF` = Biota, `BL` = Biologie (biology). **Not exhaustive** — e.g. `MM` also occurs. |
| **Measurement** (Messwert) | `measurements` | A single value at a station: `STATNAME_ST`, `PARAMCODE_PM`, `DATE_STM` (YYYYMMDD), `TIME_STM` (HHMM), `VALUE_MS` (the value, a **number**). The largest table (~187,000 rows, ~42 MB on 2026-09-15). |
| **HELCOM PLC** | `plc-*` | HELCOM's *Pollution Load Compilation* — the periodic assessment of waterborne nutrient and pollutant **loads** into the Baltic Sea. The data here covers German Baltic catchments (`LAND_CD` `MV`/`SH`) and holds monitored river loads, municipal point sources, river flow and loads from unmonitored areas (see `MON_TYPE`). |
| **PLC station** | `plc-stations` | A load-monitoring point: `STATION_NAME`, `STATION_CODE`, `LAND_CD` (Bundesland, or `UNMON`/`XX`), `ST_LAT`/`ST_LON`, `MON_TYPE`: `MON_RIVER_LOAD` (monitored river), `MUNCP_FL_LD` (municipal treatment plant), `STAT_FL_CONC` (flow gauge) or `UNMONITORED` (pseudo-station for unmonitored areas, coordinates 0/0). |
| **PLC measurement** | `plc-measurements` | An annual load or flow value: `NAME` (parameter, e.g. `Ptot`, `FLOW`), `VALUE` (a **number**, sometimes `null`), `VAL_UNIT`, `PERIOD_NAME` (year), `MON_TYPE`, `LAND_CD`, coordinates. |
| **Range** (`from`/`count`) | `--from`/`--count`/`--all` | The only paging/selection the server honours. `from` is required whenever a range is sent. Default `count` is 100. |
| **Filter / OrderBy** | *(not exposed)* | Present in the OpenAPI spec but **ignored by the live server** — see [DEVELOPING.md](DEVELOPING.md). Filter and sort client-side (e.g. `jq`). |

## Reading a value

- **Units vary per parameter.** For PLC measurements the unit is `VAL_UNIT`; for
  station measurements the unit and method are encoded in `PARAMETERID_PM`.
- **`VALUE_MS` (station) and `VALUE` (PLC) are numbers.** No cast is needed; `VALUE`
  can be `null`, so drop nulls before arithmetic.
- **Dates are separator-less strings** — `DATE_STM` = `YYYYMMDD`, `TIME_STM` = `HHMM`.
