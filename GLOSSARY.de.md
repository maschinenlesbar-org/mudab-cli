# Glossar

MUDAB-Fachbegriffe, so wie die CLI sie bereitstellt. Die Bezeichnungen in den Daten sind deutsch;
übernehmen Sie sie unverändert.

| Begriff | In der CLI | Bedeutung |
|---|---|---|
| **MUDAB** | – | Meeresumweltdatenbank: qualitätsgesicherte Daten des Meeresmonitorings der Küstenländer und Forschungseinrichtungen, bereitgestellt von der Bundesanstalt für Gewässerkunde (BfG) und veröffentlicht vom Umweltbundesamt (UBA). |
| **Messstation** | `stations` | Ein physischer Messort, an dem Proben genommen werden. Felder: `STATNAME_ST` (Name), `STATIONTYPE_ST` (Typ), `COMPT_DS` (Kompartiment), `NAME_PS` (zugehörige Projektstation). |
| **Projektstation** | `project-stations` | Das Monitoringprojekt bzw. -programm, zu dem eine Station gehört. Felder: `NAME_PS`, `REGION` (`Nordsee`/`Ostsee`), `INSTITUT` (z. B. `BSH`). |
| **Parameter** | `parameters` | Eine Messgröße – ein Schadstoff, ein Nährstoff oder eine biologische/physikalische Kenngröße. Felder: `PARAMETER` (Kürzel), `PARAM_NAME` (Name), `PARAMETERGRUPPE`/`PARAMGROUP_NAME` (Gruppe), `COMPT_DS`. |
| **Kompartiment** (`COMPT_DS`) | `compartments` | Das Umweltmedium, zu dem ein Wert gehört. Bekannte Codes: `CW` = Wasser, `CS` = Sediment, `CF` = Biota, `BL` = Biologie. **Nicht abschließend** – z. B. kommt auch `MM` vor. |
| **Messwert** | `measurements` | Ein einzelner Wert an einer Station: `STATNAME_ST`, `PARAMCODE_PM`, `DATE_STM` (YYYYMMDD), `TIME_STM` (HHMM), `VALUE_MS` (der Wert, eine **Zahl**). Die größte Tabelle (ca. 187.000 Zeilen, ca. 42 MB am 15.09.2026). |
| **HELCOM PLC** | `plc-*` | Die *Pollution Load Compilation* der HELCOM – die regelmäßige Bewertung der über Gewässer eingetragenen Nährstoff- und Schadstoff-**Frachten** in die Ostsee. Die Daten hier decken deutsche Ostsee-Einzugsgebiete ab (`LAND_CD` `MV`/`SH`) und enthalten überwachte Flussfrachten, kommunale Punktquellen, Abflüsse und Frachten aus nicht überwachten Gebieten (siehe `MON_TYPE`). |
| **PLC-Station** | `plc-stations` | Ein Messpunkt für Frachten: `STATION_NAME`, `STATION_CODE`, `LAND_CD` (Bundesland oder `UNMON`/`XX`), `ST_LAT`/`ST_LON`, `MON_TYPE`: `MON_RIVER_LOAD` (überwachter Fluss), `MUNCP_FL_LD` (kommunale Kläranlage), `STAT_FL_CONC` (Abflusspegel) oder `UNMONITORED` (Pseudostation für nicht überwachte Gebiete, Koordinaten 0/0). |
| **PLC-Messwert** | `plc-measurements` | Ein jährlicher Fracht- oder Abflusswert: `NAME` (Parameter, z. B. `Ptot`, `FLOW`), `VALUE` (eine **Zahl**, manchmal `null`), `VAL_UNIT`, `PERIOD_NAME` (Jahr), `MON_TYPE`, `LAND_CD`, Koordinaten. |
| **Bereich** (`from`/`count`) | `--from`/`--count`/`--all` | Die einzige Paginierung bzw. Auswahl, die der Server berücksichtigt. `from` ist Pflicht, sobald ein Bereich gesendet wird. Standardwert für `count` ist 100. |
| **Filter / OrderBy** | *(nicht verfügbar)* | In der OpenAPI-Spezifikation vorhanden, aber **vom Live-Server ignoriert** – siehe [DEVELOPING.md](DEVELOPING.md). Filtern und sortieren Sie clientseitig (z. B. mit `jq`). |

## Einen Wert lesen

- **Die Einheiten unterscheiden sich je Parameter.** Bei PLC-Messwerten steht die Einheit in
  `VAL_UNIT`; bei Stationsmesswerten sind Einheit und Methode in `PARAMETERID_PM` codiert.
- **`VALUE_MS` (Station) und `VALUE` (PLC) sind Zahlen.** Eine Umwandlung ist nicht nötig;
  `VALUE` kann `null` sein, entfernen Sie `null`-Werte daher vor Berechnungen.
- **Datumsangaben sind Strings ohne Trennzeichen** – `DATE_STM` = `YYYYMMDD`, `TIME_STM` = `HHMM`.
