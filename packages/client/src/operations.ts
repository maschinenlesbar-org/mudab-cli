// The use cases of the skills as library functions, built on the resources: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
//
// MUDAB filters nothing on the server: every selection reads the table (in pages under the
// size cap, `readPages`) and selects here. The traps:
// - the stations table repeats rows and lists a station once per compartment: stations are
//   counted by name, never by row;
// - region and institute live on the project stations, joined by the project-station name, and a
//   name can carry several (conflicting) ones: every one is listed, none picked;
// - the combined parameter table lists a code under one compartment: whether a substance is
//   measured in a compartment is asked of each compartment's own list;
// - the station measurement table holds weather and sea observations only, and its units vary
//   within one parameter (WAVHT in m and on a scale): a series is a station, a parameter and a
//   unit; it is the largest table (~190,000 rows), so it is read once and kept for a while;
// - HELCOM PLC rows are not all river loads (MON_TYPE): river loads unless asked otherwise;
//   values can be null (dropped, counted) and units differ (t/a, kg/a: never added together).
//
// Every function reports ambiguity (several matches: `ambiguous` with the candidates) and an
// empty answer says what was searched and what to change. Each has a named result type (public
// API of the CLI package: a changed shape is a `feat(client)!:` commit). The kit passes a tool
// call's signal through the transport, so no function takes one.

import type { MudabClient } from "./client.js";
import { quoteServerText } from "./engine.js";
import { MudabParseError, MudabValidationError, cutForMessage } from "./errors.js";
import type { HelcomPLCStation, ListRequest, Messstation, MesswertPLC, Parameter, ParameterPLC, ParameterValue, ProjectStation } from "./types.js";
import { assertValid, normalizeToken, tokenProblem } from "./validate.js";

// --- Reading whole tables -----------------------------------------------------------------

/** The tables, by the client's method names. */
export const TABLES = ["stations", "projectStations", "parameters", "measurements", "plcStations", "plcParameters", "plcMeasurements"] as const;
export type TableName = (typeof TABLES)[number];

/** The endpoint of each table, for a result's source. */
export const TABLE_PATHS: Readonly<Record<TableName, string>> = {
  stations: "STATION_SMALL",
  projectStations: "PROJECTSTATION_SMALL",
  parameters: "MV_PARAMETER",
  measurements: "MV_STATION_MSMNT",
  plcStations: "V_PLC_STATION",
  plcParameters: "V_GEMESSENE_PARA_PLC",
  plcMeasurements: "V_MESSWERTE_PLC",
};

/**
 * Rows per page, so a page stays well under the MCP server's 16 MiB answer cap (sizes of
 * 2026-11-19: measurements ~225 bytes a row, 30,000 rows 6.4 MB; stations ~110 bytes, 60,000
 * rows 6.7 MB; PLC values ~350 bytes, 19,711 rows 6.8 MB in all). The small tables fit one page.
 */
export const PAGE_ROWS: Readonly<Record<TableName, number>> = {
  stations: 60_000,
  projectStations: 20_000,
  parameters: 20_000,
  measurements: 30_000,
  plcStations: 20_000,
  plcParameters: 20_000,
  plcMeasurements: 25_000,
};

/** The most pages a function reads of one table unless told otherwise (`maxPages`). */
export const DEFAULT_MAX_PAGES = 10;

/** The four compartments with their own parameter list, by `COMPT_DS` code. */
const COMPARTMENT_LISTS = { CW: "wasser", CS: "sediment", CF: "biota", BL: "biologie" } as const;

type Fetch<T> = (req: ListRequest) => Promise<T[]>;

/** How to read a table's page through the client. */
function fetcher(client: MudabClient, table: TableName, compartment?: (typeof COMPARTMENT_LISTS)[keyof typeof COMPARTMENT_LISTS]): Fetch<Record<string, unknown>> {
  const fetchers: Record<TableName, Fetch<unknown>> = {
    stations: (req) => client.stations(req),
    projectStations: (req) => client.projectStations(req),
    parameters: (req) => client.parameters(req, compartment),
    measurements: (req) => client.measurements(req),
    plcStations: (req) => client.plcStations(req),
    plcParameters: (req) => client.plcParameters(req),
    plcMeasurements: (req) => client.plcMeasurements(req),
  };
  return fetchers[table] as Fetch<Record<string, unknown>>;
}

/** What `readPages` read: the rows, and whether that was the whole table. */
export interface PagesRead {
  rows: number;
  pages: number;
  /** False when `maxPages` full pages were read and the table may go on. */
  complete: boolean;
}

/**
 * Read a table page by page (`pageRows` rows each, one request after the other), handing each page
 * to `each`, until a page is short (the table's end) or `maxPages` pages are read. The server
 * honours only the range, so this is how a whole table is read without one answer over the size cap.
 */
export async function readPages<T>(fetch: Fetch<T>, pageRows: number, maxPages: number, each: (rows: T[]) => void): Promise<PagesRead> {
  let rows = 0;
  for (let page = 0; page < maxPages; page++) {
    const got = await fetch({ range: { from: page * pageRows, count: pageRows } });
    each(got);
    rows += got.length;
    if (got.length < pageRows) return { rows, pages: page + 1, complete: true };
  }
  return { rows, pages: maxPages, complete: false };
}

/**
 * The fields the use cases read of each table, by type (null is "no value" and always allowed), and
 * the ones they can't do without (`key`: present in some row of every page). The client checks the
 * wrapper and that rows are objects; this checks what the answers are computed from, so a change
 * of MUDAB's rows (a value sent as text, a renamed field) is an error, never "no value" or "no match".
 * Columns have one type each (the rows come from database views), and live rows of 2026-11-24 have
 * these types.
 */
const FIELDS: Readonly<Record<TableName, { text: readonly string[]; number: readonly string[]; key: readonly string[] }>> = {
  stations: { text: ["STATNAME_ST", "NAME_PS", "STATIONTYPE_ST", "COMPT_DS"], number: [], key: ["STATNAME_ST", "NAME_PS", "COMPT_DS"] },
  projectStations: { text: ["NAME_PS", "REGION", "INSTITUT"], number: ["PROJECTSTATIONID"], key: ["NAME_PS", "REGION", "INSTITUT"] },
  parameters: { text: ["PARAMETER", "COMPT_DS", "PARAM_NAME", "PARAMGROUP_NAME", "PARAMETERGRUPPE"], number: [], key: ["PARAMETER", "PARAM_NAME"] },
  measurements: { text: ["STATNAME_ST", "PARAMETERID_PM", "PARAMCODE_PM", "DATE_STM", "TIME_STM"], number: ["VALUE_MS"], key: ["STATNAME_ST", "PARAMCODE_PM", "DATE_STM", "VALUE_MS"] },
  plcStations: { text: ["STATION_NAME", "STATION_CODE", "LAND_CD", "SUBCM_NAME", "MON_TYPE"], number: ["ST_LAT", "ST_LON"], key: ["STATION_NAME", "STATION_CODE", "LAND_CD", "MON_TYPE"] },
  plcParameters: { text: ["PARAMETER", "PARAMETERGRUPPE", "STATION_CODE", "LETZTE_MESSUNG"], number: ["ANZ_MESSWERTE"], key: ["PARAMETER", "STATION_CODE"] },
  plcMeasurements: { text: ["NAME", "STATION_CODE", "STATION_NAME", "PARAM_TYPE", "PERIOD_NAME", "LAND_CD", "SUBCM_NAME", "MON_TYPE", "VAL_UNIT"], number: ["VALUE"], key: ["NAME", "STATION_CODE", "PERIOD_NAME", "MON_TYPE", "VALUE"] },
};

/** A value as an error names it: its type, and a short quote of a text or number. */
function shapeOf(value: unknown): string {
  if (typeof value === "string") return `the text ${quoteServerText(cutForMessage(value))}`;
  if (typeof value === "number" || typeof value === "boolean") return `the ${typeof value} ${String(value)}`;
  return Array.isArray(value) ? "an array" : `an ${typeof value}`;
}

const CHANGED = "MUDAB's rows have changed shape, so this answer can't be computed from them (this is no empty result); try again later, and report it if it stays.";

/** Throws a MudabParseError when a page's rows aren't of the shape the use cases read ({@link FIELDS}). */
function checkRows(table: TableName, path: string, rows: readonly Record<string, unknown>[]): void {
  const fields = FIELDS[table];
  for (const row of rows) {
    for (const [names, type, wanted] of [[fields.text, "string", "a text"], [fields.number, "number", "a number"]] as const) {
      for (const name of names) {
        const value = row[name];
        if (value != null && typeof value !== type) throw new MudabParseError(`${path}: field ${name} is ${shapeOf(value)}, where ${wanted} was; ${CHANGED}`);
      }
    }
  }
  if (rows.length === 0) return;
  for (const name of fields.key) {
    if (!rows.some((row) => Object.hasOwn(row, name))) throw new MudabParseError(`${path}: no row of the page has the field ${name}; ${CHANGED}`);
  }
}

/** The error for a whole table that answered no rows: these tables are never empty. */
const noRows = (path: string): MudabParseError =>
  new MudabParseError(`${path} answered no rows at all, which this table never does: the API may have changed or failed, so this is no empty result; try again later.`);

/** The endpoint of a table (a compartment's own parameter list has its own). */
const pathOf = (table: TableName, compartment?: string): string => (compartment === undefined ? TABLE_PATHS[table] : `${TABLE_PATHS[table]}_${compartment.toUpperCase()}`);

/** A whole (small) table's rows, checked ({@link checkRows}); a table without any row is an error. */
async function readTable<T>(client: MudabClient, table: TableName, maxPages: number, compartment?: (typeof COMPARTMENT_LISTS)[keyof typeof COMPARTMENT_LISTS]): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  const path = pathOf(table, compartment);
  const read = await readPages(fetcher(client, table, compartment), PAGE_ROWS[table], maxPages, (page) => {
    checkRows(table, path, page);
    for (const row of page) rows.push(row as T);
  });
  if (read.rows === 0) throw noRows(path);
  return { rows, complete: read.complete };
}

