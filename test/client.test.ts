import { test } from "node:test";
import assert from "node:assert/strict";
import { MudabClient, extractRows, normalizeRange, DEFAULT_PAGE_SIZE, MAX_RANGE_END } from "../src/client/client.js";
import { MudabNetworkError, MudabParseError, MudabValidationError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, jsonBodyOf, rawResponse } from "./helpers.js";
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

test("extractRows takes the one wrapped array, whatever the key, or a bare array", () => {
  assert.deepEqual(extractRows({ ANY_KEY: [1, 2] }), [1, 2]);
  assert.deepEqual(extractRows({ V_STATION_SMALL: [] }), []);
  assert.deepEqual(extractRows([3, 4]), [3, 4]);
});

test("a 200 reply of any other shape is a MudabParseError naming what came back", async () => {
  const cases: [string, RegExp][] = [
    ['{"message":"ORA-00942: table or view does not exist"}', /got an object with the key "message" \(message: "ORA-00942: table or view does not exist"\)\.$/],
    ['{"error":"Datenbankfehler","rows":[]}', /got an object with the keys "error", "rows" \(error: "Datenbankfehler"\)\.$/],
    ['{"meta":["x"],"V_STATION_SMALL":[{"a":1}]}', /got an object with the keys "meta", "V_STATION_SMALL"\.$/],
    ['{"__proto__":[{"x":1}],"R":[{"a":1}]}', /got an object with the keys "__proto__", "R"\.$/],
    ['{"V_STATION_SMALL":null}', /got an object with the key "V_STATION_SMALL"\.$/],
    ["{}", /got an empty object\.$/],
    ["null", /got null\.$/],
    ['"hello"', /got a string\.$/],
    ["42", /got a number\.$/],
  ];
  for (const [body, message] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, "application/json"));
    const client = new MudabClient({ transport: mt.transport });
    await assert.rejects(
      () => client.stations(),
      (err) =>
        err instanceof MudabParseError &&
        err.message.startsWith(
          "Unexpected response shape from /STATION_SMALL: expected a JSON object wrapping one row array, got ",
        ) &&
        message.test(err.message),
      body,
    );
  }
});

test("an empty 200 body is a MudabParseError, not an empty result", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json"));
  const client = new MudabClient({ transport: mt.transport });
  await assert.rejects(() => client.stations(), MudabParseError);
});

test("the client rejects a file: base URL before a custom transport sees it", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stations));
  assert.throws(
    () => new MudabClient({ baseUrl: "file:///etc/passwd", transport: mt.transport }),
    (err) => err instanceof MudabValidationError && !(err instanceof MudabNetworkError),
  );
  assert.equal(mt.calls.length, 0);
});

test("the client checks the range before sending it", async () => {
  const cases: [unknown, RegExp][] = [
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
  // The largest accepted end goes out as given; a from-only range gets the default count.
  const { client, mt } = clientFor(fx.stations);
  await client.stations({ range: { from: 2147483646, count: 1 } });
  await client.stations({ range: { from: 5 } });
  assert.deepEqual(jsonBodyOf(mt.calls[0]!), { range: { from: 2147483646, count: 1 } });
  assert.deepEqual(jsonBodyOf(mt.calls[1]!), { range: { from: 5, count: DEFAULT_PAGE_SIZE } });
});

test("normalizeRange completes a range to the default page and leaves { all: true } without one", () => {
  assert.equal(DEFAULT_PAGE_SIZE, 100);
  assert.deepEqual(normalizeRange(), { range: { from: 0, count: 100 } });
  assert.deepEqual(normalizeRange({}), { range: { from: 0, count: 100 } });
  assert.deepEqual(normalizeRange({ range: {} }), { range: { from: 0, count: 100 } });
  assert.deepEqual(normalizeRange({ range: { from: 7 } }), { range: { from: 7, count: 100 } });
  assert.deepEqual(normalizeRange({ range: { from: 7, count: 3 } }), { range: { from: 7, count: 3 } });
  assert.deepEqual(normalizeRange({ range: { count: 3 } }), { range: { from: 0, count: 3 } });
  assert.deepEqual(normalizeRange({ all: false }), { range: { from: 0, count: 100 } });
  assert.deepEqual(normalizeRange({ all: true }), {});
  assert.deepEqual(normalizeRange({ all: true, orderby: { col: "X" } }), { orderby: { col: "X" } });
  const once = normalizeRange({ range: { from: 2 } });
  assert.deepEqual(normalizeRange(once), once);
  assert.throws(() => normalizeRange({ all: true, range: { from: 0 } }), MudabValidationError);
  assert.throws(() => normalizeRange({ all: 1 } as never), { message: /^Invalid all: expected a boolean, got 1\.$/ });
  assert.throws(
    () => normalizeRange({ range: { from: MAX_RANGE_END - 99 } }),
    { message: /^Invalid range: from \+ count \(count defaults to 100\) must not exceed 2147483647 .*got 2147483648\.$/ },
  );
  assert.deepEqual(normalizeRange({ range: { from: MAX_RANGE_END - 100 } }), {
    range: { from: MAX_RANGE_END - 100, count: 100 },
  });
});

test("parameters() rejects an unknown compartment with a MudabValidationError, no request", async () => {
  for (const bad of ["WASSER", "toString", "__proto__", "constructor", "", 5]) {
    const { client, mt } = clientFor(fx.parameters);
    await assert.rejects(
      () => client.parameters({}, bad as never),
      (err) =>
        err instanceof MudabValidationError &&
        err.message ===
          `Invalid compartment: expected one of biologie, biota, wasser, sediment, got ${typeof bad === "string" ? JSON.stringify(bad) : String(bad)}.`,
      String(bad),
    );
    assert.equal(mt.calls.length, 0);
  }
});
