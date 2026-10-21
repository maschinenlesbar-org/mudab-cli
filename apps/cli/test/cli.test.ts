import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { MudabClient } from "@maschinenlesbar.org/mudab-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import { OutputError, forbidRepeatedOptions, renderJson } from "../src/cli/shared.js";
import { buildProgram } from "../src/cli/program.js";
import { credentialsIn } from "@maschinenlesbar.org/mudab-client/internal/errors";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/mudab-client/internal/http";
import { makeMockTransport, jsonResponse, jsonBodyOf, rawResponse, untimed } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/mudab-client/test/fixtures";

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
  assert.match(untimed(cli.err[0] ?? ""), /^ERROR \[mudab\.cli\] option '--compartment <c>' argument 'bogus' is invalid\. Expected one of biologie, biota, wasser, sediment, got "bogus"\.$/);
});

test("--compartment is a token: trimmed and in NFC it is sent; an invisible character is refused and shown escaped (D8, D10)", async () => {
  const ok = makeCli(() => jsonResponse({ MV_PARAMETER_WASSER: [] }));
  assert.equal(await run(["parameters", "--compartment", " wasser "], ok.deps), 0);
  assert.match(new URL(ok.mt.last().url).pathname, /\/MV_PARAMETER_WASSER$/);
  const bad = makeCli(() => jsonResponse(fx.parameters));
  assert.equal(await run(["parameters", "--compartment", "wasser\u200b"], bad.deps), 2);
  assert.equal(bad.mt.calls.length, 0);
  const err = bad.err.join("\n");
  assert.ok(!err.includes("\u200b"), "the zero-width space is shown raw");
  assert.match(untimed(err), /argument 'wasser\\u200b' is invalid\. "wasser\\u200b" contains an invisible or control character \(U\+200B\)\./);
});

