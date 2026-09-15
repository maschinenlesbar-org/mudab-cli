# Examples

Real examples for the Claude Code skills of the `mudab` plugin, one per skill: a request,
the `mudab` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `mudab` 0.0.4.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [mudab-measurements](#mudab-measurements) · [mudab-parameters](#mudab-parameters) · [mudab-stations](#mudab-stations)

## mudab-measurements

> How much nitrogen did German rivers carry into the Baltic Sea in 2024, and which rivers carried the most?

```bash
mudab plc-measurements --all --compact > plc.json        # 19,360 rows, 6.7 MB
jq '[.[] | select(.NAME=="Ntot" and .PERIOD_NAME=="2024")] | group_by(.MON_TYPE) | …' plc.json
jq '[.[] | select(.NAME=="Ntot" and .MON_TYPE=="MON_RIVER_LOAD")] | group_by(.PERIOD_NAME) | …' plc.json
```

The API can't filter, so the skill fetched the whole PLC table once and filtered it with `jq`.
The 55 Ntot rows for 2024 are of three kinds. The two largest (WEBDELAND 4,804 t/a,
BAPDELAND 2,356 t/a) are `UNMONITORED` areas with coordinates 0/0, not rivers, so the skill
left them out of the river ranking.

```
Total nitrogen (Ntot) loads, 2024: HELCOM PLC, unit t/a
  24 monitored river stations (MON_RIVER_LOAD)   11,883 t/a   (MV 8,216 · SH 3,667)
   2 unmonitored areas (UNMONITORED)              7,160 t/a
  29 point sources (MUNCP_FL_LD)                    805 t/a
     all 55 rows                                 19,848 t/a

Largest monitored rivers
  2,797 t/a  PEENE        at ANKLAM (CDE0007)                       MV  53.85, 13.68
  1,657 t/a  WARNOW       at ROSTOCK (CDE0017)                      MV  54.08, 12.15
  1,536 t/a  TRAVE        at MOISLING (CDE0037)                     SH  53.85, 10.64
  1,046 t/a  UECKER       at UECKERMÜNDE (CDE0015)                  MV  53.73, 14.05
    686 t/a  STEPENITZ    at RODENBERG (CDE0014)                    MV  53.88, 11.02
    542 t/a  FÜSINGER AU  at SCHAALBY, SCHLEIDÖRFERSTR. (CDE0021)   SH  54.54, 9.64
  … 18 more, down to AALBEK

Monitored rivers by year: 2018 12,118 · 2019 4,265 · 2020 7,042 · 2021 8,657 ·
  2022 9,155 · 2023 7,894 · 2024 11,883 t/a
2024 was the highest value since 2018, though still slightly below 2018 itself.
Source: © data providers via BfG/UBA (MUDAB). The terms are not stated as open.
```

Next steps offered: the same breakdown for total phosphorus (`Ptot`), or one river's series over the years (the table goes back to 1994).

## mudab-parameters

> Is PFOS measured in MUDAB, and in which compartments? Which code do I need?

```bash
mudab parameters --all --compact                          # 889 rows: PFOS listed only under CF
mudab parameters --compartment wasser --all --compact
mudab parameters --compartment sediment --all --compact
mudab parameters --compartment biota --all --compact
mudab parameters --compartment biologie --all --compact
```

The combined table has one row per parameter code, so it listed PFOS (and even mercury) under
biota only. To answer "which compartments", the skill queried each compartment endpoint
separately. 119 rows have no group name, so the group filter uses `(.PARAMGROUP_NAME // "")`.

```
PFOS: parameter code PFOS, group Organofluorines (O-FL)
  "Perfluorooctanyl sulphonic acid - branched + linear forms"

  Compartment      PFOS   organofluorine codes in total
  Wasser (CW)      yes    16
  Sediment (CS)    yes     9
  Biota (CF)       yes    34
  Biologie (BL)    no      0   (16 parameters: biomass, abundance, site conditions)

Related codes in all three compartments: PFOA, PFHXS, PFBS, PFDA, PFHXA, PFHPA, PFOSA.
Biota also has linear-isomer sums (n-PFOS, n-PFHXS, n-PFDS), ADONA and HFPO-DA.
TFA is listed for water and biota.
```

Next steps offered: pull PFOS values with **mudab-measurements**, matching `PARAMCODE_PM`.

## mudab-stations

> Who runs MUDAB's Baltic Sea monitoring stations, and how many stations does each institute have?

```bash
mudab project-stations --all --compact > project-stations.json   # 1,948 rows
jq '[.[] | select(.REGION=="Ostsee")] | group_by(.INSTITUT) | …' project-stations.json
mudab stations --all --compact > stations.json                   # 83,916 rows, 9.4 MB
jq --slurpfile ps project-stations.json '… join on NAME_PS, count distinct STATNAME_ST per institute …' stations.json
```

Measurement stations have no region, so the skill joined them to project stations on `NAME_PS`.
`NAME_PS` is not unique: 8 names appear with two institutes or regions (e.g. `Darss Sill`:
IOW and BSH; `L1`: Ostsee and Nordsee), so the counts for those names are approximate.

```
MUDAB Baltic Sea (Ostsee): 802 of 1948 project-station rows (Nordsee 1146)

  INSTITUT   project stations   measurement stations   by compartment
  IOW          248                9,876                CW 9,683 · CS 188 · BL 47 · CF 1
  LLUR         132                2,371                CW 2,195 · CS 128 · BL 119 · CF 44
  BFN          100                    0                none linked (e.g. BfN_SWAL_N2K_E1_5)
  LUNG          82                5,337                CW 5,164 · CF 103 · BL 80 · CS 72
  BSH           78                1,423                CW 1,388 · CS 190
  DESH          56                   12                MM 12
  DEMV          49                    3                MM 3
  VTIFOE        47                  175                CW 127 · CF 44 · CS 5
  LALLF / UPB    3 / 3             61 / 17             mostly CF (biota)
  (no institute) 4                   26                CW 23 · CS 4

Most are water (CW) stations. IOW and LUNG account for nearly four fifths of them.
MM is not in the compartment code table (`mudab compartments`).
```

Next steps offered: what is measured (**mudab-parameters**) or values for one station, e.g. `OMMVZBA15` (LUNG).
