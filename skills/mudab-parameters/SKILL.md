---
name: mudab-parameters
description: >
  Explore the parameters measured in German marine monitoring (MUDAB) using the
  mudab-cli — which pollutants, nutrients and biological variables are recorded, by
  compartment (water, sediment, biota, biology). Trigger when the user asks "what
  pollutants does MUDAB measure in sediment?", "list marine water parameters", "is
  mercury measured in biota?", "what nutrient parameters exist for the Baltic?", or
  needs the PARAMETER code for a substance before pulling measurements.
version: 1.0.0
userInvocable: true
---

# MUDAB Parameters

The measured variables in MUDAB — organic pollutants, metals, nutrients, and
biological metrics — grouped by compartment. Use this to discover the `PARAMETER`
code / group for a substance so a measurement lookup knows what to look for.

## Tooling

This skill drives the `mudab` command. **Before anything else, validate it is available** — run `command -v mudab` (or `mudab --version`). If it is not on your PATH, STOP and inform the user that the `mudab` CLI (`@maschinenlesbar.org/mudab-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The API does **no server-side filtering or sorting** — the `filter`/`orderby` in its OpenAPI spec are silently ignored by the live server. So fetch a page and filter/sort **client-side with `jq`** on `--compact` output. Page with `--from`/`--count` (default 100 rows); `--all` fetches the whole table. Data is © the data providers via the Bundesanstalt für Gewässerkunde / Umweltbundesamt — see the repo's DATA_LICENSE.md; the terms are not stated as open, so don't assume redistribution rights.

## Commands

```bash
mudab parameters                       # all parameters (MV_PARAMETER)
mudab parameters --compartment wasser  # water only    (CW)
mudab parameters --compartment sediment# sediment only (CS)
mudab parameters --compartment biota   # biota only    (CF)
mudab parameters --compartment biologie# biology only  (BL)
mudab plc-parameters                   # parameters measured at HELCOM PLC river stations
```

The parameter tables are small (at most ~1,250 rows on 2026-09-15), so `--all` is fine. Each
row: `PARAMETER` (abbreviation, e.g. `HG` for mercury), `PARAM_NAME` (e.g. "mercury"),
`PARAMETERGRUPPE`/`PARAMGROUP_NAME` (the group, e.g. "Metals and metalloids"; can be
`null`), and `COMPT_DS` (compartment).

## Recipes

```bash
# Is mercury measured, and in which compartments? Ask each compartment endpoint —
# the combined table lists a code under one compartment only (see Traps)
for c in wasser sediment biota biologie; do
  mudab parameters --compartment "$c" --all --compact \
    | jq -c --arg c "$c" '.[] | select(.PARAM_NAME | test("mercury";"i")) | {compartment: $c, PARAMETER, PARAM_NAME, COMPT_DS}'
done

# All nutrient parameters (group name contains "Nutrient"; the group can be null)
mudab parameters --all --compact | jq '[.[] | select((.PARAMGROUP_NAME // "") | test("nutrient";"i")) | {PARAMETER, PARAM_NAME}]'

# The distinct parameter groups in the sediment compartment
mudab parameters --compartment sediment --all --compact | jq '[.[].PARAMGROUP_NAME | select(. != null)] | unique'
```

## Traps

- **No server-side filter.** `--compartment` is the ONLY narrowing the server does
  (it routes to a different endpoint); everything else is `jq`.
- **The combined table lists each code once.** `mudab parameters` without
  `--compartment` has (almost) one row per `PARAMETER`, with one `COMPT_DS`: `HG` (mercury)
  and `PFOS` appear only under `CF`, although the `wasser`, `sediment` and `biota`
  endpoints all list them. To say in which compartments a substance is measured, query
  each `--compartment` (the recipe above). Across the four compartment lists a code
  repeats once per compartment, so de-duplicate on `PARAMETER` for a plain substance list.
  Some codes appear only in the combined table (e.g. `HGTOR`, `COMPT_DS` `MM`).
- **`PARAMGROUP_NAME` can be `null`** (119 of 889 combined rows on 2026-09-15, mostly
  `*deprecated*` parameters). `test()` on `null` aborts `jq`, so guard it with
  `(.PARAMGROUP_NAME // "")`, and drop nulls before listing groups.
- **Names are English-ish scientific labels; groups mix English and codes** — keep
  `PARAMETER`/`PARAM_NAME` verbatim; they are what the measurement rows key on.
- **PLC parameters are a separate list** (`plc-parameters`) tied to river-load stations,
  with `STATION_CODE` and `ANZ_MESSWERTE` (value counts).
- Hand off to **mudab-measurements** to pull the actual values.
