import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { MudabError, MudabValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { MudabClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import { jsonResponse, parity } from "./helpers.js";
import * as fx from "./fixtures.js";

const nonEmpty: Problem = (value) => (value.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("name", "x", nonEmpty), "x");
});

test("assertValid throws MudabValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("compartment", " ", nonEmpty),
    (err: unknown) =>
      err instanceof MudabValidationError &&
      err instanceof MudabError &&
      err.name === "MudabValidationError" &&
      err.message === "Invalid compartment: Expected a non-empty value.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (value: string): Promise<string> => assertValid("q", value, nonEmpty);
  const pending = method("");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, MudabValidationError);
});

test("the library root exports the validation layer", () => {
  assert.equal(library.MudabValidationError, MudabValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("run() maps a MudabValidationError raised in an action to exit 2 with 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  let calls = 0;
  const code = await run(["stations"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () =>
      ({
        stations: async () => {
          calls += 1;
          return assertValid("thing", "", nonEmpty);
        },
      }) as unknown as MudabClient,
  });
  assert.equal(code, 2);
  assert.equal(calls, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
});

test("parity() runs one input through run() and the library on recording transports", async () => {
  const { cli, lib } = await parity(
    ["--compact", "stations", "--from", "0", "--count", "2"],
    (transport) => new MudabClient({ transport }).stations({ range: { from: 0, count: 2 } }),
    () => jsonResponse(fx.stations),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, JSON.stringify(fx.stations.V_STATION_SMALL));
  assert.deepEqual(lib, { ok: true, value: fx.stations.V_STATION_SMALL, requests: lib.requests });
  assert.deepEqual(
    cli.requests.map((r) => [r.url, r.body?.toString()]),
    lib.requests.map((r) => [r.url, r.body?.toString()]),
  );

  const failing = await parity(["--compact", "stations", "--all"], () => {
    throw new MudabValidationError("Invalid x: y");
  });
  assert.deepEqual(failing.lib, {
    ok: false,
    error: { name: "MudabValidationError", message: "Invalid x: y" },
    requests: [],
  });
});
