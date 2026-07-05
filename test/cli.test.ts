import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { MudabClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, jsonBodyOf } from "./helpers.js";
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

test("a control character in --user-agent is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: mudab/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  await run(["--compact", "stations"], cli.deps);
  assert.equal(cli.out.length, 1);
  assert.equal(cli.out[0], JSON.stringify(fx.stations.V_STATION_SMALL));
});
