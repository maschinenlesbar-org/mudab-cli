// A mock of the MUDAB API for the use cases (operations.ts) and the MCP server's tests: every
// endpoint answers POST only, honours the body's range (and nothing else, like the live server),
// and wraps the rows under the live key. The rows are live rows of 2026-11-19, a few per trap:
// the stations table repeats rows and lists a station per compartment; the measurement table repeats
// rows exactly (most of them, live); L1 is a project station
// of BSH/Nordsee and IOW/Ostsee; mercury is under biota only in the combined parameter table, but
// in the water, sediment and biota lists; the measurement table mixes units within a parameter;
// PLC values hold nulls, a 2014 kg/a river value, an incomplete last year, and the unmonitored
// areas, larger than any river.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import { WRAPPER_KEYS } from "../src/client.js";
import { jsonResponse } from "./helpers.js";
import type { HelcomPLCStation, Messstation, MesswertPLC, Parameter, ParameterPLC, ParameterValue, ProjectStation } from "../src/types.js";

export interface Tables {
  stations: Messstation[];
  projectStations: ProjectStation[];
  parameters: Parameter[];
  parametersWasser: Parameter[];
  parametersSediment: Parameter[];
  parametersBiota: Parameter[];
  parametersBiologie: Parameter[];
  measurements: ParameterValue[];
  plcStations: HelcomPLCStation[];
  plcParameters: ParameterPLC[];
  plcMeasurements: MesswertPLC[];
}

const station = (name: string, project: string, type: string | null, compartment: string): Messstation => ({ metadataid: 32, STATNAME_ST: name, NAME_PS: project, STATIONTYPE_ST: type, COMPT_DS: compartment });
const project = (id: number, name: string, region: string, institute: string | null): ProjectStation => ({ metadataid: 31, PROJECTSTATIONID: id, NAME_PS: name, REGION: region, INSTITUT: institute });
const parameter = (compartment: string, code: string, name: string, group: string | null, groupName: string | null): Parameter => ({ metadataid: 33, COMPT_DS: compartment, PARAMETER: code, PARAMETERGRUPPE: group, PARAM_NAME: name, PARGROUP: group, PARAMGROUP_NAME: groupName });
const value = (stationName: string, code: string, id: string, date: string, time: string, v: number): ParameterValue => ({ metadataid: 39, STATNAME_ST: stationName, PARAMETERID_PM: id, STATNAME_DATE_TIME: `${stationName} ${date} ${time}`, PARAMCODE_PM: code, DATE_STM: date, TIME_STM: time, VALUE_MS: v });
const plcStation = (code: string, land: string, name: string, lat: number | null, lon: number | null, river: string, type: string): HelcomPLCStation => ({ metadataid: 112, STATION_CODE: code, LAND_CD: land, STATION_NAME: name, ST_LAT: lat, ST_LON: lon, SUBCM_CODE: `S${code}`, SUBCM_NAME: river, MON_TYPE: type });
const load = (s: HelcomPLCStation, name: string, year: string, v: number | null, unit = "t/a", type = "TOT"): MesswertPLC => ({
  metadataid: 111, VALUE: v, NAME: name, STATION_CODE: s.STATION_CODE, LAND_CD: s.LAND_CD, STATION_NAME: s.STATION_NAME, ST_LAT: s.ST_LAT, ST_LON: s.ST_LON,
  SUBCM_CODE: s.SUBCM_CODE, SUBCM_NAME: s.SUBCM_NAME, MON_TYPE: s.MON_TYPE, PARAM_ID: "16", PERIOD_NAME: year, PERIOD_TYPE: "A", NUMMER: 1, PARAM_TYPE: type, AREA: 100, VAL_UNIT: unit,
});

const PEENE = plcStation("CDE0007", "MV", "ANKLAM", 53.85, 13.6833, "PEENE", "MON_RIVER_LOAD");
const WARNOW = plcStation("CDE0017", "MV", "ROSTOCK", 54.0833, 12.15, "WARNOW", "MON_RIVER_LOAD");
const TRAVE = plcStation("CDE0030", "SH", "MOISLING", 53.84, 10.63, "TRAVE", "MON_RIVER_LOAD");
const SCHWARTAU = plcStation("CDE0032", "XX", "AN DER KALTENHÖFERSTRASSE", 53.9195, 10.7176, "SCHWARTAU", "MON_RIVER_LOAD");
const BARTHE_FLOW = plcStation("HDE0001", "MV", "REDEBAS", 54.3667, 12.6833, "BARTHE", "STAT_FL_CONC");
const LUEBECK = plcStation("MDE0070", "SH", "ZKW LÜBECK", 53.8869, 10.6981, "WEBDESEA", "MUNCP_FL_LD");
const MAASHOLM = plcStation("MDE0144", "MV", "MAASHOLM", null, null, "WEBDESEA", "MUNCP_FL_LD");
const WEBDELAND = plcStation("SCDE00136", "UNMON", "WEBDELAND", 0, 0, "WEBDELAND", "UNMONITORED");

