import { test } from "node:test";
import assert from "node:assert/strict";
import { MudabClient, extractRows, normalizeRange, DEFAULT_PAGE_SIZE, MAX_RANGE_END } from "../src/client/client.js";
import { MudabApiError, MudabNetworkError, MudabParseError, MudabValidationError } from "../src/client/errors.js";
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
  assert.deepEqual(await client.parameters(), []);
});

test("extractRows takes the one wrapped array of objects, or a bare array of objects", () => {
  assert.deepEqual(extractRows({ ANY_KEY: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(extractRows({ V_STATION_SMALL: [] }), []);
  assert.deepEqual(extractRows({ V_STATION_SMALL: [{ a: 1 }] }, "/STATION_SMALL"), [{ a: 1 }]);
  assert.deepEqual(extractRows([{ b: 2 }]), [{ b: 2 }]);
});

test("extractRows accepts only the resource's own wrapper key, and only object rows", () => {
  assert.throws(
    () => extractRows({ V_MESSWERTE_PLC: [{ NAME: "Ntot" }] }, "/MV_STATION_MSMNT"),
    (err) =>
      err instanceof MudabParseError &&
      err.message ===
        'Unexpected response shape from /MV_STATION_MSMNT: expected a JSON object wrapping one row array under ' +
          '"MV_STATION_MSMNT", got an object with the key "V_MESSWERTE_PLC".',
  );
  for (const [rows, what] of [
    [[null, null], "null as row 0"],
    [[{ a: 1 }, null, "x"], "null as row 1"],
    [["Datenbankfehler"], "a string as row 0"],
    [[[1, 2]], "an array as row 0"],
    [[5], "a number as row 0"],
  ] as const) {
    assert.throws(
      () => extractRows({ V_STATION_SMALL: rows }, "/STATION_SMALL"),
      (err) => err instanceof MudabParseError && err.message.endsWith(`of objects, got ${what}.`),
      JSON.stringify(rows),
    );
  }
});

test("a 200 error envelope is a MudabApiError with the server's messages, never rows", async () => {
  const cases: [unknown, string][] = [
    [
      { errors: [{ code: "ORA-00942", message: "table or view does not exist" }] },
      "ORA-00942: table or view does not exist",
    ],
    [{ error: ["Datenbankfehler: ORA-12541 TNS:no listener"] }, "Datenbankfehler: ORA-12541 TNS:no listener"],
    [{ errors: [{ message: "ORA-01555: snapshot too old" }, "second"] }, "ORA-01555: snapshot too old; second"],
    [{ error: "Datenbankfehler", rows: [] }, "Datenbankfehler"],
    [{ errors: [] }, "no message"],
  ];
  for (const [body, detail] of cases) {
    const { client } = clientFor(body);
    await assert.rejects(
      () => client.measurements({ all: true }),
      (err) =>
        err instanceof MudabApiError &&
        err.status === 200 &&
        err.detail === `the server answered with an error instead of rows: ${detail}` &&
        err.message.startsWith("HTTP 200 for POST ") &&
        err.message.includes("/MV_STATION_MSMNT: the server answered with an error instead of rows"),
      JSON.stringify(body),
    );
  }
});

test("a 200 reply of any other shape is a MudabParseError naming what came back", async () => {
  const cases: [string, RegExp][] = [
    ['{"message":"ORA-00942: table or view does not exist"}', /got an object with the key "message" \(message: "ORA-00942: table or view does not exist"\)\.$/],
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
          'Unexpected response shape from /STATION_SMALL: expected a JSON object wrapping one row array under "V_STATION_SMALL", got ',
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
  const { client, mt } = clientFor({ V_STATION_SMALL: [] });
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

test("null as the request means no request: the default page, like undefined", async () => {
  const { client, mt } = clientFor(fx.stations);
  await client.stations(null as unknown as undefined);
  assert.deepEqual(jsonBodyOf(mt.last()), { range: { from: 0, count: DEFAULT_PAGE_SIZE } });
  const p = clientFor(fx.parametersWasser);
  await p.client.parameters(null as unknown as undefined, "wasser");
  assert.deepEqual(jsonBodyOf(p.mt.last()), { range: { from: 0, count: DEFAULT_PAGE_SIZE } });
  assert.deepEqual(normalizeRange(null as unknown as undefined), { range: { from: 0, count: DEFAULT_PAGE_SIZE } });
});

test("a request that is not an object, or has an unknown key, is rejected before any request", async () => {
  const cases: [unknown, RegExp][] = [
    [5, /^Invalid request: expected an object, got a number\.$/],
    ["x", /^Invalid request: expected an object, got a string\.$/],
    [{ count: 5 }, /^Invalid request: unknown key "count"; a request takes filter, range, orderby, all \(from and count go inside range\)\.$/],
    [{ range: { form: 5 } }, /^Invalid range: unknown key "form"; a range takes from and count\.$/],
  ];
  for (const [req, message] of cases) {
    const { client, mt } = clientFor(fx.stations);
    await assert.rejects(
      () => client.stations(req as never),
      (err) => err instanceof MudabValidationError && message.test(err.message),
      JSON.stringify(req),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a reply with more rows than the range asked for is a MudabParseError, not a larger page", async () => {
  const many = { V_STATION_SMALL: Array.from({ length: 7 }, (_, i) => ({ STATNAME_ST: `S${i}` })) };
  const { client } = clientFor(many);
  await assert.rejects(
    () => client.stations({ range: { from: 100, count: 2 } }),
    (err) =>
      err instanceof MudabParseError &&
      err.message.startsWith("Unexpected response from /STATION_SMALL: asked for at most 2 rows (from 100), got 7."),
  );
  // As many rows as asked for, or fewer (the end of the table), are the page.
  assert.equal((await clientFor(many).client.stations({ range: { count: 7 } })).length, 7);
  assert.equal((await clientFor(many).client.stations({ range: { from: 5, count: 50 } })).length, 7);
  // With { all: true } there is no range to check.
  assert.equal((await clientFor(many).client.stations({ all: true })).length, 7);
});
