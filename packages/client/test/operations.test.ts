// The skills' use cases (operations.ts) against a mock of the MUDAB API (tables.ts: live rows of
// 2026-11-19, POST only, the range honoured and nothing else), with the skills' traps as cases:
// stations counted by name, not by row; region and institute from the project station, conflicts
// listed, never picked; a substance's compartments from each compartment's own list; the
// measurement table's units kept apart and the table read once per while; PLC rows not all river
// loads, nulls dropped and counted, units never added across; ambiguity reported; every empty
// answer saying what was searched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MudabClient } from "../src/client.js";
import { MudabParseError, MudabValidationError } from "../src/errors.js";
import { findParameters, findStations, getMeasurements, getRiverLoads, listRows, readPages, unitOf, MEASUREMENTS_CACHE_MS } from "../src/operations.js";
import { makeMockTransport } from "./helpers.js";
import { apiLog, mudabApi, sampleTables, type Tables } from "./tables.js";

/** A client on the mock API over `tables`, and its request log. */
function clientOn(tables: Tables = sampleTables()) {
  const log = apiLog();
  const mock = makeMockTransport(mudabApi(tables, log));
  return { client: new MudabClient({ transport: mock.transport }), log, mock };
}

const names = (list: { name?: string; code?: string }[]): string[] => list.map((s) => s.name ?? s.code ?? "");

test("readPages reads page after page until a short one, and says when maxPages stopped it", async () => {
  const table = Array.from({ length: 25 }, (_, i) => i);
  const asked: [number, number][] = [];
  const fetch = async (req: { range?: { from?: number; count?: number } }) => {
    asked.push([req.range?.from ?? -1, req.range?.count ?? -1]);
    return table.slice(req.range?.from, (req.range?.from ?? 0) + (req.range?.count ?? 0));
  };
  const seen: number[] = [];
  assert.deepEqual(await readPages(fetch, 10, 5, (rows) => seen.push(...rows)), { rows: 25, pages: 3, complete: true });
  assert.deepEqual(asked, [[0, 10], [10, 10], [20, 10]]);
  assert.deepEqual(seen, table);
  assert.deepEqual(await readPages(fetch, 10, 2, () => {}), { rows: 20, pages: 2, complete: false });
  // A table of exactly a page's multiple ends with an empty page.
  assert.deepEqual(await readPages(fetch, 5, 10, () => {}), { rows: 25, pages: 6, complete: true });
});

