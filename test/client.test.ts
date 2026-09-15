import { test } from "node:test";
import assert from "node:assert/strict";
import { MudabClient, extractRows } from "../src/client/client.js";
import { makeMockTransport, jsonResponse, jsonBodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function clientFor(body: unknown) {
  const mt = makeMockTransport(() => jsonResponse(body));
  return { client: new MudabClient({ transport: mt.transport }), mt };
}

test("stations() POSTs to /STATION_SMALL and extracts the V_STATION_SMALL rows", async () => {
  const { client, mt } = clientFor(fx.stations);
  const rows = await client.stations({ range: { count: 2 } });
  assert.equal(new URL(mt.last().url).pathname.endsWith("/STATION_SMALL"), true);
  assert.equal(mt.last().method, "POST");
  assert.deepEqual(jsonBodyOf(mt.last()), { range: { count: 2 } });
  // The wrapper key (V_STATION_SMALL) is NOT the path name — extraction still works.
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.STATNAME_ST, "TF0360");
});

test("projectStations() extracts the V_MUDAB_PROJECTSTATION rows", async () => {
  const { client, mt } = clientFor(fx.projectStations);
  const rows = await client.projectStations();
  assert.equal(new URL(mt.last().url).pathname.endsWith("/PROJECTSTATION_SMALL"), true);
  assert.equal(rows[0]?.INSTITUT, "BSH");
});

test("parameters() POSTs to /MV_PARAMETER by default", async () => {
  const { client, mt } = clientFor(fx.parameters);
  const rows = await client.parameters();
  assert.equal(new URL(mt.last().url).pathname.endsWith("/MV_PARAMETER"), true);
  assert.equal(rows[0]?.PARAMETER, "24DP");
});

test("parameters(_, 'wasser') routes to the compartment endpoint", async () => {
  const { client, mt } = clientFor(fx.parametersWasser);
  await client.parameters({}, "wasser");
  assert.equal(new URL(mt.last().url).pathname.endsWith("/MV_PARAMETER_WASSER"), true);
});

test("measurements() POSTs to /MV_STATION_MSMNT and keeps VALUE_MS a number", async () => {
  const { client, mt } = clientFor(fx.measurements);
  const rows = await client.measurements({ range: { from: 0, count: 1 } });
  assert.equal(new URL(mt.last().url).pathname.endsWith("/MV_STATION_MSMNT"), true);
  const value: number | undefined = rows[0]?.VALUE_MS;
  assert.equal(value, 11.8);
  assert.equal(typeof value, "number");
});

test("plcStations() POSTs to /V_PLC_STATION", async () => {
  const { client, mt } = clientFor(fx.plcStations);
  const rows = await client.plcStations();
  assert.equal(new URL(mt.last().url).pathname.endsWith("/V_PLC_STATION"), true);
  assert.equal(rows[0]?.STATION_NAME, "KÖRKWITZ");
});

test("an empty result yields an empty array", async () => {
  const { client } = clientFor(fx.empty);
  assert.deepEqual(await client.stations(), []);
});

test("extractRows takes the first array-valued property, whatever the key", () => {
  assert.deepEqual(extractRows({ ANY_KEY: [1, 2] }), [1, 2]);
  assert.deepEqual(extractRows([3, 4]), [3, 4]);
  assert.deepEqual(extractRows({}), []);
  assert.deepEqual(extractRows(null), []);
  assert.deepEqual(extractRows({ Status: "ok", ROWS: [{ a: 1 }] }), [{ a: 1 }]);
});
