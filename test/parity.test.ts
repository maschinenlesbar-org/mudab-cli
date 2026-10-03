// CLI <-> library parity: the same input through run() and through the matching
// library call, on one recording mock transport, must give the same outcome —
// both reject with no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MudabClient } from "../src/client/client.js";
import type { ListRequest } from "../src/client/types.js";
import { jsonResponse, parity, requestShapes, type CliOutcome, type LibOutcome } from "./helpers.js";
import * as fx from "./fixtures.js";

type Call = (c: MudabClient) => Promise<unknown>;

/** Assert that the CLI and the library sent the same requests and both succeeded. */
function assertSameRequests(argv: string[], cli: CliOutcome, lib: LibOutcome): void {
  assert.equal(cli.code, 0, argv.join(" "));
  assert.ok(lib.ok, argv.join(" "));
  assert.deepEqual(requestShapes(lib.requests), requestShapes(cli.requests), argv.join(" "));
}

// ---- #1 (PAT-15): the default page (from 0, count 100) is the library's ----

test("parity: a list call without a full range sends the same default page from the CLI and the library", async () => {
  const cases: [string[], Call][] = [
    [["--compact", "stations"], (c) => c.stations()],
    [["--compact", "stations", "--from", "5"], (c) => c.stations({ range: { from: 5 } })],
    [["--compact", "project-stations"], (c) => c.projectStations({})],
    [["--compact", "measurements"], (c) => c.measurements()],
    [["--compact", "plc-stations"], (c) => c.plcStations()],
    [["--compact", "plc-parameters"], (c) => c.plcParameters()],
    [["--compact", "plc-measurements", "--from", "3"], (c) => c.plcMeasurements({ range: { from: 3 } })],
    [["--compact", "parameters"], (c) => c.parameters()],
    [["--compact", "parameters", "--compartment", "wasser"], (c) => c.parameters(undefined, "wasser")],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib } = await parity(argv, (transport) => call(new MudabClient({ transport })), () =>
      jsonResponse(fx.stations),
    );
    assertSameRequests(argv, cli, lib);
    const body = JSON.parse(lib.requests[0]!.body!.toString()) as { range?: { count?: number } };
    assert.equal(body.range?.count, 100, argv.join(" "));
  }
});

test("parity: --all and { all: true } both send no range", async () => {
  const cases: [string[], Call][] = [
    [["--compact", "stations", "--all"], (c) => c.stations({ all: true })],
    [["--compact", "parameters", "--all", "--compartment", "biota"], (c) => c.parameters({ all: true }, "biota")],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib } = await parity(argv, (transport) => call(new MudabClient({ transport })), () =>
      jsonResponse(fx.stations),
    );
    assertSameRequests(argv, cli, lib);
    assert.equal(lib.requests[0]!.body!.toString(), "{}");
  }
});

test("parity: a from whose default page ends past 2^31 - 1 is rejected by both, with no request", async () => {
  const { cli, lib } = await parity(["stations", "--from", "2147483600"], (transport) =>
    new MudabClient({ transport }).stations({ range: { from: 2147483600 } }),
  );
  assert.equal(cli.code, 2);
  assert.equal(cli.requests.length, 0);
  assert.equal(lib.ok, false);
  assert.equal(lib.error?.name, "MudabValidationError");
  assert.equal(lib.requests.length, 0);
  assert.equal(cli.err.split("\n")[0], `Error: ${lib.error?.message}`);
});

test("the library rejects { all: true } together with a range, and a non-boolean all", async () => {
  for (const req of [{ all: true, range: { from: 0, count: 1 } }, { all: "yes" }] as unknown as ListRequest[]) {
    const { lib } = await parity(["stations", "--all"], (transport) => new MudabClient({ transport }).stations(req));
    assert.equal(lib.ok, false, JSON.stringify(req));
    assert.equal(lib.error?.name, "MudabValidationError", JSON.stringify(req));
    assert.equal(lib.requests.length, 0, JSON.stringify(req));
  }
});