/** The sample tables (fresh arrays each call). */
export function sampleTables(): Tables {
  return {
    projectStations: [
      project(374, "WB1", "Nordsee", "BSH"),
      project(55, "L1", "Ostsee", "IOW"),
      project(464, "L1", "Nordsee", "BSH"),
      project(396, "L1", "Nordsee", "BSH"),
      project(622, "Darss Sill", "Ostsee", "IOW"),
      project(207, "N3.1", "Nordsee", null),
      project(9001, "OMMVZBA15", "Ostsee", "LUNG"),
      project(9002, "BFN1", "Nordsee", "BFN"),
    ],
    stations: [
      station("220051", "220051", "Sublitoral", "BL"),
      station("220051", "220051", "Sublitoral", "CW"),
      station("220051", "220051", "Sublitoral", "BL"),
      station("Darss Sill", "Darss Sill", "Normal", "CW"),
      station("Darss Sill", "Darss Sill", "Normal", "CW"),
      station("Darss Sill_1", "Darss Sill", "Normal", "CW"),
      station("L1_(1)", "L1", "Normal", "CW"),
      station("WB1", "WB1", "Normal", "CS"),
      station("OMMVZBA15", "OMMVZBA15", "Sublitoral", "CW"),
      station("OMMVZBA15", "OMMVZBA15", "Sublitoral", "BL"),
      station("OMMVZBA15#305421", "OMMVZBA15", "Normal", "BL"),
      station("OMMVZBA15_CW", "OMMVZBA15", null, "CW"),
    ],
    parameters: [
      parameter("CW", "24DP", "Dichloroprop", "O-GPT", "Pesticides (general)"),
      parameter("MM", "HGTOR", "total organic mercury", "O-MET", "Organo-metallic compounds"),
      parameter("CW", "PHOS", "phosphate (PO4-P)", "I-NUT", "Nutrients"),
      parameter("CF", "HG", "mercury", "I-MET", "Metals and metalloids"),
      parameter("CS", "PTOT", "total phosphorus (P)", "I-NUT", "Nutrients"),
      parameter("CS", "NTOT", "total nitrogen (N)", "I-NUT", "Nutrients"),
      parameter("CW", "_ID486", "*deprecated* Nitrobenz.", null, null),
    ],
    parametersWasser: [
      parameter("CW", "NTOT", "total nitrogen (N)", "I-NUT", "Nutrients"),
      parameter("CW", "PTOT", "total phosphorus (P)", "I-NUT", "Nutrients"),
      parameter("CW", "PHOS", "phosphate (PO4-P)", "I-NUT", "Nutrients"),
      parameter("CW", "HG", "mercury", "I-MET", "Metals and metalloids"),
      parameter("CW", "24DP", "Dichloroprop", "O-GPT", "Pesticides (general)"),
    ],
    parametersSediment: [
      parameter("CS", "HG", "mercury", "I-MET", "Metals and metalloids"),
      parameter("CS", "NTOT", "total nitrogen (N)", "I-NUT", "Nutrients"),
      parameter("CS", "PTOT", "total phosphorus (P)", "I-NUT", "Nutrients"),
    ],
    parametersBiota: [parameter("CF", "HG", "mercury", "I-MET", "Metals and metalloids")],
    parametersBiologie: [parameter("BL", "BMDRYWT", "Biomass - dry weight", "B-COM", "Biological community parameters")],
    measurements: [
      value("OMMVZBA15", "SurTemp", "APSurTemp THRNFNON degC IFAG", "20111019", "0849", 11.8),
      value("OMMVZBA15", "SurTemp", "APSurTemp THRNFNON degC IFAG", "20111019", "0849", 11.8),
      value("OMMVZBA15", "SurTemp", "APSurTemp THRNFNON degC IFAG", "20111019", "0849", 11.8),
      value("OMMVZBA15", "SurTemp", "APSurTemp THRNFNON degC IFAG", "20111019", "0853", 11.6),
      value("OMMVZBA15", "SurTemp", "APSurTemp THRNFNON degC IFAG", "20120510", "1000", 9.4),
      value("OMMVZBA15", "WAVHT", "APWAVHT VISONANON m IFAG", "20130429", "0900", 0.5),
      value("OMMVZBA15", "WAVHT", "APWAVHT VISONANON sc LNUG", "20130604", "0755", 2),
      value("OMMVZBA15_CW", "WAVHT", "APWAVHT VISONFNON m IFAG", "20211117", "1400", 1.4),
      value("220051", "WAVHT", "APWAVHT VISONANON sc LNUG", "20130604", "0755", 1),
      value("S66", "AIRTEMP", "APAIRTEMP THRNFNON LUNG", "20070103", "0828", 5.9),
      value("S66", "AIRTEMP", "APAIRTEMP THRNFNON degC LUNG", "20070104", "0830", 6.1),
      value("DB16", "AIRTEMP", "2D 35 35 APTEMP 151 NFNON degC BSHG", "19990101", "1200", -2.5),
      value("DB16", "_CLOUD", "1D 25 25 APCLOUD 151 NFNON sc BSHG", "19990101", "1200", 6),
    ],
    plcStations: [PEENE, WARNOW, TRAVE, SCHWARTAU, { ...SCHWARTAU, LAND_CD: "SH" }, SCHWARTAU, BARTHE_FLOW, LUEBECK, LUEBECK, MAASHOLM, WEBDELAND],
    plcParameters: [
      { metadataid: 110, STATION_CODE: "CDE0007", PRKEY: "CDE0007 Ntot", ANZ_MESSWERTE: 30, LETZTE_MESSUNG: "2025", STATION_NAME: "ANKLAM", SUBCM_CODE: "SCDE00039", SUBCM_NAME: "PEENE", PARAMETER: "Ntot", PARAMETERGRUPPE: "TOT" },
      { metadataid: 110, STATION_CODE: "CDE0017", PRKEY: "CDE0017 Ntot", ANZ_MESSWERTE: 28, LETZTE_MESSUNG: "2024", STATION_NAME: "ROSTOCK", SUBCM_CODE: "SCDE00069", SUBCM_NAME: "WARNOW", PARAMETER: "Ntot", PARAMETERGRUPPE: "TOT" },
      { metadataid: 110, STATION_CODE: "CDE0007", PRKEY: "CDE0007 Hg", ANZ_MESSWERTE: 20, LETZTE_MESSUNG: "2024", STATION_NAME: "ANKLAM", SUBCM_CODE: "SCDE00039", SUBCM_NAME: "PEENE", PARAMETER: "Hg", PARAMETERGRUPPE: "TOT" },
    ],
    plcMeasurements: [
      load(PEENE, "Ntot", "2023", 2500.1),
      load(WARNOW, "Ntot", "2023", 1500.2),
      load(TRAVE, "Ntot", "2023", 1400.3),
      load(SCHWARTAU, "Ntot", "2023", 300.4),
      load(PEENE, "Ntot", "2024", 2796.507925),
      load(WARNOW, "Ntot", "2024", 1656.518409),
      load(TRAVE, "Ntot", "2024", 1536.256267),
      load(SCHWARTAU, "Ntot", "2024", null),
      load(PEENE, "Ntot", "2025", 2600),
      load(PEENE, "Hg", "2013", 0.02),
      load(PEENE, "Hg", "2014", 0.0299, "kg/a"),
      load(LUEBECK, "Ntot", "2024", 120.5),
      load(MAASHOLM, "Ntot", "2024", 3.2),
      load(WEBDELAND, "Ntot", "2024", 5000.7),
      load(BARTHE_FLOW, "FLOW", "2024", 3.203, "m3/s", "AVE"),
      load(LUEBECK, "FLOW", "2024", 21_000_000, "m3/a"),
    ],
  };
}

