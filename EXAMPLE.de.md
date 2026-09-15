# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `mudab`, eines pro Skill: eine
Anfrage, die `mudab`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `mudab` 0.0.4 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [mudab-measurements](#mudab-measurements) · [mudab-parameters](#mudab-parameters) · [mudab-stations](#mudab-stations)

## mudab-measurements

> Wie viel Stickstoff haben deutsche Flüsse 2024 in die Ostsee eingetragen, und welche Flüsse am meisten?

```bash
mudab plc-measurements --all --compact > plc.json        # 19.360 Zeilen, 6,7 MB
jq '[.[] | select(.NAME=="Ntot" and .PERIOD_NAME=="2024")] | group_by(.MON_TYPE) | …' plc.json
jq '[.[] | select(.NAME=="Ntot" and .MON_TYPE=="MON_RIVER_LOAD")] | group_by(.PERIOD_NAME) | …' plc.json
```

Die API kann nicht filtern, deshalb hat der Skill die ganze PLC-Tabelle einmal geladen und mit
`jq` gefiltert. Die 55 Ntot-Zeilen für 2024 gehören zu drei Arten. Die zwei größten (WEBDELAND
4.804 t/a, BAPDELAND 2.356 t/a) sind `UNMONITORED`-Gebiete mit den Koordinaten 0/0, keine Flüsse.
Der Skill hat sie deshalb nicht in die Flussrangliste aufgenommen.

```
Gesamtstickstoff-Frachten (Ntot), 2024: HELCOM PLC, Einheit t/a
  24 überwachte Flussmessstellen (MON_RIVER_LOAD)   11.883 t/a   (MV 8.216 · SH 3.667)
   2 nicht überwachte Gebiete (UNMONITORED)          7.160 t/a
  29 Punktquellen (MUNCP_FL_LD)                        805 t/a
     alle 55 Zeilen                                 19.848 t/a

Größte überwachte Flüsse
  2.797 t/a  PEENE        bei ANKLAM (CDE0007)                       MV  53,85; 13,68
  1.657 t/a  WARNOW       bei ROSTOCK (CDE0017)                      MV  54,08; 12,15
  1.536 t/a  TRAVE        bei MOISLING (CDE0037)                     SH  53,85; 10,64
  1.046 t/a  UECKER       bei UECKERMÜNDE (CDE0015)                  MV  53,73; 14,05
    686 t/a  STEPENITZ    bei RODENBERG (CDE0014)                    MV  53,88; 11,02
    542 t/a  FÜSINGER AU  bei SCHAALBY, SCHLEIDÖRFERSTR. (CDE0021)   SH  54,54; 9,64
  … 18 weitere, bis hinunter zur AALBEK

Überwachte Flüsse nach Jahr: 2018 12.118 · 2019 4.265 · 2020 7.042 · 2021 8.657 ·
  2022 9.155 · 2023 7.894 · 2024 11.883 t/a
2024 war der höchste Wert seit 2018, lag aber noch knapp unter 2018.
Quelle: © Datenlieferanten über BfG/UBA (MUDAB). Die Nutzungsbedingungen sind nicht als offen angegeben.
```

Als Nächstes angeboten: dieselbe Aufschlüsselung für Gesamtphosphor (`Ptot`) oder die Jahresreihe eines Flusses (die Tabelle reicht bis 1994 zurück).

## mudab-parameters

> Wird PFOS in MUDAB gemessen, und in welchen Kompartimenten? Welcher Code wird dafür gebraucht?

```bash
mudab parameters --all --compact                          # 889 Zeilen: PFOS nur unter CF
mudab parameters --compartment wasser --all --compact
mudab parameters --compartment sediment --all --compact
mudab parameters --compartment biota --all --compact
mudab parameters --compartment biologie --all --compact
```

Die Gesamttabelle hat eine Zeile pro Parametercode und führte PFOS (und sogar Quecksilber) daher
nur unter Biota. Um die Frage nach den Kompartimenten zu beantworten, hat der Skill jeden
Kompartiment-Endpunkt einzeln abgefragt. 119 Zeilen haben keinen Gruppennamen, deshalb nutzt der
Gruppenfilter `(.PARAMGROUP_NAME // "")`.

```
PFOS: Parametercode PFOS, Gruppe Organofluorines (O-FL)
  „Perfluorooctanyl sulphonic acid - branched + linear forms"

  Kompartiment     PFOS   Organofluor-Codes insgesamt
  Wasser (CW)      ja     16
  Sediment (CS)    ja      9
  Biota (CF)       ja     34
  Biologie (BL)    nein    0   (16 Parameter: Biomasse, Abundanz, Standortbedingungen)

Verwandte Codes in allen drei Kompartimenten: PFOA, PFHXS, PFBS, PFDA, PFHXA, PFHPA, PFOSA.
In Biota außerdem Summen der linearen Isomere (n-PFOS, n-PFHXS, n-PFDS), ADONA und HFPO-DA.
TFA ist für Wasser und Biota geführt.
```

Als Nächstes angeboten: PFOS-Messwerte mit **mudab-measurements** abrufen, abgeglichen über `PARAMCODE_PM`.

## mudab-stations

> Wer betreibt die MUDAB-Messstationen in der Ostsee, und wie viele Stationen hat jedes Institut?

```bash
mudab project-stations --all --compact > project-stations.json   # 1.948 Zeilen
jq '[.[] | select(.REGION=="Ostsee")] | group_by(.INSTITUT) | …' project-stations.json
mudab stations --all --compact > stations.json                   # 83.916 Zeilen, 9,4 MB
jq --slurpfile ps project-stations.json '… join on NAME_PS, count distinct STATNAME_ST per institute …' stations.json
```

Messstationen haben keine Region, deshalb hat der Skill sie über `NAME_PS` mit den
Projektstationen verknüpft. `NAME_PS` ist nicht eindeutig: 8 Namen kommen mit zwei Instituten
oder Regionen vor (z. B. `Darss Sill`: IOW und BSH; `L1`: Ostsee und Nordsee), die Zählungen für
diese Namen sind also nur näherungsweise richtig.

```
MUDAB Ostsee: 802 von 1948 Projektstations-Zeilen (Nordsee 1146)

  INSTITUT   Projektstationen   Messstationen   nach Kompartiment
  IOW          248                9.876          CW 9.683 · CS 188 · BL 47 · CF 1
  LLUR         132                2.371          CW 2.195 · CS 128 · BL 119 · CF 44
  BFN          100                    0          keine verknüpft (z. B. BfN_SWAL_N2K_E1_5)
  LUNG          82                5.337          CW 5.164 · CF 103 · BL 80 · CS 72
  BSH           78                1.423          CW 1.388 · CS 190
  DESH          56                   12          MM 12
  DEMV          49                    3          MM 3
  VTIFOE        47                  175          CW 127 · CF 44 · CS 5
  LALLF / UPB    3 / 3             61 / 17       überwiegend CF (Biota)
  (ohne Institut) 4                  26          CW 23 · CS 4

Die meisten sind Wasser-Stationen (CW). IOW und LUNG stellen fast vier Fünftel davon.
MM steht nicht in der Tabelle der Kompartiment-Codes (`mudab compartments`).
```

Als Nächstes angeboten: was gemessen wird (**mudab-parameters**) oder die Messwerte einer Station, z. B. `OMMVZBA15` (LUNG).