/** The note for a table read only in part. */
const partNote = (table: TableName, maxPages: number): string =>
  `Only the first ${maxPages} pages (${maxPages * PAGE_ROWS[table]} rows) of ${TABLE_PATHS[table]} were read; the table goes on, so counts may be low.`;

// --- Input rules --------------------------------------------------------------------------

/** `text` folded for matching: lower case, umlauts and ß spelt out, accents dropped, anything else but letters and digits one space. */
export function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A text input, checked (not blank, nothing invisible) and trimmed; undefined stays undefined. */
function textInput(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return normalizeToken(assertValid(field, value as string, tokenProblem));
}

/**
 * A text matched by its letters and digits (`fold`), checked like `textInput`: one without any (only
 * punctuation, "-", "()") folds to nothing, which every name contains, so it is refused rather
 * than answered as if it had filtered.
 */
function matchInput(field: string, value: unknown): string | undefined {
  const text = textInput(field, value);
  if (text !== undefined && fold(text) === "") {
    throw new MudabValidationError(`Invalid ${field}: ${JSON.stringify(cutForMessage(text))} has no letter or digit; names are matched on their letters and digits, so it would match everything.`);
  }
  return text;
}

/** A whole number in [min, max], or the fallback. */
function intInput(field: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new MudabValidationError(`Invalid ${field}: expected a whole number from ${min} to ${max}, got ${cutForMessage(String(value))}.`);
  }
  return value;
}

/** One of `choices` (folded aliases to the value), or a validation error naming them. */
function choose<T extends string>(field: string, value: string | undefined, aliases: Record<string, T>, choices: string): T | undefined {
  if (value === undefined) return undefined;
  const found = aliases[fold(value)];
  if (found === undefined) throw new MudabValidationError(`Invalid ${field}: expected ${choices}, got ${JSON.stringify(cutForMessage(value))}.`);
  return found;
}

const REGIONS: Record<string, string> = { nordsee: "Nordsee", "north sea": "Nordsee", north: "Nordsee", ostsee: "Ostsee", "baltic sea": "Ostsee", baltic: "Ostsee", "baltic proper": "Ostsee" };
const REGION_CHOICES = "Nordsee (North Sea) or Ostsee (Baltic Sea)";

const COMPARTMENTS: Record<string, string> = {
  cw: "CW", wasser: "CW", water: "CW",
  cs: "CS", sediment: "CS",
  cf: "CF", biota: "CF",
  bl: "BL", biologie: "BL", biology: "BL",
  mm: "MM",
};
const COMPARTMENT_CHOICES = "CW (Wasser, water), CS (Sediment), CF (Biota), BL (Biologie, biology) or MM";

/** The `COMPT_DS` code of a compartment name or code (`wasser`, `water`, `CW`). */
export function resolveCompartment(value: string): string {
  return choose("compartment", textInput("compartment", value), COMPARTMENTS, COMPARTMENT_CHOICES) as string;
}

const LANDS: Record<string, string> = {
  mv: "MV", "mecklenburg vorpommern": "MV", mecklenburg: "MV", "mecklenburg western pomerania": "MV",
  sh: "SH", "schleswig holstein": "SH",
  xx: "XX", unmon: "UNMON",
};
const LAND_CHOICES = "MV (Mecklenburg-Vorpommern), SH (Schleswig-Holstein), XX (not given) or UNMON (unmonitored areas)";

/** The PLC monitoring types (MON_TYPE), by the name a caller uses. */
export const PLC_KINDS = ["river", "flow", "treatmentPlant", "unmonitored", "all"] as const;
export type PlcKind = (typeof PLC_KINDS)[number];
const MON_TYPES: Record<Exclude<PlcKind, "all">, { type: string; label: string }> = {
  river: { type: "MON_RIVER_LOAD", label: "monitored river load" },
  flow: { type: "STAT_FL_CONC", label: "river flow gauge" },
  treatmentPlant: { type: "MUNCP_FL_LD", label: "municipal treatment plant" },
  unmonitored: { type: "UNMONITORED", label: "unmonitored area (pseudo-station)" },
};
const MON_LABELS: Record<string, string> = Object.fromEntries(Object.values(MON_TYPES).map(({ type, label }) => [type, label]));

/** A PLC kind, checked. */
function plcKind(value: unknown): PlcKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(PLC_KINDS as readonly string[]).includes(value)) {
    throw new MudabValidationError(`Invalid kind: expected one of ${PLC_KINDS.join(", ")}, got ${JSON.stringify(cutForMessage(String(value)))}.`);
  }
  return value as PlcKind;
}

/** The MON_TYPEs of a kind. */
const typesOf = (kind: PlcKind): string[] => (kind === "all" ? Object.values(MON_TYPES).map((m) => m.type) : [MON_TYPES[kind].type]);

/** True when the folded `haystack` contains the folded `needle` (both folded by the caller). */
const has = (haystack: string | null | undefined, needle: string): boolean => haystack != null && fold(haystack).includes(needle);

/** Unique, sorted, without null and empty. */
function uniq(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((v): v is string => v != null && v !== ""))].sort((a, b) => a.localeCompare(b, "de"));
}

/** A page of `items` and where the next one starts. */
function page<T>(items: T[], offset: number, limit: number): { items: T[]; nextOffset?: number } {
  const items_ = items.slice(offset, offset + limit);
  return offset + limit < items.length ? { items: items_, nextOffset: offset + limit } : { items: items_ };
}

/** `n` rounded to at most `digits` decimals. */
const round = (n: number, digits = 4): number => Math.round(n * 10 ** digits) / 10 ** digits;