test("plc-measurements POSTs to /V_MESSWERTE_PLC", async () => {
  const cli = makeCli(() => jsonResponse({ V_MESSWERTE_PLC: [] }));
  await run(["plc-measurements", "--count", "3"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname.endsWith("/V_MESSWERTE_PLC"), true);
});

test("compartments sends nothing, so a plain http base URL gets no cleartext warning (B03-1)", async () => {
  for (const baseUrl of ["http://u:pw@mirror.example", "http://mirror.example"]) {
    for (const format of ["text", "jsonl"]) {
      const cli = makeCli(() => jsonResponse({}));
      assert.equal(await run(["--log-format", format, "--base-url", baseUrl, "compartments"], cli.deps), 0);
      assert.equal(cli.mt.calls.length, 0);
      assert.deepEqual(cli.err, [], `${baseUrl} ${format}`);
      assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 4);
    }
  }
  // A command that sends the request still warns.
  const listing = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--base-url", "http://mirror.example", "stations"], listing.deps), 0);
  assert.match(untimed(listing.err[0] ?? ""), /^WARN  \[mudab\.http\] requests to mirror\.example are sent unencrypted/);
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

test("a redirect exits 1, names the target, and hints at the base URL only when one was given", async () => {
  const redirect = () => ({
    status: 301,
    headers: { location: "https://www.mudab.de/x" },
    body: Buffer.alloc(0),
  });
  const own = makeCli(redirect);
  assert.equal(await run(["--base-url", "https://legacy.test/MUDABAnwendung", "stations", "--count", "1"], own.deps), 1);
  assert.deepEqual(own.err.map(untimed), [
    "ERROR [mudab.api] HTTP 301 for POST https://legacy.test/MUDABAnwendung/STATION_SMALL: redirect to https://www.mudab.de/x not followed",
    "INFO  [mudab.api] --base-url redirects; the canonical base URL is https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements (the default).",
  ]);

  const dflt = makeCli(redirect);
  assert.equal(await run(["stations", "--count", "1"], dflt.deps), 1);
  assert.equal(dflt.err.length, 1);
  assert.match(untimed(dflt.err[0]!), /^ERROR \[mudab\.api\] HTTP 301 for POST https:\/\/geoportal\.bafg\.de\/.*redirect to https:\/\/www\.mudab\.de\/x not followed$/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("bidi controls in server data are escaped in the JSON output", async () => {
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const row = { ...fx.stations.V_STATION_SMALL[0], NAME_PS: `OMO\u202eevil`, NOTE: String.fromCharCode(...bidi) };
  const served = { V_STATION_SMALL: [row] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "stations"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.deepEqual([...text].filter((c) => bidi.includes(c.charCodeAt(0))), [], format.join(" "));
    assert.match(text, /OMO\\u202eevil/);
    assert.match(text, /\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069/);
    assert.deepEqual(JSON.parse(text), served.V_STATION_SMALL);
  }
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
    [["--from", "2147483647", "--count", "1"], /^ERROR \[mudab\.cli\] Invalid range: from \+ count must not exceed 2147483647 .*HTTP 403.*got 2147483648\.\nINFO  \[mudab\.cli\] .*--all/],
    [["--from", "2147483600"], /from \+ count \(count defaults to 100\) must not exceed 2147483647/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.stations));
    assert.equal(await run(["stations", ...args], cli.deps), 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0, args.join(" "));
    assert.match(untimed(cli.err.join("\n")), message, args.join(" "));
  }
  const ok = makeCli(() => jsonResponse({ V_STATION_SMALL: [] }));
  assert.equal(await run(["stations", "--from", "2147483646", "--count", "1"], ok.deps), 0);
  assert.deepEqual(jsonBodyOf(ok.mt.last()), { range: { from: 2147483646, count: 1 } });
});

test("a 200 error object exits 1 with a shape error instead of printing []", async () => {
  const cli = makeCli(() => rawResponse('{"message":"ORA-00942: table or view does not exist"}', "application/json"));
  assert.equal(await run(["stations", "--compact"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[mudab\.api\] POST https:\/\/geoportal\.bafg\.de\/mudab\/rest\/BaseController\/FilterElements\/STATION_SMALL: unexpected response shape: .*ORA-00942/);
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const depth = 200_000;
  const body = `{"V_STATION_SMALL":[{"R":${"[".repeat(depth)}${"]".repeat(depth)}}]}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const pretty = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["stations"], pretty.deps), 1);
  assert.deepEqual(pretty.err.map(untimed), [
    `ERROR [mudab.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  ]);
  const compact = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["--compact", "stations"], compact.deps), compactPrints ? 0 : 1);
  if (!compactPrints) assert.deepEqual(compact.err.map(untimed), ["ERROR [mudab.output] The answer is nested too deeply to print."]);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const out: string[] = [];
  const deps: CliDeps = { io: { out: (s) => out.push(s), err: () => {} }, createClient: () => new MudabClient() };
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, [{ STATNAME_ST: "a1", text: huge }]);
  renderJson(deps, { compact: true }, [{ STATNAME_ST: "a1", x: [[["Rede"]]], text: huge.slice(1) }]);
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const deps: CliDeps = { io: { out: () => {}, err: () => {} }, createClient: () => new MudabClient() };
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (gap === 2 || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    err instanceof OutputError &&
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact, or page it with --from\/--count\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; page it with --from\/--count\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print; page it with --from\/--count\.$/.test(err.message));
});

test("holdsHugeString walks a large flat answer without an allocation per value", (t) => {
  // Object.entries made a pair per element: 7 GB and a crash on 48M numbers. Pinned here by the
  // path taken: an array of numbers and plain rows goes the fast path, no entries are made.
  const entries = t.mock.method(Object, "entries");
  const out: string[] = [];
  const deps: CliDeps = { io: { out: (s) => out.push(s), err: () => {} }, createClient: () => new MudabClient() };
  renderJson(deps, { compact: true }, [{ a: 1, b: [2, 3] }, { c: "x" }]);
  assert.equal(entries.mock.callCount(), 0);
  assert.deepEqual(out, ['[{"a":1,"b":[2,3]},{"c":"x"}]']);
});

test("an a:b@c argument (a User-Agent, a typed value) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse({ V_STATION_SMALL: [{ note: "run:2026-10-09@x" }] }));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "stations"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"note": "run:2026-10-09@x"/);
  const typed = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--timeout", "run:2026-10-09@x", "stations"], typed.deps), 2);
  assert.ok(typed.err.some((line) => line.includes("'run:2026-10-09@x'")), typed.err.join("\n"));
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
  // A base URL typed without its scheme is still read as one: its password is never echoed.
  const bare = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--base-url", "alice:hunter2-pw@mirror.example", "stations"], bare.deps), 2);
  assert.ok(!bare.err.join("\n").includes("hunter2-pw"), bare.err.join("\n"));
});

test("help for an unknown command logs an ERROR \"missing command\", then the help one INFO record per line (L5)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["help", "frobnicate"], cli.deps), 2);
  const records = cli.err.map(untimed);
  assert.equal(records[0], "ERROR [mudab.cli] missing command: `mudab <subcommand>`");
  assert.ok(records.length > 3, records.join("\n"));
  for (const record of records.slice(1)) assert.match(record, /^INFO  \[mudab\.cli\] .*\S$/);
  assert.ok(records.some((record) => /\] Usage: mudab /.test(record)), records.join("\n"));
  assert.deepEqual(cli.out, []);
});

