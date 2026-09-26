import { test } from "node:test";
import assert from "node:assert/strict";
import { MudabClient, extractRows } from "../src/client/client.js";
import { MudabNetworkError, MudabValidationError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, jsonBodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function clientFor(body: unknown) {
  const mt = makeMockTransport(() => jsonResponse(body));
  return { client: new MudabClient({ transport: mt.transport }), mt };
}

test("stations() POSTs to /STATION_SMALL and extracts the V_STATION_SMALL rows", async () => {
  const { client, mt } = clientFor(fx.stations);
  const rows = await client.stations({ range: { from: 0, count: 2 } });
  assert.equal(new URL(mt.last().url).pathname.endsWith("/STATION_SMALL"), true);
  assert.equal(mt.last().method, "POST");
  assert.deepEqual(jsonBodyOf(mt.last()), { range: { from: 0, count: 2 } });
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

test("the client rejects a file: base URL before a custom transport sees it", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stations));
  assert.throws(
    () => new MudabClient({ baseUrl: "file:///etc/passwd", transport: mt.transport }),
    MudabNetworkError,
  );
  assert.equal(mt.calls.length, 0);
});

test("the client checks the range before sending it", async () => {
  const cases: [unknown, RegExp][] = [
    [{ count: 10 }, /a count needs a from \(the server answers a count-only range with HTTP 500\)/],
    [{ from: -5, count: 1 }, /^Invalid range\.from: expected an integer from 0 to 2147483647, got -5\.$/],
    [{ from: 0, count: 1.5 }, /^Invalid range\.count: expected an integer from 0 to 2147483647, got 1\.5\.$/],
    [{ from: 0, count: 2147483648 }, /^Invalid range\.count: .*got 2147483648\.$/],
    [{ from: "0", count: 1 }, /^Invalid range\.from: .*got "0"\.$/],
    [{ from: 2147483647, count: 1 }, /from \+ count must not exceed 2147483647 .*HTTP 403.*got 2147483648\.$/],
    [null, /^Invalid range: expected an object with from and count, got null\.$/],
  ];
  for (const [range, message] of cases) {
    const { client, mt } = clientFor(fx.stations);
    await assert.rejects(
      () => client.stations({ range } as never),
      (err) => err instanceof MudabValidationError && message.test(err.message),
      JSON.stringify(range),
    );
    assert.equal(mt.calls.length, 0, JSON.stringify(range));
  }
  // The largest accepted end, and a from-only range, still go out as given.
  const { client, mt } = clientFor(fx.stations);
  await client.stations({ range: { from: 2147483646, count: 1 } });
  await client.stations({ range: { from: 5 } });
  assert.deepEqual(jsonBodyOf(mt.calls[0]!), { range: { from: 2147483646, count: 1 } });
  assert.deepEqual(jsonBodyOf(mt.calls[1]!), { range: { from: 5 } });
});
