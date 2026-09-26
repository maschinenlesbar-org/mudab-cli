import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { MudabClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, jsonBodyOf, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new MudabClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("stations renders the rows and defaults range.count to 100", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname.endsWith("/STATION_SMALL"), true);
  assert.deepEqual(jsonBodyOf(cli.mt.last()), { range: { from: 0, count: 100 } });
  assert.equal(JSON.parse(cli.out.join("\n")).length, 2);
});

test("--count and --from set the range window", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  await run(["stations", "--from", "20", "--count", "5"], cli.deps);
  assert.deepEqual(jsonBodyOf(cli.mt.last()), { range: { from: 20, count: 5 } });
});

test("--all omits the range entirely", async () => {
  const cli = makeCli(() => jsonResponse(fx.parameters));
  await run(["parameters", "--all"], cli.deps);
  assert.deepEqual(jsonBodyOf(cli.mt.last()), {});
});

test("--all combined with --count is a usage error and issues no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.parameters));
  const code = await run(["parameters", "--all", "--count", "5"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("parameters --compartment routes to the compartment endpoint", async () => {
  const cli = makeCli(() => jsonResponse(fx.parametersWasser));
  await run(["parameters", "--compartment", "wasser"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname.endsWith("/MV_PARAMETER_WASSER"), true);
});

test("an invalid --compartment is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.parameters));
  const code = await run(["parameters", "--compartment", "bogus"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("plc-measurements POSTs to /V_MESSWERTE_PLC", async () => {
  const cli = makeCli(() => jsonResponse({ V_MESSWERTE_PLC: [] }));
  await run(["plc-measurements", "--count", "3"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname.endsWith("/V_MESSWERTE_PLC"), true);
});

test("compartments works offline, needs no request, and lists the codes", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["compartments"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  const table = JSON.parse(cli.out.join("\n")) as { code: string }[];
  assert.deepEqual(
    table.map((c) => c.code).sort(),
    ["BL", "CF", "CS", "CW"],
  );
});

test("an empty --base-url is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["--base-url", "", "stations"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
  test(`a non-http(s) --base-url (${bad}) is a usage error before any request`, async () => {
    const cli = makeCli(() => jsonResponse(fx.stations));
    const code = await run(["--base-url", bad, "stations"], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(code, 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /--base-url/);
  });
}

test("a control character in --user-agent is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--timeout", "2147483647", "stations"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--timeout", "2147483648", "stations"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: mudab/);
});

test("--max-retries above the sane maximum is rejected client-side", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["--max-retries", "1000000", "stations"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a redirect from a misconfigured base URL exits 2 (usage)", async () => {
  const cli = makeCli(() => ({
    status: 301,
    headers: { location: "https://www.mudab.de/x" },
    body: Buffer.alloc(0),
  }));
  const code = await run(["stations", "--count", "1"], cli.deps);
  assert.equal(code, 2);
  assert.match(cli.err.join("\n"), /canonical base URL/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const row = { ...fx.stations.V_STATION_SMALL[0], NAME_PS: `OMO${controls}`, COMPT_DS: String.fromCharCode(0x1b) + "[31m" };
  const served = { V_STATION_SMALL: [row] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "stations"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /OMO\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served.V_STATION_SMALL);
  }
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  await run(["--compact", "stations"], cli.deps);
  assert.equal(cli.out.length, 1);
  assert.equal(cli.out[0], JSON.stringify(fx.stations.V_STATION_SMALL));
});

test("--from/--count are bounded to 2^31 - 1, and so is their sum", async () => {
  for (const [args, message] of [
    [["--from", "2147483648"], /Must be <= 2147483647\./],
    [["--count", "999999999999"], /Must be <= 2147483647\./],
    [["--count", "99999999999999999999"], /Must be <= 2147483647\./],
    [["--from", "2147483647", "--count", "1"], /--from \+ --count \(default 100\) must not exceed 2147483647.*HTTP 403.*--all/],
    [["--from", "2147483600"], /must not exceed 2147483647/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.stations));
    assert.equal(await run(["stations", ...args], cli.deps), 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0, args.join(" "));
    assert.match(cli.err.join("\n"), message, args.join(" "));
  }
  const ok = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["stations", "--from", "2147483646", "--count", "1"], ok.deps), 0);
  assert.deepEqual(jsonBodyOf(ok.mt.last()), { range: { from: 2147483646, count: 1 } });
});

test("a 200 error object exits 1 with a shape error instead of printing []", async () => {
  const cli = makeCli(() => rawResponse('{"message":"ORA-00942: table or view does not exist"}', "application/json"));
  assert.equal(await run(["stations", "--compact"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /^Error: Unexpected response shape from \/STATION_SMALL: .*ORA-00942/);
});

for (const [bad, message] of [
  ["http://127.0.0.1:1/echo?x=1", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
  ["http://127.0.0.1:1/echo#frag", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
  [" http://127.0.0.1:1/echo", /A base URL cannot have surrounding whitespace\./],
  ["http://127.0.0.1:1/echo ", /A base URL cannot have surrounding whitespace\./],
] as const) {
  test(`--base-url ${JSON.stringify(bad)} is a usage error before any request`, async () => {
    const cli = makeCli(() => jsonResponse(fx.stations));
    assert.equal(await run(["--base-url", bad, "stations"], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("a --base-url with a path prefix still works", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--base-url", "http://127.0.0.1:1/mirror/mudab/", "stations"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "http://127.0.0.1:1/mirror/mudab/STATION_SMALL");
});

test("--user-agent: blank or non-Latin-1 is a usage error; tab and Latin-1 pass", async () => {
  for (const [ua, message] of [
    ["", /Expected a non-empty value\./],
    [" ", /Expected a non-empty value\./],
    ["mudab \u20ac", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.stations));
    assert.equal(await run(["--user-agent", ua, "stations"], cli.deps), 2, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  const ok = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--user-agent", "m\u00fcdab\t1", "stations"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "m\u00fcdab\t1");
});