test("measurement stations are counted by name, once per station, with every compartment its rows give", async () => {
  const { client, log, mock } = clientOn();
  const answer = await findStations(client, { name: "220051" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(answer.total, 1);
  assert.equal(answer.rows, 3, "the table repeats the station");
  assert.deepEqual(answer.stations[0], { name: "220051", projectStations: ["220051"], compartments: ["BL", "CW"], stationTypes: ["Sublitoral"], regions: [], institutes: [] });
  assert.match(answer.notes.join(" "), /total counts station names/);
  assert.deepEqual(log.requests.map((r) => r.table), ["PROJECTSTATION_SMALL", "STATION_SMALL"]);
  assert.ok(mock.calls.every((call) => call.method === "POST"));
});

test("region and institute come from the project station; a name with several is listed with all, never picked", async () => {
  const { client } = clientOn();
  const north = await findStations(client, { region: "North Sea" });
  assert.equal(north.status, "ok");
  if (north.status !== "ok") return;
  assert.deepEqual(names(north.stations), ["L1_(1)", "WB1"], "L1 is BSH/Nordsee too, so its station is in the North Sea");
  assert.deepEqual((north.stations[0] as { regions: string[]; institutes: string[] }).regions, ["Nordsee", "Ostsee"]);
  assert.match(north.notes.join(" "), /carr(?:y|ies) several regions or institutes .*never pick one/);
  const project = await findStations(client, { kind: "project", institute: "bsh" });
  assert.equal(project.status, "ok");
  if (project.status !== "ok") return;
  assert.deepEqual(names(project.stations), ["L1", "WB1"]);
  assert.deepEqual(project.stations[0], { name: "L1", regions: ["Nordsee", "Ostsee"], institutes: ["BSH", "IOW"], ids: [55, 464, 396] });
  assert.equal(project.rows, 4);
  const baltic = await findStations(client, { kind: "project", region: "Ostsee", name: "darss" });
  assert.deepEqual(baltic.status === "ok" ? names(baltic.stations) : [], ["Darss Sill"]);
});

test("a station whose rows name two project stations lists both, with the regions and institutes of both", async () => {
  const tables = sampleTables();
  tables.projectStations.push({ metadataid: 31, PROJECTSTATIONID: 7001, NAME_PS: "OMBMPK4", REGION: "Ostsee", INSTITUT: "IOW" }, { metadataid: 31, PROJECTSTATIONID: 7002, NAME_PS: "BMP K4", REGION: "Ostsee", INSTITUT: "BSH" });
  tables.stations.push({ metadataid: 32, STATNAME_ST: "BMP K4", NAME_PS: "OMBMPK4", STATIONTYPE_ST: "Normal", COMPT_DS: "CW" }, { metadataid: 32, STATNAME_ST: "BMP K4", NAME_PS: "BMP K4", STATIONTYPE_ST: "Normal", COMPT_DS: "CS" });
  const { client } = clientOn(tables);
  const both = await findStations(client, { name: "BMP K4" });
  assert.deepEqual(both.status === "ok" ? both.stations : [], [{ name: "BMP K4", projectStations: ["BMP K4", "OMBMPK4"], compartments: ["CS", "CW"], stationTypes: ["Normal"], regions: ["Ostsee"], institutes: ["BSH", "IOW"] }]);
  assert.match(both.status === "ok" ? both.notes.join(" ") : "", /1 station is listed under several project stations/);
  const bsh = await findStations(client, { name: "BMP K4", institute: "BSH" });
  assert.deepEqual(bsh.status === "ok" ? bsh.stations : [], [{ name: "BMP K4", projectStations: ["BMP K4"], compartments: ["CS"], stationTypes: ["Normal"], regions: ["Ostsee"], institutes: ["BSH"] }], "only its rows under a BSH project station");
});

test("the conflict note counts project-station names, not the stations under them", async () => {
  const tables = sampleTables();
  tables.stations.push({ metadataid: 32, STATNAME_ST: "L1_(2)", NAME_PS: "L1", STATIONTYPE_ST: "Normal", COMPT_DS: "CW" }, { metadataid: 32, STATNAME_ST: "L1_(3)", NAME_PS: "L1", STATIONTYPE_ST: "Normal", COMPT_DS: "CW" });
  const { client } = clientOn(tables);
  const l1 = await findStations(client, { name: "L1" });
  assert.equal(l1.status === "ok" && l1.total, 3);
  assert.match(l1.status === "ok" ? l1.notes.join(" ") : "", /^1 project-station name carries several regions or institutes/);
  const all = await findStations(client, {});
  assert.match(all.status === "ok" ? all.notes.join(" ") : "", /^1 project-station name carries/, "L1 is the only name with a conflict");
});

test("a name, group, river or parameter of punctuation only is refused before any request: it would match everything", async () => {
  const { client, log } = clientOn();
  for (const name of ["-", ".", "*", "()", "_"]) {
    await assert.rejects(findStations(client, { name }), /Invalid name: .* has no letter or digit/);
    await assert.rejects(findStations(client, { kind: "plc", name }), /Invalid name/);
    await assert.rejects(findStations(client, { kind: "project", name }), /Invalid name/);
  }
  await assert.rejects(findStations(client, { stationType: "-" }), /Invalid stationType/);
  await assert.rejects(findParameters(client, { name: "*" }), /Invalid name/);
  await assert.rejects(findParameters(client, { group: "-" }), /Invalid group/);
  await assert.rejects(findParameters(client, { name: "*", plc: true }), /Invalid name/);
  await assert.rejects(getMeasurements(client, { station: "-" }), /Invalid station/);
  await assert.rejects(getMeasurements(client, { parameter: "?" }), /Invalid parameter/);
  await assert.rejects(getRiverLoads(client, { river: "-" }), /Invalid river/);
  assert.equal(log.requests.length, 0);
});

test("filters of another kind, an unknown region or compartment are refused before any request", async () => {
  const { client, log } = clientOn();
  await assert.rejects(findStations(client, { kind: "project", compartment: "wasser" }), /Invalid compartment: compartment and stationType apply to measurement stations/);
  await assert.rejects(findStations(client, { land: "MV" }), /Invalid land: land and monitoring apply to HELCOM PLC stations/);
  await assert.rejects(findStations(client, { kind: "plc", region: "Ostsee" }), MudabValidationError);
  await assert.rejects(findStations(client, { region: "Atlantik" }), /expected Nordsee \(North Sea\) or Ostsee \(Baltic Sea\)/);
  await assert.rejects(findStations(client, { compartment: "air" }), /CW \(Wasser, water\)/);
  await assert.rejects(findStations(client, { name: "​" }), MudabValidationError);
  assert.equal(log.requests.length, 0);
});

test("a compartment is matched by name or code; an empty answer says what was searched", async () => {
  const { client } = clientOn();
  const sediment = await findStations(client, { compartment: "Sediment" });
  assert.deepEqual(sediment.status === "ok" ? names(sediment.stations) : [], ["WB1"]);
  const none = await findStations(client, { name: "Helgoland", compartment: "biota" });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /No measurement station matches name "Helgoland", compartment "CF"/);
});

test("PLC stations: one entry per code, a Land from any of its rows, rivers by name, coordinates and pseudo-stations said", async () => {
  const { client } = clientOn();
  const sh = await findStations(client, { kind: "plc", land: "Schleswig-Holstein" });
  assert.equal(sh.status, "ok");
  if (sh.status !== "ok") return;
  assert.deepEqual(names(sh.stations).sort(), ["AN DER KALTENHÖFERSTRASSE", "MOISLING", "ZKW LÜBECK"]);
  assert.equal(sh.total, 3, "ZKW LÜBECK is listed twice in the table");
  assert.equal(sh.rows, 6, "the rows of these three stations (SCHWARTAU's under XX too), not the whole table's 11");
  const mv = await findStations(client, { kind: "plc", land: "MV" });
  assert.equal(mv.status === "ok" && mv.rows, 4);
  const river = await findStations(client, { kind: "plc", name: "warnow" });
  assert.deepEqual(river.status === "ok" ? river.stations : [], [{ code: "CDE0017", name: "ROSTOCK", river: "WARNOW", monitoring: "monitored river load", monType: "MON_RIVER_LOAD", lands: ["MV"], lat: 54.0833, lon: 12.15 }]);
  const plants = await findStations(client, { kind: "plc", monitoring: "treatmentPlant" });
  assert.equal(plants.status === "ok" && plants.total, 2);
  assert.match(plants.status === "ok" ? plants.notes.join(" ") : "", /1 stations have no coordinates/);
  const all = await findStations(client, { kind: "plc" });
  assert.match(all.status === "ok" ? all.notes.join(" ") : "", /WEBDELAND and BAPDELAND are pseudo-stations/);
  await assert.rejects(findStations(client, { kind: "plc", monitoring: "lake" as never }), /Invalid kind: expected one of river, flow/);
});

test("a substance's compartments come from every compartment's own list, not the combined table", async () => {
  const { client, log } = clientOn();
  const mercury = await findParameters(client, { name: "mercury" });
  assert.equal(mercury.status, "ok");
  if (mercury.status !== "ok") return;
  assert.deepEqual(mercury.parameters.map((p) => [p.code, (p as { compartments: string[] }).compartments]), [
    ["HG", ["CF", "CS", "CW"]],
    ["HGTOR", ["MM"]],
  ]);
  assert.deepEqual(log.requests.map((r) => r.table), ["MV_PARAMETER", "MV_PARAMETER_WASSER", "MV_PARAMETER_SEDIMENT", "MV_PARAMETER_BIOTA", "MV_PARAMETER_BIOLOGIE"]);
  assert.match(mercury.notes.join(" "), /holds only weather and sea-state observations/);
  // One compartment: its own list only.
  const before = log.requests.length;
  const sediment = await findParameters(client, { name: "Hg", compartment: "sediment" });
  assert.deepEqual(sediment.status === "ok" ? sediment.parameters.map((p) => p.code) : [], ["HG"], "the exact code first");
  assert.deepEqual(log.requests.slice(before).map((r) => r.table), ["MV_PARAMETER_SEDIMENT"]);
});

test("parameters by group (null groups never break it), deprecated last, German names answered with the English hint", async () => {
  const { client } = clientOn();
  const nutrients = await findParameters(client, { group: "nutrient" });
  assert.deepEqual(nutrients.status === "ok" ? nutrients.parameters.map((p) => p.code) : [], ["NTOT", "PHOS", "PTOT"]);
  const all = await findParameters(client, {});
  assert.equal(all.status === "ok" && all.parameters.at(-1)?.code, "_ID486");
  const german = await findParameters(client, { name: "Quecksilber" });
  assert.equal(german.status, "empty");
  assert.match(german.status === "empty" ? german.reason : "", /Names are English: try the English name \("mercury"/);
});

test("PLC parameters: per parameter the stations, the values and the last year", async () => {
  const { client, log } = clientOn();
  const plc = await findParameters(client, { plc: true, name: "Stickstoff" });
  assert.deepEqual(plc.status === "ok" ? plc.parameters : [], [{ code: "Ntot", label: "total nitrogen", group: "TOT", stations: 2, values: 58, lastYear: "2025" }]);
  assert.deepEqual(log.requests.map((r) => r.table), ["V_GEMESSENE_PARA_PLC"]);
  await assert.rejects(findParameters(client, { plc: true, compartment: "CW" }), /they apply to the monitoring parameters/);
});

test("a station's values: newest first, one series per parameter and unit, exact copies counted once, other stations of a similar name said", async () => {
  const { client } = clientOn();
  const answer = await getMeasurements(client, { station: "ommvzba15", now: () => 0 });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok" || !("values" in answer)) return assert.fail("values expected");
  assert.equal(answer.station, "OMMVZBA15");
  assert.equal(answer.total, 5);
  assert.deepEqual(answer.values[0], { station: "OMMVZBA15", parameter: "WAVHT", unit: "sc", date: "2013-06-04", time: "07:55", value: 2 });
  assert.deepEqual(answer.series.map((s) => [s.parameter, s.unit, s.count]), [["SurTemp", "degC", 3], ["WAVHT", "m", 1], ["WAVHT", "sc", 1]]);
  assert.deepEqual(answer.series[0], { station: "OMMVZBA15", parameter: "SurTemp", label: "sea surface temperature", unit: "degC", count: 3, firstDate: "2011-10-19", lastDate: "2012-05-10", min: 9.4, max: 11.8, mean: 10.9333 });
  const notes = answer.notes.join(" ");
  assert.match(notes, /Units differ within a parameter \(WAVHT: m, sc\)/);
  assert.match(notes, /separate stations: OMMVZBA15_CW/);
  assert.match(notes, /The table repeats rows: 2 of its 13 rows are exact copies of another and are counted once/);
  const paged = await getMeasurements(client, { station: "OMMVZBA15", parameter: "SurTemp", from: "2011-01-01", to: "2011-12-31", limit: 1, now: () => 0 });
  assert.deepEqual(paged.status === "ok" && "values" in paged ? [paged.total, paged.values.map((v) => v.time), paged.nextOffset] : [], [2, ["08:53"], 1]);
});

test("a part of a station name that fits several is ambiguous; a station without values is empty and points to findStations", async () => {
  const { client } = clientOn();
  const part = await getMeasurements(client, { station: "OMMVZB", now: () => 0 });
  assert.equal(part.status, "ambiguous");
  assert.deepEqual(part.status === "ambiguous" ? part.candidates : [], ["OMMVZBA15", "OMMVZBA15_CW"]);
  const none = await getMeasurements(client, { station: "Darss Sill", now: () => 0 });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /most stations have none\. Find names with findStations/);
});

test("parameters by name: one fits, several are ambiguous, a substance is not in this table", async () => {
  const { client } = clientOn();
  const water = await getMeasurements(client, { parameter: "Wassertemperatur", now: () => 0 });
  assert.deepEqual(water.status === "ok" && "stations" in water ? [water.parameter, water.stations.map((s) => s.station)] : [], ["SurTemp", ["OMMVZBA15"]]);
  const temperature = await getMeasurements(client, { parameter: "temperature", now: () => 0 });
  assert.equal(temperature.status, "ambiguous");
  assert.deepEqual(temperature.status === "ambiguous" ? temperature.candidates : [], ["SurTemp (sea surface temperature)", "AIRTEMP (air temperature)"]);
  const mercury = await getMeasurements(client, { parameter: "mercury", now: () => 0 });
  assert.match(mercury.status === "empty" ? mercury.reason : "", /weather and sea observations only: .*Substances \(nutrients, metals, pollutants\) are not in it/);
  const air = await getMeasurements(client, { parameter: "AIRTEMP", now: () => 0 });
  assert.equal(air.status, "ok");
  assert.match(air.status === "ok" ? air.notes.join(" ") : "", /AIRTEMP: degC, not stated.*A series without unit/);
  await assert.rejects(getMeasurements(client, { from: "2024-02-30", now: () => 0 }), /Invalid from: expected a day as YYYY-MM-DD/);
});

test("the measurement table is read once and kept for a while per client, then read again", async () => {
  const { client, log } = clientOn();
  let now = 1_000;
  const overview = await getMeasurements(client, { now: () => now });
  assert.deepEqual(overview.status === "ok" && "parameters" in overview ? overview.parameters.map((p) => p.parameter) : [], ["WAVHT", "AIRTEMP", "SurTemp", "_CLOUD"]);
  assert.equal(log.of("MV_STATION_MSMNT"), 1);
  now += MEASUREMENTS_CACHE_MS - 1;
  await getMeasurements(client, { station: "DB16", now: () => now });
  assert.equal(log.of("MV_STATION_MSMNT"), 1);
  now += 1;
  await getMeasurements(client, { station: "DB16", now: () => now });
  assert.equal(log.of("MV_STATION_MSMNT"), 2);
  assert.deepEqual(log.requests.at(-1), { table: "MV_STATION_MSMNT", from: 0, count: 30_000 });
});

test("two calls at once share one read of the measurement table", async () => {
  const { client, log } = clientOn();
  const [a, b] = await Promise.all([getMeasurements(client, { now: () => 0 }), getMeasurements(client, { parameter: "SurTemp", now: () => 0 })]);
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.equal(log.of("MV_STATION_MSMNT"), 1, "one read for both");
});

test("a measurement table read that fails keeps its pages: the next call goes on where it stopped", async () => {
  // Three pages (30,000 rows each), the second failing once (a call's deadline, a reset).
  const tables = sampleTables();
  const filler = tables.measurements[0] as (typeof tables.measurements)[number];
  tables.measurements = [...tables.measurements, ...Array.from({ length: 60_000 }, (_, i) => ({ ...filler, DATE_STM: String(19_900_101 + (i % 28)) }))];
  const log = apiLog();
  const api = mudabApi(tables, log);
  let failures = 1;
  const transport = async (req: Parameters<typeof api>[0]) => {
    if (failures > 0 && JSON.parse(String(req.body)).range?.from === 30_000) {
      failures -= 1;
      throw new Error("socket hang up");
    }
    return api(req);
  };
  const client = new MudabClient({ transport, maxRetries: 0 });
  await assert.rejects(getMeasurements(client, { now: () => 0 }), /socket hang up/);
  assert.deepEqual(log.requests.map((r) => r.from), [0], "the failed page isn't logged by the mock");
  const answer = await getMeasurements(client, { parameter: "SurTemp", now: () => 0 });
  assert.equal(answer.status, "ok");
  assert.deepEqual(log.requests.map((r) => r.from), [0, 30_000, 60_000], "page 0 isn't read again");
  assert.match(answer.status === "ok" ? answer.notes.join(" ") : "", new RegExp(`of its ${tables.measurements.length} rows`), "every row counted once");
  // Two calls at once: the one that joined goes on by itself when the read fails for the other.
  failures = 1;
  const fresh = new MudabClient({ transport, maxRetries: 0 });
  const [a, b] = await Promise.allSettled([getMeasurements(fresh, { now: () => 0 }), getMeasurements(fresh, { now: () => 0 })]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status === "fulfilled" && b.value.status, "ok");
});

test("the unit is the method id's token before the institute, or none", () => {
  assert.equal(unitOf("APSurTemp THRNFNON degC IFAG"), "degC");
  assert.equal(unitOf("2D 25 25 APWINDD 151 NFNON _Grad BSHG"), "_Grad");
  assert.equal(unitOf("APAIRTEMP THRNFNON LUNG"), "");
  assert.equal(unitOf(undefined), "");
});

test("river loads: monitored rivers by default, ranked; nulls dropped and counted; an incomplete last year said", async () => {
  const { client, log } = clientOn();
  const answer = await getRiverLoads(client, { parameter: "Stickstoff", year: 2024 });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok" || !("rows" in answer)) return assert.fail("rows expected");
  assert.deepEqual(answer.searched, { parameter: "Ntot", kind: "river", year: 2024 });
  assert.deepEqual(answer.rows.map((r) => [r.river, r.value]), [["PEENE", 2796.507925], ["WARNOW", 1656.518409], ["TRAVE", 1536.256267]], "WEBDELAND (unmonitored) is no river");
  const notes = answer.notes.join(" ");
  assert.match(notes, /Monitored river loads only \(kind river\)/);
  assert.match(notes, /1 matching rows have no value \(null\)/);
  assert.doesNotMatch(notes, /2025 looks incomplete/, "the answer has no 2025 row");
  assert.deepEqual(log.requests, [{ table: "V_MESSWERTE_PLC", from: 0, count: 25_000 }]);
  const all = await getRiverLoads(client, { parameter: "Ntot" });
  assert.match(all.status === "ok" ? all.notes.join(" ") : "", /2025 looks incomplete \(1 rows against 4 for 2024\)/);
});

test("river-load notes speak of the rows answered: no incomplete-year note without that year, no kg/a note without kg/a rows", async () => {
  const { client } = clientOn();
  const span = await getRiverLoads(client, { parameter: "Ntot", river: "Peene", fromYear: 2012, toYear: 2024, by: "year" });
  assert.doesNotMatch(span.status === "ok" ? span.notes.join(" ") : "", /looks incomplete/);
  const flow = await getRiverLoads(client, { parameter: "FLOW", kind: "all", by: "kind" });
  const notes = flow.status === "ok" ? flow.notes.join(" ") : "";
  assert.match(notes, /Units differ \(m3\/a, m3\/s\): totals are per unit, never added across/);
  assert.doesNotMatch(notes, /kg\/a/);
  const hg = await getRiverLoads(client, { parameter: "Hg", by: "year" });
  assert.match(hg.status === "ok" ? hg.notes.join(" ") : "", /Rows marked kg\/a/);
});

test("totals per kind add one parameter, per unit; without a parameter there is no total", async () => {
  const { client } = clientOn();
  const byKind = await getRiverLoads(client, { parameter: "Ntot", year: 2024, kind: "all", by: "kind" });
  assert.deepEqual(byKind.status === "ok" && "totals" in byKind ? byKind.totals : [], [
    { group: "monitored river load", unit: "t/a", sum: 5989.2826, count: 3 },
    { group: "unmonitored area (pseudo-station)", unit: "t/a", sum: 5000.7, count: 1 },
    { group: "municipal treatment plant", unit: "t/a", sum: 123.7, count: 2 },
  ]);
  await assert.rejects(getRiverLoads(client, { by: "year" }), /totals need a parameter/);
  const hg = await getRiverLoads(client, { parameter: "mercury", by: "year" });
  assert.deepEqual(hg.status === "ok" && "totals" in hg ? hg.totals.map((t) => [t.group, t.unit]) : [], [["2014", "kg/a"], ["2013", "t/a"]]);
  assert.match(hg.status === "ok" ? hg.notes.join(" ") : "", /Units differ \(kg\/a, t\/a\): totals are per unit, never added across/);
});

test("totals over several years are the mean of the yearly totals, per year, with the years they span; never a sum of years", async () => {
  const { client } = clientOn();
  const byStation = await getRiverLoads(client, { parameter: "Ntot", by: "station" });
  assert.deepEqual(byStation.status === "ok" && "totals" in byStation ? byStation.totals : [], [
    { group: "ANKLAM (CDE0007)", unit: "t/a", meanPerYear: 2632.2026, years: 3, fromYear: "2023", toYear: "2025", count: 3 },
    { group: "ROSTOCK (CDE0017)", unit: "t/a", meanPerYear: 1578.3592, years: 2, fromYear: "2023", toYear: "2024", count: 2 },
    { group: "MOISLING (CDE0030)", unit: "t/a", meanPerYear: 1468.2781, years: 2, fromYear: "2023", toYear: "2024", count: 2 },
    { group: "AN DER KALTENHÖFERSTRASSE (CDE0032)", unit: "t/a", sum: 300.4, years: 1, fromYear: "2023", toYear: "2023", count: 1 },
  ]);
  assert.match(byStation.status === "ok" ? byStation.notes.join(" ") : "", /the mean of its yearly totals \(meanPerYear, in the unit per year\).*never their sum/);
  const byLand = await getRiverLoads(client, { parameter: "Ntot", by: "land", land: "MV" });
  assert.deepEqual(byLand.status === "ok" && "totals" in byLand ? byLand.totals : [], [{ group: "MV", unit: "t/a", meanPerYear: 3684.4421, years: 3, fromYear: "2023", toYear: "2025", count: 5 }]);
  const oneYear = await getRiverLoads(client, { parameter: "Ntot", by: "land", land: "MV", year: 2024 });
  assert.deepEqual(oneYear.status === "ok" && "totals" in oneYear ? oneYear.totals : [], [{ group: "MV", unit: "t/a", sum: 4453.0263, count: 2 }]);
  assert.doesNotMatch(oneYear.status === "ok" ? oneYear.notes.join(" ") : "", /meanPerYear/);
  const byYear = await getRiverLoads(client, { parameter: "Ntot", by: "year" });
  assert.deepEqual(byYear.status === "ok" && "totals" in byYear ? byYear.totals.map((t) => [t.group, t.sum]) : [], [["2025", 2600], ["2024", 5989.2826], ["2023", 5701]]);
});

test("parameter words resolve or are ambiguous; flow defaults to the flow gauges; a Land leaves out rows without one, said", async () => {
  const { client } = clientOn();
  const phosph = await getRiverLoads(client, { parameter: "phosph" });
  assert.equal(phosph.status, "ambiguous");
  assert.deepEqual(phosph.status === "ambiguous" ? phosph.candidates : [], ["Ptot (total phosphorus)", "PPO4 (phosphate phosphorus)"]);
  await assert.rejects(getRiverLoads(client, { parameter: "Uran" }), /is no PLC parameter; expected one of Ntot \(total nitrogen\)/);
  const flow = await getRiverLoads(client, { parameter: "Abfluss" });
  assert.deepEqual(flow.status === "ok" && "rows" in flow ? [flow.searched.kind, flow.rows.map((r) => [r.river, r.unit])] : [], ["flow", [["BARTHE", "m3/s"]]]);
  const sh = await getRiverLoads(client, { parameter: "Ntot", land: "SH", fromYear: 2023, toYear: 2024 });
  assert.deepEqual(sh.status === "ok" && "rows" in sh ? sh.rows.map((r) => [r.station, r.year]) : [], [["MOISLING", "2024"], ["MOISLING", "2023"]]);
  assert.match(sh.status === "ok" ? sh.notes.join(" ") : "", /2 matching rows have no Land \(XX\)/);
  const none = await getRiverLoads(client, { parameter: "Ntot", river: "Oder" });
  assert.match(none.status === "empty" ? none.reason : "", /No PLC value matches parameter "Ntot", river "Oder" .*kind river.*try another kind/);
});

test("station names that differ only in case or punctuation: the exact name selects one, listRows gives its rows only", async () => {
  const tables = sampleTables();
  const v = (name: string, value: number) => ({ metadataid: 39, STATNAME_ST: name, PARAMETERID_PM: "APWAVHT VISONANON m IFAG", STATNAME_DATE_TIME: name, PARAMCODE_PM: "WAVHT", DATE_STM: "20200101", TIME_STM: "1200", VALUE_MS: value });
  tables.measurements.push(v("EIDER V Eider outer", 1.5), v("Eider V Eider outer", 2.5), v("OMO5_1", 1), v("OMO5(1)", 2), v("OMO5_(1)", 3));
  for (const name of ["OMO5_1", "OMO5(1)", "OMO5_(1)"]) tables.stations.push({ metadataid: 32, STATNAME_ST: name, NAME_PS: "OMO5", STATIONTYPE_ST: "Normal", COMPT_DS: "CW" });
  const { client } = clientOn(tables);
  for (const [name, value] of [["EIDER V Eider outer", 1.5], ["Eider V Eider outer", 2.5], ["OMO5(1)", 2], [" OMO5_(1) ", 3]] as const) {
    const answer = await getMeasurements(client, { station: name, now: () => 0 });
    assert.equal(answer.status, "ok", `${name}: ${JSON.stringify(answer)}`);
    assert.deepEqual(answer.status === "ok" && "values" in answer ? [answer.station, answer.values.map((x) => x.value)] : [], [name.trim(), [value]]);
  }
  const folded = await getMeasurements(client, { station: "eider v eider outer", now: () => 0 });
  assert.equal(folded.status, "ambiguous", "two names fit it in another case; neither is it");
  assert.match(folded.status === "ambiguous" ? folded.reason : "", /exactly as listed/);
  const exact = await listRows(client, { table: "stations", field: "STATNAME_ST", value: "OMO5_1" });
  assert.deepEqual(exact.status === "ok" ? [exact.total, exact.rows.map((r) => r["STATNAME_ST"])] : [], [1, ["OMO5_1"]]);
  const caseless = await listRows(client, { table: "measurements", field: "STATNAME_ST", value: "eider v eider outer" });
  assert.deepEqual(caseless.status === "ok" ? [caseless.total, caseless.rows.map((r) => r["STATNAME_ST"])] : [], [2, ["EIDER V Eider outer", "Eider V Eider outer"]]);
  assert.match(caseless.status === "ok" ? caseless.notes.join(" ") : "", /No row has it exactly; these 2 spellings equal it in another case: "EIDER V Eider outer", "Eider V Eider outer"/);
  const one = await listRows(client, { table: "measurements", field: "STATNAME_ST", value: "Eider V Eider outer" });
  assert.deepEqual(one.status === "ok" ? one.rows.map((r) => r["STATNAME_ST"]) : [], ["Eider V Eider outer"]);
});

test("rows of another shape are an error naming the field, never no value or no match; a table answering no rows at all too", async () => {
  // Rows are replaced, never changed in place: sampleTables shares its station objects between calls.
  const drift = (change: (t: Tables) => void) => {
    const tables = sampleTables();
    change(tables);
    return clientOn(tables).client;
  };
  const strings = drift((t) => { t.plcMeasurements = t.plcMeasurements.map((r) => ({ ...r, VALUE: r.VALUE == null ? null : (String(r.VALUE) as never) })); });
  await assert.rejects(getRiverLoads(strings, { parameter: "Ntot", year: 2023 }), (err: unknown) => err instanceof MudabParseError && /V_MESSWERTE_PLC: field VALUE is the text "2500\.1", where a number was; MUDAB's rows have changed shape/.test(err.message));
  const object = drift((t) => { t.plcStations[0] = { ...t.plcStations[0], STATION_NAME: { de: "ANKLAM" } as never }; });
  await assert.rejects(findStations(object, { kind: "plc", name: "x" }), /V_PLC_STATION: field STATION_NAME is an object, where a text was/);
  const code = drift((t) => { t.plcStations[1] = { ...t.plcStations[1], STATION_CODE: 7 as never }; });
  await assert.rejects(findStations(code, { kind: "plc" }), /field STATION_CODE is the number 7, where a text was/);
  const land = drift((t) => { t.plcStations[1] = { ...t.plcStations[1], LAND_CD: ["MV"] as never }; });
  await assert.rejects(findStations(land, { kind: "plc" }), /field LAND_CD is an array/);
  const renamed = drift((t) => { t.measurements = t.measurements.map(({ VALUE_MS, ...r }) => ({ ...r, VALUE: VALUE_MS }) as never); });
  await assert.rejects(getMeasurements(renamed, { now: () => 0 }), /MV_STATION_MSMNT: no row of the page has the field VALUE_MS/);
  const emptyPlc = drift((t) => { t.plcStations = []; });
  await assert.rejects(findStations(emptyPlc, { kind: "plc" }), (err: unknown) => err instanceof MudabParseError && /V_PLC_STATION answered no rows at all/.test(err.message));
  const emptyValues = drift((t) => { t.measurements = []; });
  await assert.rejects(getMeasurements(emptyValues, { now: () => 0 }), /MV_STATION_MSMNT answered no rows at all/);
  const emptyRows = drift((t) => { t.projectStations = []; });
  await assert.rejects(listRows(emptyRows, { table: "projectStations", field: "NAME_PS", value: "L1" }), /PROJECTSTATION_SMALL answered no rows at all/);
  await assert.rejects(listRows(emptyRows, { table: "projectStations" }), /PROJECTSTATION_SMALL answered no rows at all/);
  // A null is "no value", and a field the use case doesn't read may be anything.
  const nulls = drift((t) => { t.plcStations[0] = { ...t.plcStations[0], ST_LAT: null, metadataid: "x" as never }; });
  assert.equal((await findStations(nulls, { kind: "plc" })).status, "ok");
});

test("a server that ignores the range is an error a caller of the use cases can act on: no advice to fetch the whole table", async () => {
  // Tables one row longer than a page, answered whole whatever the range asks for.
  const tables = sampleTables();
  tables.plcStations = Array.from({ length: 20_001 }, (_, i) => tables.plcStations[i % tables.plcStations.length] as (typeof tables.plcStations)[number]);
  tables.plcMeasurements = Array.from({ length: 25_001 }, (_, i) => tables.plcMeasurements[i % tables.plcMeasurements.length] as (typeof tables.plcMeasurements)[number]);
  const api = mudabApi(tables);
  const transport = async (req: Parameters<typeof api>[0]) => api({ ...req, body: Buffer.from("{}") });
  const client = new MudabClient({ transport });
  for (const call of [() => getRiverLoads(client, {}), () => findStations(client, { kind: "plc" }), () => listRows(client, { table: "plcStations", limit: 1 })]) {
    await assert.rejects(call(), (err: unknown) => {
      assert.ok(err instanceof MudabParseError);
      assert.match(err.message, /asked for at most \d+ rows \(from 0\), got \d+\. The server did not honour the range, so these are not the rows asked for; the table can't be read in pages/);
      assert.doesNotMatch(err.message, /--all|all: true/);
      return true;
    });
  }
  await assert.rejects(client.plcStations({ range: { from: 0, count: 1 } }), /fetch the whole table \(\{ all: true \}; --all on the CLI\)/, "the client's own advice stays for its callers");
});

test("raw rows: a page is one ranged request; a field selects across the whole table; an unknown field names the columns", async () => {
  const { client, log } = clientOn();
  const page = await listRows(client, { table: "projectStations", offset: 2, limit: 2 });
  assert.deepEqual(page.status === "ok" ? [page.rows.map((r) => r["PROJECTSTATIONID"]), page.nextOffset] : [], [[464, 396], 4]);
  assert.deepEqual(log.requests.at(-1), { table: "PROJECTSTATION_SMALL", from: 2, count: 2 });
  const institute = await listRows(client, { table: "projectStations", field: "INSTITUT", value: "iow" });
  assert.deepEqual(institute.status === "ok" ? [institute.total, institute.rows.map((r) => r["NAME_PS"])] : [], [2, ["L1", "Darss Sill"]]);
  await assert.rejects(listRows(client, { table: "projectStations", field: "REGIO", value: "Ostsee" }), /has no column "REGIO"; its columns are metadataid, PROJECTSTATIONID, NAME_PS, REGION, INSTITUT/);
  await assert.rejects(listRows(client, { table: "projectStations", field: "REGION" }), /give both, or neither/);
  await assert.rejects(listRows(client, { table: "stations", compartment: "wasser" }), /applies to table parameters only/);
  const water = await listRows(client, { table: "parameters", compartment: "Wasser", limit: 1 });
  assert.deepEqual(log.requests.at(-1), { table: "MV_PARAMETER_WASSER", from: 0, count: 1 });
  assert.equal(water.status === "ok" && water.rows[0]?.["PARAMETER"], "NTOT");
});
