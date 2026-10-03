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

// ---- #3 (PAT-5): the User-Agent rule is the library's ----

test("parity: a bad userAgent is rejected by the CLI and the library alike, with no request", async () => {
  for (const ua of ["", "  ", "bad\r\nX-Injected: 1", "a\u0000b", "a\u007fb", "mādab", "€"]) {
    const { cli, lib } = await parity(["--compact", "--user-agent", ua, "stations"], (transport) =>
      new MudabClient({ transport, userAgent: ua }).stations(),
    );
    assert.equal(cli.code, 2, JSON.stringify(ua));
    assert.equal(cli.requests.length, 0, JSON.stringify(ua));
    assert.equal(lib.ok, false, JSON.stringify(ua));
    assert.equal(lib.error?.name, "MudabValidationError", JSON.stringify(ua));
    assert.equal(lib.requests.length, 0, JSON.stringify(ua));
    // Same reason on both sides: the CLI's usage error ends with the library's reason.
    const reason = lib.error!.message.replace(/^Invalid userAgent: /, "");
    assert.match(cli.err, new RegExp(`is invalid\\. ${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), JSON.stringify(ua));
  }
});

test("parity: tab and Latin-1 in userAgent pass on both sides", async () => {
  const ua = "müdab\t1";
  const { cli, lib } = await parity(["--compact", "--user-agent", ua, "stations"], (transport) =>
    new MudabClient({ transport, userAgent: ua }).stations(),
    () => jsonResponse(fx.stations),
  );
  assertSameRequests(["--user-agent", ua], cli, lib);
  assert.equal(lib.requests[0]!.headers?.["User-Agent"], ua);
});

// ---- #4 (PAT-1): surrounding whitespace in the base URL is the library's rule ----

test("parity: a base URL with surrounding whitespace or a control character is rejected by both, with no request", async () => {
  for (const baseUrl of [" https://h.example/x ", "https://h.example/api ", " https://h.example/api", "https://h.example/x\n", "https://h.example/a\tb"]) {
    const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "stations"], (transport) =>
      new MudabClient({ transport, baseUrl }).stations(),
    );
    assert.equal(cli.code, 2, JSON.stringify(baseUrl));
    assert.equal(cli.requests.length, 0, JSON.stringify(baseUrl));
    assert.equal(lib.ok, false, JSON.stringify(baseUrl));
    assert.equal(lib.error?.name, "MudabValidationError", JSON.stringify(baseUrl));
    assert.equal(lib.requests.length, 0, JSON.stringify(baseUrl));
    const reason = lib.error!.message.replace(/^Invalid baseUrl: /, "");
    assert.ok(cli.err.includes(`is invalid. ${reason}`), `${JSON.stringify(baseUrl)}: ${cli.err}`);
  }
});

test("parity: a clean base URL with a path prefix and a trailing slash works on both sides", async () => {
  const baseUrl = "https://h.example/mirror/";
  const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "stations"], (transport) =>
    new MudabClient({ transport, baseUrl }).stations(),
    () => jsonResponse(fx.stations),
  );
  assertSameRequests(["--base-url", baseUrl], cli, lib);
  assert.equal(lib.requests[0]!.url, "https://h.example/mirror/STATION_SMALL");
});

// ---- #2 (PAT-16): a count-only range gets from 0 in the library ----

test("parity: a count without a from sends from 0 from the CLI and the library", async () => {
  const cases: [string[], Call][] = [
    [["--compact", "stations", "--count", "5"], (c) => c.stations({ range: { count: 5 } })],
    [["--compact", "measurements", "--count", "2147483647"], (c) => c.measurements({ range: { count: 2147483647 } })],
    [["--compact", "parameters", "--compartment", "wasser", "--count", "1"], (c) => c.parameters({ range: { count: 1 } }, "wasser")],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib } = await parity(argv, (transport) => call(new MudabClient({ transport })), () =>
      jsonResponse(fx.stations),
    );
    assertSameRequests(argv, cli, lib);
    const body = JSON.parse(lib.requests[0]!.body!.toString()) as { range?: { from?: number } };
    assert.equal(body.range?.from, 0, argv.join(" "));
  }
});