test("global options without a command exit 2 with an ERROR \"missing command\"; a bare run prints the help on stdout (L5)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--log-format", "text", "--compact"], cli.deps), 2);
  const records = cli.err.map(untimed);
  assert.equal(records[0], "ERROR [mudab.cli] missing command: `mudab <subcommand>`");
  for (const record of records.slice(1)) assert.match(record, /^INFO  \[mudab\.cli\] .*\S$/);
  const bare = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run([], bare.deps), 0);
  assert.deepEqual(bare.err, []);
  assert.match(bare.out.join("\n"), /^Usage: mudab /);
});

test("the help after a usage error is one INFO record per line; a suggestion is part of the ERROR (L5)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["stations", "--no-such-option"], cli.deps), 2);
  const records = cli.err.map(untimed);
  assert.equal(records[0], "ERROR [mudab.cli] unknown option '--no-such-option'");
  assert.ok(records.length > 3, records.join("\n"));
  for (const record of records.slice(1)) {
    assert.match(record, /^INFO  \[mudab\.cli\] .*\S$/);
    assert.doesNotMatch(record, /\\n/, "one line of the help per record");
  }
  const typo = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["stationz"], typo.deps), 2);
  assert.equal(untimed(typo.err[0] ?? ""), "ERROR [mudab.cli] unknown command 'stationz' (Did you mean stations?)");
});

test("a parse error is logged in the format commander would have parsed (L6)", async () => {
  const isJsonl = (line: string): boolean => line.startsWith("{");
  const cases: [string[], boolean][] = [
    // The options are not once(): commander keeps the last --log-format.
    [["--log-format", "jsonl", "--log-format", "text", "stations", "--frm"], false],
    [["--log-format", "text", "--log-format", "jsonl", "stations", "--frm"], true],
    // --log-format is --user-agent's value, so `jsonl` is an unknown command, logged in text.
    [["--user-agent", "--log-format", "jsonl", "stations"], false],
    // commander takes the program's --log-format out first; --count is left without its value.
    [["stations", "--count", "--log-format", "jsonl"], true],
  ];
  for (const [argv, jsonl] of cases) {
    const cli = makeCli(() => jsonResponse(fx.stations));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.ok(cli.err.length > 0 && cli.err.every((line) => isJsonl(line) === jsonl), `${argv.join(" ")}:\n${cli.err.join("\n")}`);
  }
});

