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
| **Messwert** | `measurements` | Ein einzelner Wert an einer Station: `STATNAME_ST`, `PARAMCODE_PM`, `DATE_STM` (YYYYMMDD), `TIME_STM` (HHMM), `VALUE_MS` (der Wert, ein **String**). Eine sehr große Tabelle. |
| **HELCOM PLC** | `plc-*` | Die *Pollution Load Compilation* der HELCOM – die regelmäßige Bewertung der Schadstoff-**Frachten**, die Flüsse in die Ostsee (und hier sinngemäß ins Meer) eintragen. |
| **PLC-Station** | `plc-stations` | Eine Messstation an einer Flussmündung, die Frachten überwacht: `STATION_NAME`, `STATION_CODE`, `LAND_CD` (Bundesland), `ST_LAT`/`ST_LON`, `MON_TYPE` (z. B. `MON_RIVER_LOAD`). |
| **PLC-Messwert** | `plc-measurements` | Ein jährlicher Frachtwert: `NAME` (Parameter, z. B. `Ptot`), `VALUE` (eine **Zahl**), `VAL_UNIT`, `PERIOD_NAME` (Jahr), `LAND_CD`, Koordinaten. |
| **Bereich** (`from`/`count`) | `--from`/`--count`/`--all` | Die einzige Paginierung bzw. Auswahl, die der Server berücksichtigt. `from` ist Pflicht, sobald ein Bereich gesendet wird. Standardwert für `count` ist 100. |
| **Filter / OrderBy** | *(nicht verfügbar)* | In der OpenAPI-Spezifikation vorhanden, aber **vom Live-Server ignoriert** – siehe [DEVELOPING.md](DEVELOPING.md). Filtern und sortieren Sie clientseitig (z. B. mit `jq`). |

## Einen Wert lesen

- **Die Einheiten unterscheiden sich je Parameter.** Bei PLC-Messwerten steht die Einheit in
  `VAL_UNIT`; bei Stationsmesswerten sind Einheit und Methode in `PARAMETERID_PM` codiert.
- **`VALUE_MS` (Station) ist ein String; `VALUE` (PLC) ist eine Zahl.** Wandeln Sie den Wert vor
  Berechnungen um, und rechnen Sie gelegentlich mit nicht numerischen Qualitätskennzeichen.
- **Datumsangaben sind Strings ohne Trennzeichen** – `DATE_STM` = `YYYYMMDD`, `TIME_STM` = `HHMM`.