/** The path of each table, with the key the API is fixed to answer under. */
const ROUTES: Record<string, keyof Tables> = {
  "/STATION_SMALL": "stations",
  "/PROJECTSTATION_SMALL": "projectStations",
  "/MV_PARAMETER": "parameters",
  "/MV_PARAMETER_WASSER": "parametersWasser",
  "/MV_PARAMETER_SEDIMENT": "parametersSediment",
  "/MV_PARAMETER_BIOTA": "parametersBiota",
  "/MV_PARAMETER_BIOLOGIE": "parametersBiologie",
  "/MV_STATION_MSMNT": "measurements",
  "/V_PLC_STATION": "plcStations",
  "/V_GEMESSENE_PARA_PLC": "plcParameters",
  "/V_MESSWERTE_PLC": "plcMeasurements",
};

/** The requests the mock answered, by table, with their range. */
export interface ApiLog {
  requests: { table: string; from?: number; count?: number }[];
  of(table: string): number;
}

export function apiLog(): ApiLog {
  const requests: ApiLog["requests"] = [];
  return { requests, of: (table) => requests.filter((r) => r.table === table).length };
}

/**
 * The responder of the mock API over `tables`: POST only (anything else 405), the path's last
 * segment names the table, the body's range selects the rows (from, count; no range: all).
 */
export function mudabApi(tables: Tables = sampleTables(), log: ApiLog = apiLog()): (req: HttpRequest) => HttpResponse {
  return (req) => {
    if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
    const path = `/${new URL(req.url).pathname.split("/").pop() ?? ""}`;
    const table = ROUTES[path];
    if (table === undefined) return jsonResponse({ error: "not found" }, 404);
    const body = JSON.parse(req.body === undefined ? "{}" : req.body.toString()) as { range?: { from?: number; count?: number } };
    const rows = tables[table] as unknown[];
    const from = body.range?.from ?? 0;
    const count = body.range?.count ?? rows.length;
    log.requests.push({ table: path.slice(1), ...(body.range === undefined ? {} : { from, count }) });
    return jsonResponse({ [WRAPPER_KEYS[path] as string]: rows.slice(from, from + count) });
  };
}