test("the log format is the one commander parsed, not what an option's value looks like (L6)", async () => {
  // commander takes "--" as the User-Agent and then parses --log-format jsonl.
  const cli = makeCli(() => jsonResponse({ message: "boom" }, 500));
  assert.notEqual(await run(["--user-agent", "--", "--log-format", "jsonl", "stations"], cli.deps), 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  // commander takes "--log-format=jsonl" as the User-Agent: the log stays text.
  const ua = makeCli(() => jsonResponse({ message: "boom" }, 500));
  assert.notEqual(await run(["--user-agent", "--log-format=jsonl", "stations"], ua.deps), 0);
  assert.ok(ua.err.length > 0 && ua.err.every((line) => !line.startsWith("{")), ua.err.join("\n"));
});

test("a single-value option given twice is a usage error before any request, never 'the last one wins'", async () => {
  for (const [option, argv] of [
    ["--timeout", ["--timeout", "5", "--timeout", "6", "stations"]],
    ["--timeout", ["--timeout=5", "stations", "--timeout", "6"]],
    ["--base-url", ["--base-url", "http://127.0.0.1:9/a", "--base-url", "http://127.0.0.1:9/b", "stations"]],
    ["--log-format", ["--log-format", "text", "--log-format=jsonl", "stations"]],
    ["--log-format", ["stations", "--log-format", "jsonl", "--log-format", "jsonl"]],
    ["--user-agent", ["--user-agent", "a", "--user-agent", "b", "stations"]],
    ["--max-retries", ["--max-retries", "1", "--max-retries", "2", "stations"]],
    ["--max-response-bytes", ["--max-response-bytes", "1", "--max-response-bytes", "2", "stations"]],
    ["--from", ["stations", "--from", "1", "--from", "2"]],
    ["--count", ["measurements", "--count", "1", "--count=2"]],
    ["--compartment", ["parameters", "--compartment", "wasser", "--compartment", "biota"]],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.stations));
    assert.equal(await run([...argv], cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
    assert.match(cli.err.join("\n"), new RegExp(`${option} may be given only once\\.`), argv.join(" "));
  }
  // Flags may repeat.
  const flags = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--compact", "--compact", "stations", "--all", "--all"], flags.deps), 0);
});

test("an option with an array default is repeatable: each value adds to the list", async () => {
  const program = buildProgram(makeCli(() => jsonResponse(fx.stations)).deps);
  const seen: string[][] = [];
  program
    .command("collect")
    .option("--tag <t>", "repeatable", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .action((opts: { tag: string[] }) => void seen.push(opts.tag));
  forbidRepeatedOptions(program);
  await program.parseAsync(["collect", "--tag", "a", "--tag", "b"], { from: "user" });
  assert.deepEqual(seen, [["a", "b"]]);
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const out: string[] = [];
  const deps: CliDeps = { io: { out: (s) => out.push(s), err: () => {} }, createClient: () => new MudabClient() };
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

test("a boolean that can be switched both ways may be given only once: optional value, or --x / --no-x (T11)", async () => {
  // commander calls no value parser for a bare `--is-open`, so `--is-open false --is-open` turned
  // into true without a word (fragdenstaat-cli); `--x --no-x` keeps the last one the same way.
  const build = () => {
    const program = buildProgram(makeCli(() => jsonResponse(fx.stations)).deps);
    const seen: unknown[] = [];
    program
      .command("flags")
      .option("--is-open [bool]", "optional value", (value: string) => value === "true")
      .option("--cache", "negatable")
      .option("--no-cache", "negatable")
      .option("--archived", "plain flag")
      .action((opts: Record<string, unknown>) => void seen.push(opts));
    forbidRepeatedOptions(program);
    for (const command of program.commands) command.exitOverride().configureOutput({ writeErr: () => {}, outputError: () => {} });
    program.exitOverride();
    return { program, seen };
  };
  for (const argv of [
    ["--is-open", "false", "--is-open"],
    ["--is-open", "--is-open", "false"],
    ["--is-open", "--is-open"],
    ["--cache", "--no-cache"],
    ["--no-cache", "--no-cache"],
  ]) {
    const { program, seen } = build();
    await assert.rejects(program.parseAsync(["flags", ...argv], { from: "user" }), (err: Error) => /may be given only once/.test(err.message), argv.join(" "));
    assert.deepEqual(seen, [], argv.join(" "));
  }
  for (const [argv, expected] of [
    [["--is-open", "false"], { isOpen: false }],
    [["--is-open"], { isOpen: true }],
    [["--no-cache", "--archived", "--archived"], { cache: false, archived: true }],
  ] as const) {
    const { program, seen } = build();
    await program.parseAsync(["flags", ...argv], { from: "user" });
    assert.deepEqual(seen, [expected], argv.join(" "));
  }
});

test("--help states the 30 s default timeout, and a timeout points at --timeout (04-3)", async () => {
  const help = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["--help"], help.deps), 0);
  assert.match(help.out.join("\n").replace(/\s+/g, " "), /--timeout <ms> time limit per request in ms, whole response included \(default 30000; 0 = no timeout\)/);
  // A transport that answers only when aborted: the engine's deadline fires after 5 ms.
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) =>
      new MudabClient({
        ...opts,
        transport: (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(req.signal?.reason))),
      }),
  };
  assert.equal(await run(["--timeout", "5", "measurements", "--all"], deps), 6);
  assert.deepEqual(out, []);
  assert.deepEqual(err.map(untimed), [
    "ERROR [mudab.http] POST https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements/MV_STATION_MSMNT failed: Request timed out after 5ms",
    "INFO  [mudab.http] The whole response must arrive within --timeout (5 ms here; default 30000). A large table (measurements --all) on a slow link needs more: raise --timeout <ms> (0 = no limit), or page with --from/--count.",
  ]);
});

// T15 of the 2026-10-21 fix round (the class of jobsuche-cli 28be809): the redaction looked for
// a URL's credentials only in an argument that starts with a scheme, so a padded value, one
// after a dash or inside a phrase, echoed in a refusal or by commander, printed the password.
test("a password in a URL anywhere in an argument is redacted on stderr, in every message that quotes it (T15)", async () => {
  const url = "https://bob:s3cretpw@host.example/";
  const values = [url, ` ${url}`, `\t${url}`, ` -${url}`, `x ${url}`, `wasser​${url}`];
  // A refused --compartment (commander's echo and the library's quote), a refused --count, a
  // refused --user-agent, a surplus argument, an unknown command and a refused --base-url.
  const argvs = values.flatMap((v) => [
    ["parameters", "--compartment", v],
    ["parameters", `--compartment=${v}`],
    ["stations", "--count", v],
    ["--user-agent", `${v}\u20ac`, "stations"],
    ["stations", v],
    [v],
    ["--base-url", v, "stations"],
  ]);
  for (const argv of argvs) {
    for (const format of ["text", "jsonl"]) {
      const cli = makeCli(() => jsonResponse(fx.stations));
      await run(["--log-format", format, ...argv], cli.deps);
      const err = cli.err.join("\n");
      assert.doesNotMatch(err, /s3cretpw|bob%3As3/, `${JSON.stringify(argv)} ${format}: ${err}`);
    }
  }
});