/** `YYYYMMDD` as `YYYY-MM-DD`. */
const isoDay = (d: number | string): string => {
  const s = String(d);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/** A `YYYY-MM-DD` input as the number YYYYMMDD. */
function dayInput(field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  const day = m === null ? NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (m === null || Number.isNaN(day) || new Date(day).getUTCDate() !== Number(m[3])) {
    throw new MudabValidationError(`Invalid ${field}: expected a day as YYYY-MM-DD, got ${JSON.stringify(cutForMessage(String(value)))}.`);
  }
  return Number(`${m[1]}${m[2]}${m[3]}`);
}

/** The answer when several things match a name: the caller asks which one, never picks. */
export interface Ambiguous<S> {
  status: "ambiguous";
  searched: S;
  total: number;
  candidates: string[];
  reason: string;
}

/**
 * The one name in `names` that `query` means: the one identical to it (names that differ only in
 * case or punctuation are different names: "EIDER V Eider outer", "Eider V Eider outer"), else the
 * one equal to it folded, else the only one containing it. Several are ambiguous (sorted,
 * exact-length first); none is undefined.
 */
function pickName(names: Iterable<string>, query: string): { name: string; variants: string[] } | { candidates: string[] } | undefined {
  const q = fold(query);
  const all = [...names];
  const containing = all.filter((n) => fold(n).includes(q)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const identical = all.find((n) => n.normalize("NFC") === query);
  if (identical !== undefined) return { name: identical, variants: containing.filter((n) => n !== identical) };
  const exact = all.filter((n) => fold(n) === q);
  if (exact.length === 1) return { name: exact[0] as string, variants: containing.filter((n) => n !== exact[0]) };
  if (exact.length > 1) return { candidates: exact.sort() };
  if (containing.length === 1) return { name: containing[0] as string, variants: [] };
  if (containing.length > 1) return { candidates: containing };
  return undefined;
}

// --- findStations -------------------------------------------------------------------------

export const STATION_KINDS = ["measurement", "project", "plc"] as const;
export type StationKind = (typeof STATION_KINDS)[number];

export interface FindStationsInput {
  /** measurement (STATION_SMALL, the default), project (PROJECTSTATION_SMALL) or plc (V_PLC_STATION). */
  kind?: StationKind | undefined;
  /** Part of a station's name (for plc also the river or the station code). */
  name?: string | undefined;
  /** Nordsee / North Sea or Ostsee / Baltic Sea (measurement and project stations). */
  region?: string | undefined;
  /** The institute's code, e.g. BSH, IOW (measurement and project stations). */
  institute?: string | undefined;
  /** A compartment (measurement stations): CW/wasser, CS/sediment, CF/biota, BL/biologie, MM. */
  compartment?: string | undefined;
  /** The station type (measurement stations), e.g. Normal, Sublitoral, Drift. */
  stationType?: string | undefined;
  /** MV, SH or their names (plc stations). */
  land?: string | undefined;
  /** river, flow, treatmentPlant, unmonitored or all (plc stations; default all). */
  monitoring?: PlcKind | undefined;
  offset?: number | undefined;
  /** Stations to list (1-200, default 50). */
  limit?: number | undefined;
  maxPages?: number | undefined;
}

/** A measurement station: one name, with every compartment, type and project station its rows give, and those project stations' regions and institutes. */
export interface MeasurementStation {
  name: string;
  /** The project stations its rows name (NAME_PS): one, or several when its rows hang under several. */
  projectStations: string[];
  compartments: string[];
  stationTypes: string[];
  regions: string[];
  institutes: string[];
}

/** A project station: one name, with every region and institute its rows give (several are a conflict in the data). */
export interface ProjectStationEntry {
  name: string;
  regions: string[];
  institutes: string[];
  ids: number[];
}

/** A HELCOM PLC station, by its code. */
export interface PlcStationEntry {
  code: string;
  name: string;
  /** The river or sub-catchment (SUBCM_NAME). */
  river?: string;
  monitoring: string;
  monType: string;
  lands: string[];
  lat?: number | null;
  lon?: number | null;
}

export interface StationsSearched {
  kind: StationKind;
  name?: string;
  region?: string;
  institute?: string;
  compartment?: string;
  stationType?: string;
  land?: string;
  monitoring?: string;
}

export type StationSearch =
  | { status: "ok"; searched: StationsSearched; total: number; rows: number; stations: (MeasurementStation | ProjectStationEntry | PlcStationEntry)[]; nextOffset?: number; notes: string[] }
  | { status: "empty"; searched: StationsSearched; reason: string; notes: string[] };

/**
 * Stations of one kind, filtered here (the server filters nothing): measurement stations (by name,
 * compartment, type, and the region and institute of their project station), project stations
 * (by name, region, institute) or HELCOM PLC stations (by name, river or code, Land, monitoring
 * type). Each station is listed once, with every value its rows give: `total` counts stations,
 * `rows` the table rows they came from.
 */
export async function findStations(client: MudabClient, input: FindStationsInput = {}): Promise<StationSearch> {
  const kind = input.kind ?? "measurement";
  if (!(STATION_KINDS as readonly string[]).includes(kind)) {
    throw new MudabValidationError(`Invalid kind: expected one of ${STATION_KINDS.join(", ")}, got ${JSON.stringify(cutForMessage(String(kind)))}.`);
  }
  const name = matchInput("name", input.name);
  const region = choose("region", textInput("region", input.region), REGIONS, REGION_CHOICES);
  const institute = textInput("institute", input.institute)?.toUpperCase();
  const compartment = input.compartment === undefined ? undefined : resolveCompartment(input.compartment);
  const stationType = matchInput("stationType", input.stationType);
  const land = choose("land", textInput("land", input.land), LANDS, LAND_CHOICES);
  const monitoring = plcKind(input.monitoring);
  const offset = intInput("offset", input.offset, 0, 1_000_000, 0);
  const limit = intInput("limit", input.limit, 1, 200, 50);
  const maxPages = intInput("maxPages", input.maxPages, 1, 100, DEFAULT_MAX_PAGES);
  const wrong = (fields: [string, unknown][], applies: string): void => {
    const given = fields.filter(([, v]) => v !== undefined).map(([k]) => k);
    if (given.length > 0) throw new MudabValidationError(`Invalid ${given.join(" and ")}: ${applies}; this search is kind ${kind}.`);
  };
  if (kind === "plc") wrong([["region", region], ["institute", institute], ["compartment", compartment], ["stationType", stationType]], "region, institute, compartment and stationType apply to measurement or project stations");
  else wrong([["land", land], ["monitoring", monitoring]], "land and monitoring apply to HELCOM PLC stations (kind plc)");
  if (kind === "project") wrong([["compartment", compartment], ["stationType", stationType]], "compartment and stationType apply to measurement stations");
  const searched: StationsSearched = {
    kind,
    ...(name === undefined ? {} : { name }),
    ...(region === undefined ? {} : { region }),
    ...(institute === undefined ? {} : { institute }),
    ...(compartment === undefined ? {} : { compartment }),
    ...(stationType === undefined ? {} : { stationType }),
    ...(land === undefined ? {} : { land }),
    ...(monitoring === undefined ? {} : { monitoring }),
  };
  const q = name === undefined ? undefined : fold(name);
  const notes: string[] = [];
  const done = (stations: { name: string }[], rows: number, what: string): StationSearch => {
    if (stations.length === 0) return { status: "empty", searched, reason: `No ${what} matches ${describe(searched)}. Drop a filter, or try a shorter part of the name.`, notes };
    // The exact name first, then by name.
    const sorted = [...stations].sort((a, b) => Number(q !== undefined && fold(b.name) === q) - Number(q !== undefined && fold(a.name) === q) || a.name.localeCompare(b.name, "de"));
    const { items, nextOffset } = page(sorted, offset, limit);
    return { status: "ok", searched, total: stations.length, rows, stations: items as (MeasurementStation | ProjectStationEntry | PlcStationEntry)[], ...(nextOffset === undefined ? {} : { nextOffset }), notes };
  };

  if (kind === "plc") {
    const read = await readTable<HelcomPLCStation>(client, "plcStations", maxPages);
    if (!read.complete) notes.push(partNote("plcStations", maxPages));
    const types = monitoring === undefined ? undefined : typesOf(monitoring);
    const byCode = new Map<string, PlcStationEntry>();
    // The rows per station, so `rows` counts those of the stations answered (after the Land filter).
    const rowsOf = new Map<string, number>();
    let unknownLand = 0;
    for (const r of read.rows) {
      if (types !== undefined && !types.includes(r.MON_TYPE ?? "")) continue;
      if (q !== undefined && !has(r.STATION_NAME, q) && !has(r.SUBCM_NAME, q) && fold(r.STATION_CODE ?? "") !== q) continue;
      const code = r.STATION_CODE ?? r.STATION_NAME ?? "";
      const seen = byCode.get(code);
      // A station can be listed under its Land and again under XX (not given): it is in the Land asked for if any row says so.
      if (seen !== undefined) {
        if (r.LAND_CD !== undefined && !seen.lands.includes(r.LAND_CD)) seen.lands = uniq([...seen.lands, r.LAND_CD]);
      } else {
        byCode.set(code, {
          code,
          name: r.STATION_NAME ?? "",
          ...(r.SUBCM_NAME === undefined ? {} : { river: r.SUBCM_NAME }),
          monitoring: MON_LABELS[r.MON_TYPE ?? ""] ?? r.MON_TYPE ?? "",
          monType: r.MON_TYPE ?? "",
          lands: uniq([r.LAND_CD]),
          lat: r.ST_LAT ?? null,
          lon: r.ST_LON ?? null,
        });
      }
      rowsOf.set(code, (rowsOf.get(code) ?? 0) + 1);
    }
    let stations = [...byCode.values()];
    if (land !== undefined) {
      unknownLand = stations.filter((s) => !s.lands.includes(land) && s.lands.every((l) => l === "XX")).length;
      stations = stations.filter((s) => s.lands.includes(land));
      if (unknownLand > 0) notes.push(`${unknownLand} matching stations have no Land (XX) and are left out; ask without land to see them.`);
    }
    const noCoordinates = stations.filter((s) => s.lat == null).length;
    if (noCoordinates > 0) notes.push(`${noCoordinates} stations have no coordinates (lat/lon null): leave them off a map and say so.`);
    if (stations.some((s) => s.monType === "UNMONITORED")) notes.push("WEBDELAND and BAPDELAND are pseudo-stations for the unmonitored German land areas draining to the Western Baltic and the Baltic Proper (coordinates 0/0), not places.");
    notes.push("PLC stations are not all rivers: monitoring says what each is (river load, flow gauge, municipal treatment plant, unmonitored area). The table repeats stations: each code is listed once.");
    return done(stations, stations.reduce((sum, s) => sum + (rowsOf.get(s.code) ?? 0), 0), "HELCOM PLC station");
  }

  const projects = await readTable<ProjectStation>(client, "projectStations", maxPages);
  if (!projects.complete) notes.push(partNote("projectStations", maxPages));
  const byProject = new Map<string, ProjectStationEntry>();
  for (const r of projects.rows) {
    const key = r.NAME_PS ?? "";
    const entry = byProject.get(key) ?? { name: key, regions: [], institutes: [], ids: [] };
    entry.regions = uniq([...entry.regions, r.REGION]);
    entry.institutes = uniq([...entry.institutes, r.INSTITUT]);
    if (typeof r.PROJECTSTATIONID === "number") entry.ids.push(r.PROJECTSTATIONID);
    byProject.set(key, entry);
  }
  const projectMatches = (p: ProjectStationEntry | undefined): boolean =>
    (region === undefined || (p?.regions.includes(region) ?? false)) && (institute === undefined || (p?.institutes.some((i) => i.toUpperCase() === institute) ?? false));
  const conflictNote = (list: ProjectStationEntry[]): void => {
    // Each project-station name once: several stations under one name are one conflict.
    const conflicting = new Set(list.filter((p) => p.regions.length > 1 || p.institutes.length > 1).map((p) => p.name)).size;
    if (conflicting > 0) notes.push(`${conflicting} project-station ${conflicting === 1 ? "name carries" : "names carry"} several regions or institutes in the data (for example L1: BSH/Nordsee and IOW/Ostsee): every one is listed; report each, never pick one.`);
  };

  if (kind === "project") {
    let rows = 0;
    const matched: ProjectStationEntry[] = [];
    for (const p of byProject.values()) {
      if (q !== undefined && !fold(p.name).includes(q)) continue;
      if (!projectMatches(p)) continue;
      matched.push(p);
      rows += p.ids.length;
    }
    conflictNote(matched);
    if (institute !== undefined && matched.length === 0) {
      notes.push(`Institutes in the table: ${uniq(projects.rows.map((r) => r.INSTITUT)).join(", ")}.`);
    }
    notes.push("Region (Nordsee/Ostsee) and institute live on project stations; many project stations have no measurement station.");
    return done(matched, rows, "project station");
  }

  const stations = await readTable<Messstation>(client, "stations", maxPages);
  if (!stations.complete) notes.push(partNote("stations", maxPages));
  const byName = new Map<string, MeasurementStation>();
  // The stations with a row whose project station is in PROJECTSTATION_SMALL.
  const joined = new Set<string>();
  let rows = 0;
  for (const r of stations.rows) {
    if (compartment !== undefined && r.COMPT_DS !== compartment) continue;
    if (stationType !== undefined && fold(r.STATIONTYPE_ST ?? "") !== fold(stationType)) continue;
    if (q !== undefined && !has(r.STATNAME_ST, q)) continue;
    const project = byProject.get(r.NAME_PS ?? "");
    if ((region !== undefined || institute !== undefined) && !projectMatches(project)) continue;
    const key = r.STATNAME_ST ?? "";
    let entry = byName.get(key);
    if (entry === undefined) {
      entry = { name: key, projectStations: [], compartments: [], stationTypes: [], regions: [], institutes: [] };
      byName.set(key, entry);
    }
    // A station's rows can hang under several project stations (BMP K4: OMBMPK4 of the IOW, BMP K4
    // of the BSH): each is listed, with its regions and institutes.
    if (r.NAME_PS != null && !entry.projectStations.includes(r.NAME_PS)) entry.projectStations = uniq([...entry.projectStations, r.NAME_PS]);
    if (project !== undefined) {
      joined.add(key);
      entry.regions = uniq([...entry.regions, ...project.regions]);
      entry.institutes = uniq([...entry.institutes, ...project.institutes]);
    }
    entry.compartments = uniq([...entry.compartments, r.COMPT_DS]);
    entry.stationTypes = uniq([...entry.stationTypes, r.STATIONTYPE_ST]);
    rows += 1;
  }
  const list = [...byName.values()];
  conflictNote(list.flatMap((s) => s.projectStations.map((p) => byProject.get(p))).filter((p): p is ProjectStationEntry => p !== undefined));
  const unjoined = list.filter((s) => !joined.has(s.name)).length;
  if (unjoined > 0 && region === undefined && institute === undefined) notes.push(`${unjoined} of these stations have no project station in PROJECTSTATION_SMALL, so no region or institute.`);
  const several = list.filter((s) => s.projectStations.length > 1).length;
  if (several > 0) notes.push(`${several} ${several === 1 ? "station is" : "stations are"} listed under several project stations (projectStations): its regions and institutes are those of all of them; report each.`);
  notes.push("The table repeats rows and lists a station once per compartment: total counts station names, rows the table rows. Region and institute come from the station's project stations (projectStations).");
  if (stationType !== undefined && list.length === 0) notes.push(`Station types in the table: ${uniq(stations.rows.map((r) => r.STATIONTYPE_ST)).join(", ")}.`);
  return done(list, rows, "measurement station");
}

/** The filters as words, for an empty answer's reason. */
function describe(searched: object): string {
  const parts = Object.entries(searched)
    .filter(([key, value]) => key !== "kind" && value !== undefined)
    .map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  return parts.length === 0 ? "the search" : parts.join(", ");
}

// --- findParameters -----------------------------------------------------------------------

export interface FindParametersInput {
  /** Part of a parameter's code or (English) name: "mercury", "HG", "nitrogen". */
  name?: string | undefined;
  /** Part of the parameter group's name or code: "nutrient", "Metals". */
  group?: string | undefined;
  /** Only parameters listed for this compartment: CW/wasser, CS/sediment, CF/biota, BL/biologie, MM. */
  compartment?: string | undefined;
  /** The parameters of the HELCOM PLC river-load stations instead (V_GEMESSENE_PARA_PLC). */
  plc?: boolean | undefined;
  offset?: number | undefined;
  /** Parameters to list (1-200, default 50). */
  limit?: number | undefined;
  maxPages?: number | undefined;
}

/** A parameter, with every compartment whose list names it. */
export interface ParameterEntry {
  code: string;
  name?: string;
  group?: string;
  groupCode?: string;
  /** The compartments whose own list names it (CW, CS, CF, BL), and the combined table's (e.g. MM). */
  compartments: string[];
  deprecated?: true;
}

/** A parameter of the PLC stations, over every station that measures it. */
export interface PlcParameterEntry {
  code: string;
  label?: string;
  group?: string;
  stations: number;
  values: number;
  lastYear?: string;
}

export interface ParametersSearched {
  name?: string;
  group?: string;
  compartment?: string;
  plc?: boolean;
}

export type ParameterSearch =
  | { status: "ok"; searched: ParametersSearched; total: number; parameters: (ParameterEntry | PlcParameterEntry)[]; nextOffset?: number; notes: string[] }
  | { status: "empty"; searched: ParametersSearched; reason: string; notes: string[] };

/** The note on what the measurement table holds. */
const NO_SUBSTANCE_VALUES =
  "This API's measurement table (getMeasurements) holds only weather and sea-state observations (air and sea temperature, wind, waves, cloud, Secchi depth …); values of the substances listed here are not served by it (the UBA's MUDAB portal: https://www.umweltbundesamt.de/portale/meeresumweltdatenbank-mudab).";

/**
 * The parameters MUDAB records, by code or English name, group and compartment. Without a
 * compartment every compartment's own list is read (and the combined table, for codes only it
 * has), so each parameter names every compartment it is measured in: the combined table alone
 * lists mercury under biota only, though water and sediment measure it too. With `plc`, the
 * parameters of the HELCOM PLC stations, with how many stations and values each has.
 */
export async function findParameters(client: MudabClient, input: FindParametersInput = {}): Promise<ParameterSearch> {
  const name = matchInput("name", input.name);
  const group = matchInput("group", input.group);
  const compartment = input.compartment === undefined ? undefined : resolveCompartment(input.compartment);
  const plc = input.plc === true;
  if (input.plc !== undefined && typeof input.plc !== "boolean") throw new MudabValidationError("Invalid plc: expected true or false.");
  const offset = intInput("offset", input.offset, 0, 1_000_000, 0);
  const limit = intInput("limit", input.limit, 1, 200, 50);
  const maxPages = intInput("maxPages", input.maxPages, 1, 100, DEFAULT_MAX_PAGES);
  if (plc && (group !== undefined || compartment !== undefined)) {
    throw new MudabValidationError("Invalid group and compartment: they apply to the monitoring parameters, not to the PLC list (plc true).");
  }
  const searched: ParametersSearched = { ...(name === undefined ? {} : { name }), ...(group === undefined ? {} : { group }), ...(compartment === undefined ? {} : { compartment }), ...(plc ? { plc } : {}) };
  const q = name === undefined ? undefined : fold(name);
  const g = group === undefined ? undefined : fold(group);
  const notes: string[] = [];
  const answer = <T extends ParameterEntry | PlcParameterEntry>(list: T[], reason: string): ParameterSearch => {
    if (list.length === 0) return { status: "empty", searched, reason, notes };
    const sorted = [...list].sort(
      (a, b) =>
        Number(q !== undefined && fold(b.code) === q) - Number(q !== undefined && fold(a.code) === q) ||
        Number("deprecated" in a) - Number("deprecated" in b) ||
        a.code.localeCompare(b.code),
    );
    const { items, nextOffset } = page(sorted, offset, limit);
    return { status: "ok", searched, total: list.length, parameters: items, ...(nextOffset === undefined ? {} : { nextOffset }), notes };
  };

  if (plc) {
    const read = await readTable<ParameterPLC>(client, "plcParameters", maxPages);
    if (!read.complete) notes.push(partNote("plcParameters", maxPages));
    const byCode = new Map<string, PlcParameterEntry & { codes: Set<string> }>();
    for (const r of read.rows) {
      const code = r.PARAMETER ?? "";
      const entry = byCode.get(code) ?? { code, ...labelOf(code), ...(r.PARAMETERGRUPPE === undefined ? {} : { group: r.PARAMETERGRUPPE }), stations: 0, values: 0, codes: new Set<string>() };
      entry.codes.add(r.STATION_CODE ?? "");
      entry.stations = entry.codes.size;
      entry.values += typeof r.ANZ_MESSWERTE === "number" ? r.ANZ_MESSWERTE : 0;
      if (r.LETZTE_MESSUNG !== undefined && (entry.lastYear === undefined || r.LETZTE_MESSUNG > entry.lastYear)) entry.lastYear = r.LETZTE_MESSUNG;
      byCode.set(code, entry);
    }
    const list = [...byCode.values()]
      .map(({ codes: _codes, ...entry }) => entry)
      .filter((p) => q === undefined || fold(p.code).includes(q) || has(p.label, q) || PLC_PARAMETERS[p.code]?.words.some((w) => fold(w).includes(q)) === true);
    notes.push("The values themselves: getRiverLoads (by parameter, river, Land, year).");
    return answer(list, `No PLC parameter matches ${JSON.stringify(name)}. The PLC parameters are ${Object.keys(PLC_PARAMETERS).join(", ")}.`);
  }

  // Which lists to read: one compartment's own, the combined table for MM, or all of them.
  const lists: { compartment?: string; endpoint?: (typeof COMPARTMENT_LISTS)[keyof typeof COMPARTMENT_LISTS] }[] =
    compartment === undefined ? [{}, ...Object.entries(COMPARTMENT_LISTS).map(([code, endpoint]) => ({ compartment: code, endpoint }))]
    : compartment in COMPARTMENT_LISTS ? [{ compartment, endpoint: COMPARTMENT_LISTS[compartment as keyof typeof COMPARTMENT_LISTS] }]
    : [{}];
  const byCode = new Map<string, ParameterEntry>();
  for (const list of lists) {
    const read = await readTable<Parameter>(client, "parameters", maxPages, list.endpoint);
    if (!read.complete) notes.push(partNote("parameters", maxPages));
    for (const r of read.rows) {
      const code = r.PARAMETER ?? "";
      const listed = list.compartment ?? r.COMPT_DS;
      if (compartment !== undefined && listed !== compartment) continue;
      const entry = byCode.get(code) ?? {
        code,
        ...(r.PARAM_NAME === undefined ? {} : { name: r.PARAM_NAME }),
        ...(r.PARAMGROUP_NAME == null ? {} : { group: r.PARAMGROUP_NAME }),
        ...(r.PARAMETERGRUPPE == null ? {} : { groupCode: r.PARAMETERGRUPPE }),
        compartments: [],
        ...(/deprecated/i.test(r.PARAM_NAME ?? "") ? { deprecated: true as const } : {}),
      };
      entry.compartments = uniq([...entry.compartments, listed]);
      if (entry.group === undefined && r.PARAMGROUP_NAME != null) entry.group = r.PARAMGROUP_NAME;
      byCode.set(code, entry);
    }
  }
  const list = [...byCode.values()].filter(
    (p) => (q === undefined || fold(p.code).includes(q) || has(p.name, q)) && (g === undefined || has(p.group, g) || has(p.groupCode, g)),
  );
  notes.push(
    compartment === undefined
      ? "compartments lists every compartment whose own list names the parameter (CW water, CS sediment, CF biota, BL biology; MM only in the combined table)."
      : `Only the list of compartment ${compartment} was read.`,
    "Names and groups are English scientific labels (mercury, not Quecksilber); keep code and name verbatim. A parameter without a group (often a *deprecated* one) has no group field.",
    NO_SUBSTANCE_VALUES,
  );
  const where = compartment === undefined ? "" : ` in compartment ${compartment}`;
  return answer(list, `No parameter${where} matches ${describe(searched)}. Names are English: try the English name ("mercury", "nitrogen"), a code ("HG"), or a shorter part; drop the compartment to search every list.`);
}

// --- getMeasurements (station measurements) -----------------------------------------------

/** The parameters of the station measurement table (MV_STATION_MSMNT, all 14 codes of 2026-11-19), with words a caller uses. */
export const MEASUREMENT_PARAMETERS: Readonly<Record<string, { label: string; words: readonly string[] }>> = {
  AIRTEMP: { label: "air temperature", words: ["Lufttemperatur", "air temp"] },
  SurTemp: { label: "sea surface temperature", words: ["Wassertemperatur", "Oberflächentemperatur", "water temperature", "sea temperature", "SST"] },
  AIRPRES: { label: "air pressure", words: ["Luftdruck", "pressure"] },
  WINSP: { label: "wind speed", words: ["Windgeschwindigkeit", "wind"] },
  WindDir: { label: "wind direction", words: ["Windrichtung"] },
  _CLOUD: { label: "cloud cover", words: ["Bewölkung", "Wolken", "clouds"] },
  _RELH: { label: "relative humidity", words: ["Luftfeuchte", "Luftfeuchtigkeit", "humidity"] },
  _STATE: { label: "sea state (scale)", words: ["Seegang", "sea state"] },
  WAVHT: { label: "wave height", words: ["Wellenhöhe", "waves"] },
  _WAVEH: { label: "wave height (scale)", words: ["Wellenhöhe Skala"] },
  SECCI: { label: "Secchi depth (water transparency)", words: ["Sichttiefe", "Secchi", "transparency"] },
  _ICE: { label: "ice conditions (scale)", words: ["Eis", "Eisverhältnisse", "ice"] },
  _GLORA: { label: "global radiation", words: ["Globalstrahlung", "radiation"] },
  _WHTR: { label: "weather (code)", words: ["Wetter", "weather"] },
};

/** How long a read measurement table is kept per client: it is ~42 MB upstream, and one question often asks it twice. */
export const MEASUREMENTS_CACHE_MS = 15 * 60_000;

/** The measurement table in columns: strings once, rows as indexes and numbers. */
interface MeasurementTable {
  stations: string[];
  codes: string[];
  units: string[];
  s: number[];
  c: number[];
  u: number[];
  d: number[];
  t: number[];
  v: number[];
  complete: boolean;
  skipped: number;
  /** Rows the table repeats exactly (every field the same), counted once. */
  repeated: number;
  rows: number;
}

const tables = new WeakMap<MudabClient, { at: number; table: MeasurementTable }>();

/** The read of the measurement table under way per client, which a second call joins. */
const reading = new WeakMap<MudabClient, Promise<MeasurementTable>>();

/**
 * The unit in a row's method id (PARAMETERID_PM, "APSurTemp THRNFNON degC IFAG": the token before
 * the institute), or "" when it names none ("APAIRTEMP THRNFNON LUNG").
 */
export function unitOf(parameterId: string | undefined): string {
  const tokens = (parameterId ?? "").trim().split(/\s+/);
  const unit = tokens.length >= 3 ? (tokens[tokens.length - 2] as string) : "";
  return /NON$/.test(unit) || /^AP/.test(unit) ? "" : unit;
}

/**
 * The measurement table: from the client's cache when younger than MEASUREMENTS_CACHE_MS, else
 * read in pages. Calls at once share one read (a model's parallel calls would each download the
 * ~42 MB); when that read fails for the call that started it (cancelled, at its deadline), a call
 * that joined it reads on its own.
 */
async function measurementTable(client: MudabClient, maxPages: number, now: () => number): Promise<MeasurementTable> {
  for (;;) {
    const cached = tables.get(client);
    if (cached !== undefined && now() - cached.at < MEASUREMENTS_CACHE_MS) return cached.table;
    const pending = reading.get(client);
    if (pending !== undefined) {
      try {
        return await pending;
      } catch {
        continue;
      }
    }
    const read = readMeasurementTable(client, maxPages, now).finally(() => {
      if (reading.get(client) === read) reading.delete(client);
    });
    reading.set(client, read);
    return await read;
  }
}

/** One read of the measurement table, in pages, into the client's cache. */
async function readMeasurementTable(client: MudabClient, maxPages: number, now: () => number): Promise<MeasurementTable> {
  const table: MeasurementTable = { stations: [], codes: [], units: [], s: [], c: [], u: [], d: [], t: [], v: [], complete: false, skipped: 0, repeated: 0, rows: 0 };
  const index = { s: new Map<string, number>(), c: new Map<string, number>(), u: new Map<string, number>() };
  const idx = (map: Map<string, number>, list: string[], key: string): number => {
    let i = map.get(key);
    if (i === undefined) {
      i = list.push(key) - 1;
      map.set(key, i);
    }
    return i;
  };
  // The table repeats most rows several times (187,707 rows, about 37,000-40,000 distinct on
  // 2026-11-19): a row seen before, field for field, is counted once.
  const seen = new Set<string>();
  const read = await readPages<ParameterValue>((req) => client.measurements(req), PAGE_ROWS.measurements, maxPages, (rows) => {
    checkRows("measurements", TABLE_PATHS.measurements, rows as Record<string, unknown>[]);
    for (const r of rows) {
      table.rows += 1;
      const key = `${r.STATNAME_ST}\u0000${r.PARAMETERID_PM}\u0000${r.PARAMCODE_PM}\u0000${r.DATE_STM}\u0000${r.TIME_STM}\u0000${r.VALUE_MS}`;
      if (seen.has(key)) {
        table.repeated += 1;
        continue;
      }
      seen.add(key);
      if (typeof r.VALUE_MS !== "number" || typeof r.STATNAME_ST !== "string" || !/^\d{8}$/.test(r.DATE_STM ?? "")) {
        table.skipped += 1;
        continue;
      }
      table.s.push(idx(index.s, table.stations, r.STATNAME_ST));
      table.c.push(idx(index.c, table.codes, r.PARAMCODE_PM ?? ""));
      table.u.push(idx(index.u, table.units, unitOf(r.PARAMETERID_PM)));
      table.d.push(Number(r.DATE_STM));
      table.t.push(/^\d{4}$/.test(r.TIME_STM ?? "") ? Number(r.TIME_STM) : -1);
      table.v.push(r.VALUE_MS);
    }
  });
  if (read.rows === 0) throw noRows(TABLE_PATHS.measurements);
  table.complete = read.complete;
  tables.set(client, { at: now(), table });
  return table;
}

export interface GetMeasurementsInput {
  /** A measurement station's name ("OMMVZBA15", "DB16"); several names containing it are ambiguous. */
  station?: string | undefined;
  /** A parameter code or name ("SurTemp", "sea surface temperature", "Wassertemperatur", "AIRTEMP"). */
  parameter?: string | undefined;
  /** From this day (YYYY-MM-DD), inclusive. */
  from?: string | undefined;
  /** To this day (YYYY-MM-DD), inclusive. */
  to?: string | undefined;
  offset?: number | undefined;
  /** Values (with a station) or stations (without) to list (1-500, default 100). */
  limit?: number | undefined;
  maxPages?: number | undefined;
  /** The clock of the cache (ms); tests inject one. */
  now?: (() => number) | undefined;
}

/** One series: a station, a parameter and a unit, with its numbers. */
export interface MeasurementSeries {
  station: string;
  parameter: string;
  label?: string;
  /** The unit the method id names; absent when it names none. */
  unit?: string;
  count: number;
  firstDate: string;
  lastDate: string;
  min: number;
  max: number;
  mean: number;
}

export interface MeasurementValue {
  station: string;
  parameter: string;
  unit?: string;
  date: string;
  time?: string;
  value: number;
}

export interface MeasurementParameterSummary {
  parameter: string;
  label?: string;
  units: string[];
  count: number;
  stations: number;
  firstDate: string;
  lastDate: string;
}

export interface MeasurementsSearched {
  station?: string;
  parameter?: string;
  from?: string;
  to?: string;
}

export type MeasurementsAnswer =
  | { status: "ok"; searched: MeasurementsSearched; station: string; series: MeasurementSeries[]; total: number; values: MeasurementValue[]; nextOffset?: number; notes: string[] }
  | { status: "ok"; searched: MeasurementsSearched; parameter: string; total: number; stations: MeasurementSeries[]; nextOffset?: number; notes: string[] }
  | { status: "ok"; searched: MeasurementsSearched; total: number; parameters: MeasurementParameterSummary[]; notes: string[] }
  | Ambiguous<MeasurementsSearched>
  | { status: "empty"; searched: MeasurementsSearched; reason: string; notes: string[] };

/** The parameter code `value` means among `codes`, or the candidates. */
function resolveMeasurementParameter(value: string, codes: string[]): { code: string } | { candidates: string[] } | undefined {
  const q = fold(value);
  const exact = codes.filter((code) => fold(code) === q || fold(MEASUREMENT_PARAMETERS[code]?.label ?? "\u0000") === q || MEASUREMENT_PARAMETERS[code]?.words.some((w) => fold(w) === q) === true);
  if (exact.length === 1) return { code: exact[0] as string };
  const partial = exact.length > 1 ? exact : codes.filter((code) => fold(code).includes(q) || has(MEASUREMENT_PARAMETERS[code]?.label, q) || MEASUREMENT_PARAMETERS[code]?.words.some((w) => fold(w).includes(q)) === true);
  if (partial.length === 1) return { code: partial[0] as string };
  if (partial.length > 1) return { candidates: partial.map((code) => `${code} (${MEASUREMENT_PARAMETERS[code]?.label ?? "no label"})`) };
  return undefined;
}

/**
 * The station measurement values (MV_STATION_MSMNT: weather and sea observations). With a station:
 * its series (one per parameter and unit, with count, dates, min, max, mean) and the values, newest
 * first, paged. With a parameter only: the stations that measured it, each a series, most values
 * first. With neither: what the table holds per parameter. The table is read in pages once and
 * kept for {@link MEASUREMENTS_CACHE_MS} per client.
 */
export async function getMeasurements(client: MudabClient, input: GetMeasurementsInput = {}): Promise<MeasurementsAnswer> {
  const station = matchInput("station", input.station);
  const parameter = matchInput("parameter", input.parameter);
  const from = dayInput("from", input.from);
  const to = dayInput("to", input.to);
  if (from !== undefined && to !== undefined && from > to) throw new MudabValidationError("Invalid from and to: from is after to.");
  const offset = intInput("offset", input.offset, 0, 1_000_000, 0);
  const limit = intInput("limit", input.limit, 1, 500, 100);
  const maxPages = intInput("maxPages", input.maxPages, 1, 100, DEFAULT_MAX_PAGES);
  const searched: MeasurementsSearched = {
    ...(station === undefined ? {} : { station }),
    ...(parameter === undefined ? {} : { parameter }),
    ...(from === undefined ? {} : { from: isoDay(from) }),
    ...(to === undefined ? {} : { to: isoDay(to) }),
  };
  const table = await measurementTable(client, maxPages, input.now ?? Date.now);
  const notes: string[] = [];
  if (!table.complete) notes.push(partNote("measurements", maxPages));
  if (table.skipped > 0) notes.push(`${table.skipped} rows without a numeric value or a date were left out.`);
  if (table.repeated > 0) notes.push(`The table repeats rows: ${table.repeated} of its ${table.rows} rows are exact copies of another and are counted once; counts are of distinct values.`);

  let code: number | undefined;
  if (parameter !== undefined) {
    const found = resolveMeasurementParameter(parameter, table.codes);
    if (found === undefined) {
      const known = table.codes.map((c) => `${c} (${MEASUREMENT_PARAMETERS[c]?.label ?? "no label"})`).join(", ");
      return { status: "empty", searched, reason: `The measurement table has no parameter ${JSON.stringify(parameter)}. It holds weather and sea observations only: ${known}. Substances (nutrients, metals, pollutants) are not in it.`, notes };
    }
    if ("candidates" in found) return { status: "ambiguous", searched, total: found.candidates.length, candidates: found.candidates, reason: `Several parameters fit ${JSON.stringify(parameter)}: ask which one is meant and call again with its code.` };
    code = table.codes.indexOf(found.code);
  }
  let stationIndex: number | undefined;
  if (station !== undefined) {
    const found = pickName(table.stations, station);
    if (found === undefined) {
      return { status: "empty", searched, reason: `No measurements for a station named ${JSON.stringify(station)}: the table has values for ${table.stations.length} stations, most stations have none. Find names with findStations, or call without station and with a parameter to list the stations that measured it.`, notes };
    }
    if ("candidates" in found) {
      return { status: "ambiguous", searched, total: found.candidates.length, candidates: found.candidates.slice(0, 25), reason: `${found.candidates.length} station names contain ${JSON.stringify(station)}: ask which one is meant and call again with its full name, exactly as listed (names that differ only in case or punctuation are different stations).` };
    }
    stationIndex = table.stations.indexOf(found.name);
    if (found.variants.length > 0) notes.push(`Other stations whose names contain it are separate stations: ${found.variants.slice(0, 10).join(", ")}${found.variants.length > 10 ? ", …" : ""}.`);
  }

  // One pass: the rows that match, into series keyed by station, code and unit.
  const series = new Map<string, MeasurementSeries & { sum: number }>();
  const matched: number[] = [];
  for (let i = 0; i < table.v.length; i++) {
    if (stationIndex !== undefined && table.s[i] !== stationIndex) continue;
    if (code !== undefined && table.c[i] !== code) continue;
    const day = table.d[i] as number;
    if ((from !== undefined && day < from) || (to !== undefined && day > to)) continue;
    const key = `${table.s[i]}|${table.c[i]}|${table.u[i]}`;
    const value = table.v[i] as number;
    const entry = series.get(key);
    if (entry === undefined) {
      const parameterCode = table.codes[table.c[i] as number] as string;
      const unit = table.units[table.u[i] as number] as string;
      const label = MEASUREMENT_PARAMETERS[parameterCode]?.label;
      series.set(key, { station: table.stations[table.s[i] as number] as string, parameter: parameterCode, ...(label === undefined ? {} : { label }), ...(unit === "" ? {} : { unit }), count: 1, firstDate: String(day), lastDate: String(day), min: value, max: value, mean: 0, sum: value });
    } else {
      entry.count += 1;
      entry.sum += value;
      if (String(day) < entry.firstDate) entry.firstDate = String(day);
      if (String(day) > entry.lastDate) entry.lastDate = String(day);
      if (value < entry.min) entry.min = value;
      if (value > entry.max) entry.max = value;
    }
    if (stationIndex !== undefined) matched.push(i);
  }
  const finished = [...series.values()].map(({ sum, ...s }) => ({ ...s, firstDate: isoDay(s.firstDate), lastDate: isoDay(s.lastDate), mean: round(sum / s.count) }));
  const range = from !== undefined || to !== undefined ? ` between ${searched.from ?? "the start"} and ${searched.to ?? "today"}` : "";
  const unitNote = (list: MeasurementSeries[]): void => {
    const byParameter = new Map<string, Set<string>>();
    for (const s of list) byParameter.set(s.parameter, (byParameter.get(s.parameter) ?? new Set()).add(s.unit ?? "not stated"));
    const mixed = [...byParameter].filter(([, units]) => units.size > 1);
    if (mixed.length > 0) notes.push(`Units differ within a parameter (${mixed.map(([p, u]) => `${p}: ${uniq(u).join(", ")}`).join("; ")}): each unit is a series of its own; never compare or average across them ("sc" is a scale, not metres).`);
    if (list.some((s) => s.unit === undefined)) notes.push("A series without unit: the row's method id names none; say the unit is not stated.");
  };

  if (stationIndex !== undefined) {
    const name = table.stations[stationIndex] as string;
    if (matched.length === 0) return { status: "empty", searched, reason: `Station ${name} has no values${parameter === undefined ? "" : ` of ${table.codes[code as number]}`}${range}. Drop the parameter or the dates to see what it has.`, notes };
    // Newest first.
    matched.sort((a, b) => (table.d[b] as number) - (table.d[a] as number) || (table.t[b] as number) - (table.t[a] as number));
    const values = matched.map((i): MeasurementValue => {
      const unit = table.units[table.u[i] as number] as string;
      const time = table.t[i] as number;
      return {
        station: name,
        parameter: table.codes[table.c[i] as number] as string,
        ...(unit === "" ? {} : { unit }),
        date: isoDay(table.d[i] as number),
        ...(time < 0 ? {} : { time: `${String(time).padStart(4, "0").slice(0, 2)}:${String(time).padStart(4, "0").slice(2)}` }),
        value: table.v[i] as number,
      };
    });
    unitNote(finished);
    const { items, nextOffset } = page(values, offset, limit);
    return { status: "ok", searched, station: name, series: finished.sort((a, b) => a.parameter.localeCompare(b.parameter)), total: values.length, values: items, ...(nextOffset === undefined ? {} : { nextOffset }), notes };
  }
  if (code !== undefined) {
    const codeName = table.codes[code] as string;
    if (finished.length === 0) return { status: "empty", searched, reason: `No station has values of ${codeName}${range}. Widen the dates.`, notes };
    unitNote(finished);
    const sorted = finished.sort((a, b) => b.count - a.count || a.station.localeCompare(b.station));
    const { items, nextOffset } = page(sorted, offset, limit);
    return { status: "ok", searched, parameter: codeName, total: sorted.length, stations: items, ...(nextOffset === undefined ? {} : { nextOffset }), notes };
  }
  // Neither: per parameter, what the table holds.
  const byCode = new Map<string, MeasurementParameterSummary & { names: Set<string> }>();
  for (const s of finished) {
    const label = MEASUREMENT_PARAMETERS[s.parameter]?.label;
    const entry = byCode.get(s.parameter) ?? { parameter: s.parameter, ...(label === undefined ? {} : { label }), units: [], count: 0, stations: 0, firstDate: s.firstDate, lastDate: s.lastDate, names: new Set<string>() };
    entry.units = uniq([...entry.units, s.unit ?? "not stated"]);
    entry.count += s.count;
    entry.names.add(s.station);
    entry.stations = entry.names.size;
    if (s.firstDate < entry.firstDate) entry.firstDate = s.firstDate;
    if (s.lastDate > entry.lastDate) entry.lastDate = s.lastDate;
    byCode.set(s.parameter, entry);
  }
  if (byCode.size === 0) return { status: "empty", searched, reason: `The measurement table has no values${range}. Widen the dates.`, notes };
  notes.push("Weather and sea observations only; substances are not in this table. Ask with a parameter for the stations that measured it, or with a station for its values.");
  const parameters = [...byCode.values()].map(({ names: _names, ...p }) => p).sort((a, b) => b.count - a.count || a.parameter.localeCompare(b.parameter));
  return { status: "ok", searched, total: parameters.length, parameters, notes };
}

// --- getRiverLoads (HELCOM PLC values) ----------------------------------------------------

/** The PLC parameters (V_MESSWERTE_PLC NAME), with words a caller uses. */
export const PLC_PARAMETERS: Readonly<Record<string, { label: string; words: readonly string[] }>> = {
  Ntot: { label: "total nitrogen", words: ["Gesamtstickstoff", "Stickstoff", "nitrogen", "N"] },
  Ptot: { label: "total phosphorus", words: ["Gesamtphosphor", "Phosphor", "phosphorus", "P"] },
  NO3: { label: "nitrate", words: ["Nitrat"] },
  NO2: { label: "nitrite", words: ["Nitrit"] },
  NH4: { label: "ammonium", words: ["Ammonium"] },
  PPO4: { label: "phosphate phosphorus", words: ["Phosphat", "phosphate", "orthophosphate"] },
  BOD5: { label: "biochemical oxygen demand, 5 days", words: ["BSB5"] },
  BOD7: { label: "biochemical oxygen demand, 7 days", words: ["BSB7"] },
  "COD-Cr": { label: "chemical oxygen demand (dichromate)", words: ["CSB", "COD"] },
  TOC: { label: "total organic carbon", words: ["organischer Kohlenstoff"] },
  AOX: { label: "adsorbable organic halogens", words: ["adsorbierbare organische Halogene"] },
  SS: { label: "suspended solids", words: ["Schwebstoffe", "abfiltrierbare Stoffe"] },
  Cd: { label: "cadmium", words: ["Cadmium"] },
  Cr: { label: "chromium", words: ["Chrom"] },
  Cu: { label: "copper", words: ["Kupfer"] },
  Hg: { label: "mercury", words: ["Quecksilber"] },
  Ni: { label: "nickel", words: ["Nickel"] },
  Pb: { label: "lead", words: ["Blei"] },
  Zn: { label: "zinc", words: ["Zink"] },
  FLOW: { label: "flow (discharge)", words: ["Abfluss", "Durchfluss", "discharge", "Wassermenge"] },
};

/** The label of a PLC parameter code, when known. */
function labelOf(code: string): { label?: string } {
  const label = PLC_PARAMETERS[code]?.label;
  return label === undefined ? {} : { label };
}

/** The PLC parameter `value` means: a code, its label, or a word for it. */
function resolvePlcParameter(value: string): { code: string } | { candidates: string[] } | undefined {
  const q = fold(value);
  const codes = Object.keys(PLC_PARAMETERS);
  const exact = codes.filter((code) => fold(code) === q || fold(PLC_PARAMETERS[code]?.label ?? "") === q || PLC_PARAMETERS[code]?.words.some((w) => fold(w) === q) === true);
  if (exact.length === 1) return { code: exact[0] as string };
  if (q.length < 3) return undefined;
  const partial = codes.filter((code) => has(PLC_PARAMETERS[code]?.label, q) || PLC_PARAMETERS[code]?.words.some((w) => fold(w).length > 2 && fold(w).includes(q)) === true);
  if (partial.length === 1) return { code: partial[0] as string };
  if (partial.length > 1) return { candidates: partial.map((code) => `${code} (${PLC_PARAMETERS[code]?.label})`) };
  return undefined;
}

export const LOAD_GROUPS = ["station", "year", "kind", "land"] as const;

/** An answer from at most this many stations names them (`stations`); `stationCount` counts them always. */
const MAX_NAMED_STATIONS = 25;
export type LoadGroup = (typeof LOAD_GROUPS)[number];

export interface GetRiverLoadsInput {
  /** A PLC parameter: code (Ntot, Ptot, Hg, FLOW), name or German word (Stickstoff, Quecksilber). */
  parameter?: string | undefined;
  /** Part of the river (sub-catchment), the station name, or the station code: "Warnow", "Peene", "ZKW Lübeck". */
  river?: string | undefined;
  /** MV, SH or their names. */
  land?: string | undefined;
  /** river (default; FLOW: flow), flow, treatmentPlant, unmonitored or all. */
  kind?: PlcKind | undefined;
  year?: number | undefined;
  fromYear?: number | undefined;
  toYear?: number | undefined;
  /** Totals per station, year, kind or Land (needs a parameter), instead of rows. */
  by?: LoadGroup | undefined;
  /** value (largest first, the default) or year (newest first). */
  sort?: "value" | "year" | undefined;
  offset?: number | undefined;
  /** Rows or totals to list (1-500, default 50). */
  limit?: number | undefined;
  maxPages?: number | undefined;
}

export interface LoadRow {
  station: string;
  code: string;
  river?: string;
  land?: string;
  kind: string;
  parameter: string;
  year: string;
  value: number;
  unit?: string;
  /** TOT (a total over the year) or AVE (a mean). */
  type?: string;
}

/**
 * A total of one group and unit. The values are yearly (t/a, a year's mean flow in m3/s), so years
 * are never added: within a year the group's rows are summed, and over several years the answer is
 * the mean of those yearly totals.
 */
export interface LoadTotal {
  group: string;
  unit?: string;
  /** The total, when the group's rows are of one year. */
  sum?: number;
  /** When the group's rows span several years: the mean of its yearly totals, in the unit (per year). */
  meanPerYear?: number;
  /** When the answer spans several years: the years the group has values in, and their span. */
  years?: number;
  fromYear?: string;
  toYear?: string;
  count: number;
}

export interface LoadsSearched {
  parameter?: string;
  river?: string;
  land?: string;
  kind: PlcKind;
  year?: number;
  fromYear?: number;
  toYear?: number;
  by?: LoadGroup;
}

export type LoadsAnswer =
  | { status: "ok"; searched: LoadsSearched; total: number; rows: LoadRow[]; stationCount: number; stations?: string[]; nextOffset?: number; notes: string[] }
  | { status: "ok"; searched: LoadsSearched; total: number; totals: LoadTotal[]; stationCount: number; stations?: string[]; nextOffset?: number; notes: string[] }
  | Ambiguous<LoadsSearched>
  | { status: "empty"; searched: LoadsSearched; reason: string; notes: string[] };

/**
 * HELCOM PLC values (V_MESSWERTE_PLC): annual loads into the Baltic Sea from monitored rivers (the
 * default), municipal treatment plants and unmonitored areas, and river flow. Filtered by
 * parameter, river or station, Land, and years; rows ranked by value (or by year), or totals per
 * station, year, kind or Land. Null values are dropped and counted; values of different units are
 * never added together; a last year with far fewer rows than the one before is said to be incomplete.
 */
export async function getRiverLoads(client: MudabClient, input: GetRiverLoadsInput = {}): Promise<LoadsAnswer> {
  const parameterText = matchInput("parameter", input.parameter);
  const river = matchInput("river", input.river);
  const land = choose("land", textInput("land", input.land), LANDS, LAND_CHOICES);
  const year = input.year === undefined ? undefined : intInput("year", input.year, 1900, 2100, 0);
  const fromYear = year ?? (input.fromYear === undefined ? undefined : intInput("fromYear", input.fromYear, 1900, 2100, 0));
  const toYear = year ?? (input.toYear === undefined ? undefined : intInput("toYear", input.toYear, 1900, 2100, 0));
  if (year !== undefined && (input.fromYear !== undefined || input.toYear !== undefined)) throw new MudabValidationError("Invalid year: give year, or fromYear and toYear, not both.");
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) throw new MudabValidationError("Invalid fromYear and toYear: fromYear is after toYear.");
  const by = input.by;
  if (by !== undefined && !(LOAD_GROUPS as readonly string[]).includes(by)) throw new MudabValidationError(`Invalid by: expected one of ${LOAD_GROUPS.join(", ")}, got ${JSON.stringify(cutForMessage(String(by)))}.`);
  const sort = input.sort ?? "value";
  if (sort !== "value" && sort !== "year") throw new MudabValidationError(`Invalid sort: expected value or year, got ${JSON.stringify(cutForMessage(String(sort)))}.`);
  const offset = intInput("offset", input.offset, 0, 1_000_000, 0);
  const limit = intInput("limit", input.limit, 1, 500, 50);
  const maxPages = intInput("maxPages", input.maxPages, 1, 100, DEFAULT_MAX_PAGES);
  let parameter: string | undefined;
  const given = plcKind(input.kind);
  const partial: LoadsSearched = { ...(parameterText === undefined ? {} : { parameter: parameterText }), ...(river === undefined ? {} : { river }), ...(land === undefined ? {} : { land }), kind: given ?? "river", ...(year !== undefined ? { year } : {}), ...(year === undefined && fromYear !== undefined ? { fromYear } : {}), ...(year === undefined && toYear !== undefined ? { toYear } : {}), ...(by === undefined ? {} : { by }) };
  if (parameterText !== undefined) {
    const found = resolvePlcParameter(parameterText);
    if (found === undefined) {
      throw new MudabValidationError(`Invalid parameter: ${JSON.stringify(cutForMessage(parameterText))} is no PLC parameter; expected one of ${Object.entries(PLC_PARAMETERS).map(([c, p]) => `${c} (${p.label})`).join(", ")}.`);
    }
    if ("candidates" in found) return { status: "ambiguous", searched: partial, total: found.candidates.length, candidates: found.candidates, reason: `Several PLC parameters fit ${JSON.stringify(parameterText)}: ask which one is meant and call again with its code.` };
    parameter = found.code;
  }
  if (by !== undefined && parameter === undefined) throw new MudabValidationError("Invalid by: totals need a parameter (adding nitrogen to mercury means nothing).");
  // River flow is measured at flow gauges, not at the load stations.
  const kind: PlcKind = given ?? (parameter === "FLOW" ? "flow" : "river");
  const searched: LoadsSearched = { ...partial, ...(parameter === undefined ? {} : { parameter }), kind };
  const types = typesOf(kind);
  const notes: string[] = [];
  if (given === undefined) notes.push(kind === "flow" ? "River flow comes from the flow gauges (kind flow); treatment plants report theirs in m3/a (kind treatmentPlant)." : "Monitored river loads only (kind river): municipal treatment plants and the unmonitored areas are kinds of their own (kind all for every one).");

  const read = await readTable<MesswertPLC>(client, "plcMeasurements", maxPages);
  if (!read.complete) notes.push(partNote("plcMeasurements", maxPages));
  const q = river === undefined ? undefined : fold(river);
  const rowsPerYear = new Map<string, number>();
  let nulls = 0;
  let noLand = 0;
  const rows: LoadRow[] = [];
  for (const r of read.rows) {
    if (!types.includes(r.MON_TYPE ?? "")) continue;
    if (parameter !== undefined && r.NAME !== parameter) continue;
    rowsPerYear.set(r.PERIOD_NAME ?? "", (rowsPerYear.get(r.PERIOD_NAME ?? "") ?? 0) + 1);
    if (q !== undefined && !has(r.SUBCM_NAME, q) && !has(r.STATION_NAME, q) && fold(r.STATION_CODE ?? "") !== q) continue;
    const y = Number(r.PERIOD_NAME);
    if ((fromYear !== undefined && !(y >= fromYear)) || (toYear !== undefined && !(y <= toYear))) continue;
    if (land !== undefined && r.LAND_CD !== land) {
      if (r.LAND_CD === "XX") noLand += 1;
      continue;
    }
    if (typeof r.VALUE !== "number") {
      nulls += 1;
      continue;
    }
    rows.push({
      station: r.STATION_NAME ?? "",
      code: r.STATION_CODE ?? "",
      ...(r.SUBCM_NAME === undefined ? {} : { river: r.SUBCM_NAME }),
      ...(r.LAND_CD === undefined ? {} : { land: r.LAND_CD }),
      kind: MON_LABELS[r.MON_TYPE ?? ""] ?? r.MON_TYPE ?? "",
      parameter: r.NAME ?? "",
      year: r.PERIOD_NAME ?? "",
      value: r.VALUE,
      ...(r.VAL_UNIT === undefined ? {} : { unit: r.VAL_UNIT }),
      ...(r.PARAM_TYPE === undefined ? {} : { type: r.PARAM_TYPE }),
    });
  }
  if (nulls > 0) notes.push(`${nulls} matching rows have no value (null) and are left out of the rows and every total.`);
  if (noLand > 0) notes.push(`${noLand} matching rows have no Land (XX) and are left out; ask without land to see them.`);
  // The latest year with far fewer rows than the year before is still being filled (counted over
  // the parameter and kind, before the river, Land and year filters); said when the answer has it.
  const years = [...rowsPerYear.keys()].filter((y) => /^\d{4}$/.test(y)).sort();
  const last = years.at(-1);
  const before = years.at(-2);
  if (last !== undefined && before !== undefined && (rowsPerYear.get(last) ?? 0) < 0.75 * (rowsPerYear.get(before) ?? 0) && rows.some((r) => r.year === last)) {
    notes.push(`${last} looks incomplete (${rowsPerYear.get(last)} rows against ${rowsPerYear.get(before)} for ${before}): don't compare it with full years.`);
  }
  const units = uniq(rows.map((r) => r.unit));
  if (units.length > 1) {
    const doubtful = units.includes("kg/a") && units.includes("t/a")
      ? " Rows marked kg/a (the 2014 river loads, some unmonitored-area years) are of the same size as the t/a values of other years, so their unit label may be wrong: say so before comparing."
      : "";
    notes.push(`Units differ (${units.join(", ")}): totals are per unit, never added across.${doubtful}`);
  }
  // The stations the answer comes from, named when they are few.
  const named = uniq(rows.map((r) => `${r.station} (${r.code}${r.river === undefined ? "" : `, ${r.river}`})`));
  const stations = { stationCount: named.length, ...(named.length <= MAX_NAMED_STATIONS ? { stations: named } : {}) };
  if (rows.length === 0) {
    const what = `${describe(searched)} (kind ${kind})`;
    return { status: "empty", searched, reason: `No PLC value matches ${what}. The values span ${years[0] ?? "?"}–${last ?? "?"}; try another kind (all), drop the river or Land, or widen the years.`, notes };
  }
  if (by !== undefined) {
    // Per group and unit, the total of each year: the values are yearly, so a sum over years (31
    // yearly mean flows of the Peene "590 m3/s") would be no figure of the unit it carries.
    const totals = new Map<string, { group: string; unit?: string; perYear: Map<string, number>; count: number }>();
    for (const r of rows) {
      const group = by === "station" ? `${r.station} (${r.code})` : by === "year" ? r.year : by === "kind" ? r.kind : (r.land ?? "");
      const key = `${group}|${r.unit ?? ""}`;
      const entry = totals.get(key) ?? { group, ...(r.unit === undefined ? {} : { unit: r.unit }), perYear: new Map<string, number>(), count: 0 };
      entry.perYear.set(r.year, (entry.perYear.get(r.year) ?? 0) + r.value);
      entry.count += 1;
      totals.set(key, entry);
    }
    const spansYears = new Set(rows.map((r) => r.year)).size > 1 && by !== "year";
    const list: LoadTotal[] = [...totals.values()].map(({ group, unit, perYear, count }) => {
      const years = [...perYear.keys()].sort();
      const yearly = [...perYear.values()];
      const value = round(yearly.reduce((a, b) => a + b, 0) / (years.length > 1 ? years.length : 1));
      return {
        group,
        ...(unit === undefined ? {} : { unit }),
        ...(years.length > 1 ? { meanPerYear: value } : { sum: value }),
        ...(spansYears ? { years: years.length, fromYear: years[0] as string, toYear: years.at(-1) as string } : {}),
        count,
      };
    });
    const valueOf = (t: LoadTotal): number => t.sum ?? t.meanPerYear ?? 0;
    list.sort(by === "year" ? (a, b) => b.group.localeCompare(a.group) || (a.unit ?? "").localeCompare(b.unit ?? "") : (a, b) => valueOf(b) - valueOf(a));
    if (spansYears) notes.push("The answer spans several years: a group's total is the mean of its yearly totals (meanPerYear, in the unit per year) over the years it has values (years, fromYear to toYear), never their sum; a group with one year gives that year's sum. Ask with year for one year's totals.");
    if (by === "year" && kind === "river") notes.push("A year's total adds the monitored rivers that reported that year; the number of rivers changes between years (count).");
    const { items, nextOffset } = page(list, offset, limit);
    return { status: "ok", searched, total: list.length, totals: items, ...stations, ...(nextOffset === undefined ? {} : { nextOffset }), notes };
  }
  rows.sort(sort === "year" ? (a, b) => b.year.localeCompare(a.year) || b.value - a.value : (a, b) => b.value - a.value || b.year.localeCompare(a.year));
  if (parameter === undefined && sort === "value") notes.push("Rows of different parameters are ranked together: give a parameter to rank one.");
  const { items, nextOffset } = page(rows, offset, limit);
  return { status: "ok", searched, total: rows.length, rows: items, ...stations, ...(nextOffset === undefined ? {} : { nextOffset }), notes };
}

// --- listRows (any table, raw) ------------------------------------------------------------

export interface ListRowsInput {
  table: TableName;
  /** For table parameters: one compartment's own list (wasser, sediment, biota, biologie). */
  compartment?: string | undefined;
  /** A column to select on (the exact value, else any case); the whole table is then read. */
  field?: string | undefined;
  value?: string | undefined;
  offset?: number | undefined;
  /** Rows to list (1-200, default 50). */
  limit?: number | undefined;
  maxPages?: number | undefined;
}

export type RowsAnswer =
  | { status: "ok"; searched: { table: TableName; compartment?: string; field?: string; value?: string }; rows: Record<string, unknown>[]; total?: number; nextOffset?: number; notes: string[] }
  | { status: "empty"; searched: { table: TableName; compartment?: string; field?: string; value?: string }; reason: string; notes: string[] };

/**
 * Raw rows of a table: a page from `offset` (one request), or, with `field` and `value`, the rows
 * whose field is the value (trimmed), or when none is, those equal to it in another case, read from
 * the whole table in pages and paged here, with their total.
 */
export async function listRows(client: MudabClient, input: ListRowsInput): Promise<RowsAnswer> {
  const table = input.table;
  if (!(TABLES as readonly string[]).includes(table)) throw new MudabValidationError(`Invalid table: expected one of ${TABLES.join(", ")}, got ${JSON.stringify(cutForMessage(String(table)))}.`);
  const compartmentCode = input.compartment === undefined ? undefined : resolveCompartment(input.compartment);
  if (compartmentCode !== undefined && table !== "parameters") throw new MudabValidationError("Invalid compartment: it applies to table parameters only.");
  if (compartmentCode !== undefined && !(compartmentCode in COMPARTMENT_LISTS)) throw new MudabValidationError(`Invalid compartment: ${compartmentCode} has no list of its own; read table parameters with field COMPT_DS and value ${compartmentCode}.`);
  const endpoint = compartmentCode === undefined ? undefined : COMPARTMENT_LISTS[compartmentCode as keyof typeof COMPARTMENT_LISTS];
  const field = textInput("field", input.field);
  const value = input.value === undefined ? undefined : normalizeToken(assertValid("value", input.value, tokenProblem));
  if ((field === undefined) !== (value === undefined)) throw new MudabValidationError("Invalid field and value: give both, or neither.");
  const offset = intInput("offset", input.offset, 0, 2_000_000, 0);
  const limit = intInput("limit", input.limit, 1, 200, 50);
  const maxPages = intInput("maxPages", input.maxPages, 1, 100, DEFAULT_MAX_PAGES);
  const searched = { table, ...(endpoint === undefined ? {} : { compartment: endpoint }), ...(field === undefined ? {} : { field, value: value as string }) };
  const notes: string[] = [];
  const fetch = fetcher(client, table, endpoint);
  if (field === undefined) {
    const rows = await fetch({ range: { from: offset, count: limit } });
    if (rows.length === 0 && offset === 0) throw noRows(pathOf(table, endpoint));
    if (rows.length === 0) return { status: "empty", searched, reason: `${TABLE_PATHS[table]} has no rows from offset ${offset}: the table is shorter.`, notes };
    return { status: "ok", searched, rows, ...(rows.length === limit ? { nextOffset: offset + limit } : {}), notes };
  }
  // The rows whose field is the value exactly; when there are none, those equal to it in another
  // case. Values that differ only in case or punctuation are different (two station names live).
  const wanted = value as string;
  const caseless = (text: string): string => text.normalize("NFC").toLocaleLowerCase("de");
  const wantedCaseless = caseless(wanted);
  const exact = { kept: [] as Record<string, unknown>[], total: 0 };
  const other = { kept: [] as Record<string, unknown>[], total: 0, spellings: new Set<string>() };
  let columns: string[] | undefined;
  const read = await readPages(fetch, PAGE_ROWS[table], maxPages, (rows) => {
    for (const row of rows) {
      columns ??= Object.keys(row);
      const cell = row[field];
      if (cell === undefined || cell === null) continue;
      const text = String(cell).trim().normalize("NFC");
      const bucket = text === wanted ? exact : exact.total === 0 && caseless(text) === wantedCaseless ? other : undefined;
      if (bucket === undefined) continue;
      if (bucket.total >= offset && bucket.kept.length < limit) bucket.kept.push(row);
      bucket.total += 1;
      if (bucket === other && other.spellings.size < 10) other.spellings.add(text);
    }
  });
  if (read.rows === 0) throw noRows(pathOf(table, endpoint));
  if (!read.complete) notes.push(partNote(table, maxPages));
  if (columns !== undefined && !columns.includes(field)) {
    throw new MudabValidationError(`Invalid field: ${TABLE_PATHS[table]} has no column ${JSON.stringify(cutForMessage(field))}; its columns are ${columns.join(", ")}.`);
  }
  const found = exact.total > 0 ? exact : other;
  if (found.total === 0) return { status: "empty", searched, reason: `No row of ${TABLE_PATHS[table]} has ${field} equal to ${JSON.stringify(value)} (any case). Check the value's spelling in a page of rows (without field).`, notes };
  if (found === other && other.spellings.size > 1) {
    notes.push(`No row has it exactly; these ${other.spellings.size} spellings equal it in another case: ${[...other.spellings].map((t) => JSON.stringify(t)).join(", ")}. They may be different things (two stations): ask with one exactly to get its rows only.`);
  }
  return { status: "ok", searched, rows: found.kept, total: found.total, ...(offset + found.kept.length < found.total ? { nextOffset: offset + found.kept.length } : {}), notes };
}
