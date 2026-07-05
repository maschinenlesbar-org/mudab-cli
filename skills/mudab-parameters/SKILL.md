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

The whole parameter table is small (~900 rows), so `--all` is fine here (unlike
measurements). Each row: `PARAMETER` (abbreviation, e.g. `HG` for mercury),
`PARAM_NAME` (e.g. "Mercury"), `PARAMETERGRUPPE`/`PARAMGROUP_NAME` (the group, e.g.
"Metals"), and `COMPT_DS` (compartment).

## Recipes

```bash
# Is mercury measured, and in which compartments?
mudab parameters --all --compact | jq '[.[] | select(.PARAM_NAME | test("mercury";"i")) | {PARAMETER, PARAM_NAME, COMPT_DS}]'

# All nutrient parameters (group name contains "Nutrient")
mudab parameters --all --compact | jq '[.[] | select(.PARAMGROUP_NAME | test("nutrient";"i")) | {PARAMETER, PARAM_NAME}]'

# The distinct parameter groups in the sediment compartment
mudab parameters --compartment sediment --all --compact | jq '[.[].PARAMGROUP_NAME] | unique'
```

## Traps

- **No server-side filter.** `--compartment` is the ONLY narrowing the server does
  (it routes to a different endpoint); everything else is `jq`.
- **A parameter can appear in several compartments** — the same substance has one row
  per compartment (different `COMPT_DS`). De-duplicate on `PARAMETER` if you only want
  the substance list.
- **Names are English-ish scientific labels; groups mix English and codes** — keep
  `PARAMETER`/`PARAM_NAME` verbatim; they are what the measurement rows key on.
- **PLC parameters are a separate list** (`plc-parameters`) tied to river-load stations,
  with `STATION_CODE` and `ANZ_MESSWERTE` (value counts).
- Hand off to **mudab-measurements** to pull the actual values.
