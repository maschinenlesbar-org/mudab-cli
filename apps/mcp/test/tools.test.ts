// This server's tools against a mock of the MUDAB API (the client's tables.ts: live rows of
// 2026-11-19, POST only, the range honoured and nothing else), with the skills' traps as cases:
// each tool answers through the protocol (its structuredContent checked by the SDK against its
// output schema), stations counted by name with every region of their project station, a
// substance's compartments from every compartment list, units kept apart, river loads only unless
// asked, ambiguity reported, an empty answer saying what was searched, and every result carrying
// the source and the provider's terms. The rules every server follows are the conformance tests
// (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { mudab } from "./helpers.js";

const BASE = "https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements";

test("five tools: stations, parameters, measurements, river loads, then the raw rows", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findStations", "findParameters", "getMeasurements", "getRiverLoads", "listRows"]);
});

test("findStations: stations once by name, regions from the project station, conflicts kept; the source and the terms in the result", async () => {
  const upstream = mudab();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("findStations", { region: "Nordsee" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual((content["stations"] as { name: string; regions: string[] }[]).map((s) => [s.name, s.regions]), [["L1_(1)", ["Nordsee", "Ostsee"]], ["WB1", ["Nordsee"]]]);
  assert.equal(content["source"], `${BASE}/STATION_SMALL`);
  assert.match(String(content["licence"]), /No open licence.*otherRestrictions.*Datenquelle: Meeresumweltdatenbank \(MUDAB\).*geoportal@bafg\.de/);
  assert.ok(upstream.calls.every((call) => call.method === "POST"), "MUDAB is asked with POST only");
  const plc = (await connection.call("findStations", { kind: "plc", land: "SH" })).structuredContent ?? {};
  assert.equal(plc["source"], `${BASE}/V_PLC_STATION`);
  assert.equal(plc["total"], 3);
  const wrong = await connection.call("findStations", { kind: "project", land: "MV" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]?.text ?? "", /land and monitoring apply to HELCOM PLC stations/);
  await connection.close();
});

test("findParameters: mercury in every compartment whose list names it, the English-name hint, PLC parameters", async () => {
  const connection = await connect({ transport: mudab() });
  const mercury = (await connection.call("findParameters", { name: "HG" })).structuredContent ?? {};
  assert.deepEqual((mercury["parameters"] as { code: string; compartments: string[] }[])[0], { code: "HG", name: "mercury", group: "Metals and metalloids", groupCode: "I-MET", compartments: ["CF", "CS", "CW"] });
  assert.match((mercury["notes"] as string[]).join(" "), /values of the substances listed here are not served/);
  const german = (await connection.call("findParameters", { name: "Quecksilber" })).structuredContent ?? {};
  assert.equal(german["status"], "empty");
  assert.match(String(german["reason"]), /Names are English/);
  const sediment = (await connection.call("findParameters", { compartment: "sediment" })).structuredContent ?? {};
  assert.equal(sediment["source"], `${BASE}/MV_PARAMETER_SEDIMENT`);
  const plc = (await connection.call("findParameters", { plc: true })).structuredContent ?? {};
  assert.equal(plc["source"], `${BASE}/V_GEMESSENE_PARA_PLC`);
  assert.deepEqual((plc["parameters"] as { code: string }[]).map((p) => p.code), ["Hg", "Ntot"]);
  await connection.close();
});

test("getMeasurements: a station's series per unit and its values newest first; parts of names and words ambiguous", async () => {
  const upstream = mudab();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("getMeasurements", { station: "OMMVZBA15", limit: 2 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["station"], "OMMVZBA15");
  assert.deepEqual((content["series"] as { parameter: string; unit: string }[]).map((s) => `${s.parameter} ${s.unit}`), ["SurTemp degC", "WAVHT m", "WAVHT sc"]);
  assert.deepEqual((content["values"] as { date: string }[]).map((v) => v.date), ["2013-06-04", "2013-04-29"]);
  assert.equal(content["nextOffset"], 2);
  assert.equal(content["source"], `${BASE}/MV_STATION_MSMNT`);
  const part = (await connection.call("getMeasurements", { station: "OMMVZB" })).structuredContent ?? {};
  assert.equal(part["status"], "ambiguous");
  assert.deepEqual(part["candidates"], ["OMMVZBA15", "OMMVZBA15_CW"]);
  const temperature = (await connection.call("getMeasurements", { parameter: "Temperatur" })).structuredContent ?? {};
  assert.equal(temperature["status"], "ambiguous");
  const secchi = (await connection.call("getMeasurements", { parameter: "Sichttiefe" })).structuredContent ?? {};
  assert.equal(secchi["status"], "empty", "no SECCI in the sample");
  assert.equal(upstream.log.of("MV_STATION_MSMNT"), 1, "the table is read once and kept");
  await connection.close();
});

test("getRiverLoads: rivers ranked, unmonitored areas only when asked, totals per kind, the incomplete year said", async () => {
  const connection = await connect({ transport: mudab() });
  const content = (await connection.call("getRiverLoads", { parameter: "nitrogen", year: 2024, limit: 2 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual((content["rows"] as { river: string; value: number; unit: string }[]).map((r) => [r.river, r.value, r.unit]), [["PEENE", 2796.507925, "t/a"], ["WARNOW", 1656.518409, "t/a"]]);
  assert.equal(content["total"], 3);
  assert.equal(content["nextOffset"], 2);
  assert.match((content["notes"] as string[]).join(" "), /no value \(null\)/);
  assert.doesNotMatch((content["notes"] as string[]).join(" "), /2025 looks incomplete/, "the answer has no 2025 row");
  const latest = (await connection.call("getRiverLoads", { parameter: "nitrogen", limit: 1 })).structuredContent ?? {};
  assert.match((latest["notes"] as string[]).join(" "), /2025 looks incomplete/);
  assert.equal(content["source"], `${BASE}/V_MESSWERTE_PLC`);
  const byKind = (await connection.call("getRiverLoads", { parameter: "Ntot", year: 2024, kind: "all", by: "kind" })).structuredContent ?? {};
  assert.deepEqual((byKind["totals"] as { group: string }[]).map((t) => t.group), ["monitored river load", "unmonitored area (pseudo-station)", "municipal treatment plant"]);
  const ambiguous = (await connection.call("getRiverLoads", { parameter: "phosph" })).structuredContent ?? {};
  assert.equal(ambiguous["status"], "ambiguous");
  const noTotal = await connection.call("getRiverLoads", { by: "year" });
  assert.equal(noTotal.isError, true);
  assert.match(noTotal.content[0]?.text ?? "", /totals need a parameter/);
  await connection.close();
});

test("listRows: a raw page, rows by a field's value, and an unknown field naming the columns", async () => {
  const connection = await connect({ transport: mudab() });
  const page = (await connection.call("listRows", { table: "plcStations", limit: 2 })).structuredContent ?? {};
  assert.deepEqual((page["rows"] as { STATION_CODE: string }[]).map((r) => r.STATION_CODE), ["CDE0007", "CDE0017"]);
  assert.equal(page["nextOffset"], 2);
  assert.equal(page["source"], `${BASE}/V_PLC_STATION`);
  const warnow = (await connection.call("listRows", { table: "plcMeasurements", field: "SUBCM_NAME", value: "warnow" })).structuredContent ?? {};
  assert.equal(warnow["total"], 2);
  const water = (await connection.call("listRows", { table: "parameters", compartment: "wasser", limit: 1 })).structuredContent ?? {};
  assert.equal(water["source"], `${BASE}/MV_PARAMETER_WASSER`);
  const unknown = await connection.call("listRows", { table: "stations", field: "STATION", value: "x" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0]?.text ?? "", /its columns are metadataid, STATNAME_ST, NAME_PS, STATIONTYPE_ST, COMPT_DS/);
  await connection.close();
});
