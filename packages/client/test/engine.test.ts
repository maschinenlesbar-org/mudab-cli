import { test } from "node:test";
import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import { RequestEngine, assertHeaderValue, bigIntegerKeysOption, cleartextProblem, firstInexactNumber, parseRetryAfter, scanNumbers } from "../src/engine.js";
import { headerNameProblem, headerValueProblem } from "../src/validate.js";
import { MudabApiError, MudabNetworkError, MudabParseError, MudabValidationError, cutText, redactUrl, toWellFormed } from "../src/errors.js";
import { MudabClient } from "../src/client.js";
import { makeMockTransport, jsonResponse, rawResponse, jsonBodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";
import type { HttpResponse } from "../src/http.js";

test("buildUrl normalises the path (parameters travel in the body)", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/base/" });
  assert.equal(e.buildUrl("STATION_SMALL"), "https://example.test/base/STATION_SMALL");
  assert.equal(e.buildUrl("/x"), "https://example.test/base/x");
});

test("the engine rejects a non-http(s) base URL before any request", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.parameters));
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof MudabValidationError && !(err instanceof MudabNetworkError),
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("postJson sends a POST with a JSON body, Content-Type and Content-Length", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.parameters));
  const e = new RequestEngine({ transport: mt.transport });
  await e.postJson("/MV_PARAMETER", { range: { count: 5 } });
  const req = mt.last();
  assert.equal(req.method, "POST");
  assert.equal(req.headers?.["Content-Type"], "application/json");
  assert.equal(req.headers?.["Accept"], "application/json");
  assert.equal(req.headers?.["Content-Length"], String((req.body as Buffer).length));
  assert.deepEqual(jsonBodyOf(req), { range: { count: 5 } });
  assert.equal(new URL(req.url).pathname.endsWith("/MV_PARAMETER"), true);
});

test("postJson parses and returns the JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.parameters));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.postJson("/MV_PARAMETER", {}), fx.parameters);
});

test("postJson rejects an empty or 204 body as a MudabParseError", async () => {
  for (const [body, status] of [["", 204], ["", 200], ["  \n", 200]] as const) {
    const mt = makeMockTransport(() => rawResponse(body, "application/json", status));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.postJson("/x", {}),
      (err) => err instanceof MudabParseError && err.message === "POST https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements/x: empty response body.",
    );
  }
});

test("postJson throws MudabParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.postJson("/x", {}), MudabParseError);
});

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"V_STATION_SMALL":[{"STATNAME_ST":"a","n":${n},"text":"12345678901234567890 in a string"}]}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: below 2.2250738585072014e-308 a double has fewer digits; 3e-324 became 5e-324 (D4).
    "3e-324", "4e-324", "-4.9e-324", "2.4703282292062328e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.postJson("/STATION_SMALL", {}), (err: unknown) => {
      assert.ok(err instanceof MudabParseError, n);
      assert.equal(err.message, `POST https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements/STATION_SMALL: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["0.000123", 0.000123],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    const res = await e.postJson<{ V_STATION_SMALL: Array<{ n: number }> }>("/STATION_SMALL", {});
    assert.equal(res.V_STATION_SMALL[0]?.n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.postJson("/x", {}), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.postJson<number[]>("/x", {})).length, 200_000);
});

test("a non-2xx surfaces as a MudabApiError with the parsed detail", async () => {
  const mt = makeMockTransport(() => jsonResponse({ message: "bad column" }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => err instanceof MudabApiError && err.status === 400 && /bad column/.test(err.message),
  );
});

test("a non-JSON (plain-text) error body is surfaced as the detail", async () => {
  const mt = makeMockTransport(() => rawResponse("Internal Server Error: NPE at row 5", "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => err instanceof MudabApiError && err.status === 500 && /NPE at row 5/.test(err.message),
  );
});

test("control characters in a JSON error detail are stripped before reaching the message", async () => {
  const esc = String.fromCharCode(0x1b);
  const bel = String.fromCharCode(0x07);
  const hostile = `${esc}]0;pwned${bel}${esc}[2Jcleared`;
  const mt = makeMockTransport(() => jsonResponse({ detail: hostile }, 403));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => {
      if (!(err instanceof MudabApiError) || err.status !== 403) return false;
      // No C0/C1/DEL byte survives into the message that would be printed to stderr.
      for (const ch of err.message) {
        const n = ch.charCodeAt(0);
        if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) return false;
      }
      // The harmless text is preserved.
      return err.message.includes("pwned") && err.message.includes("cleared");
    },
  );
});

test("an over-long JSON error detail is capped", async () => {
  const long = "A".repeat(500);
  const mt = makeMockTransport(() => jsonResponse({ message: long }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => err instanceof MudabApiError && err.message.includes("…") && !err.message.includes("A".repeat(300)),
  );
});

test("control characters in a plain-text error body are stripped too", async () => {
  const esc = String.fromCharCode(0x1b);
  const mt = makeMockTransport(() => rawResponse(`boom${esc}[2J`, "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => {
      if (!(err instanceof MudabApiError) || err.status !== 500) return false;
      for (const ch of err.message) {
        const n = ch.charCodeAt(0);
        if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) return false;
      }
      return err.message.includes("boom");
    },
  );
});

test("a 3xx is NOT followed and the error names the target", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return { status: 301, headers: { location: "https://www.mudab.de/rest/x" }, body: Buffer.alloc(0) };
  });
  const e = new RequestEngine({ baseUrl: "https://h.test/b", transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) =>
      err instanceof MudabApiError &&
      err.status === 301 &&
      err.location === "https://www.mudab.de/rest/x" &&
      err.message === "HTTP 301 for POST https://h.test/b/x: redirect to https://www.mudab.de/rest/x not followed",
  );
  assert.equal(calls, 1); // never followed the redirect
});

test("a 3xx Location is resolved, redacted and sanitised; a missing one is named", async () => {
  const esc = String.fromCharCode(0x1b);
  for (const [location, expected] of [
    ["/other", "HTTP 302 for POST https://h.test/b/x: redirect to https://h.test/other not followed"],
    ["https://u:pw@evil.test/p", "HTTP 302 for POST https://h.test/b/x: redirect to https://***@evil.test/p not followed"],
    [`/a${esc}[2Jb`, "HTTP 302 for POST https://h.test/b/x: redirect to https://h.test/a%1B[2Jb not followed"],
    [undefined, "HTTP 302 for POST https://h.test/b/x: redirect not followed (no Location header)"],
  ] as const) {
    const mt = makeMockTransport(() => ({
      status: 302,
      headers: location === undefined ? {} : { location },
      body: Buffer.from("<html>moved</html>"),
    }));
    const e = new RequestEngine({ baseUrl: "https://h.test/b", transport: mt.transport });
    await assert.rejects(
      () => e.postJson("/x", {}),
      (err) => err instanceof MudabApiError && err.message === expected,
      String(location),
    );
  }
});

test("a 503 is retried up to maxRetries then surfaces as a MudabApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ error: "busy" }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => err instanceof MudabApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.empty));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.postJson("/x", {});
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

function retryEngine(headers: Record<string, string | string[]>) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify({ message: "slow down" })),
  }));
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { e, mt, delays };
}

test("a 429 waits the Retry-After seconds before each retry", async () => {
  const { e, mt, delays } = retryEngine({ "retry-after": "1" });
  await assert.rejects(() => e.postJson("/x", {}), (err) => err instanceof MudabApiError && err.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("a malformed Retry-After falls back to the linear backoff", async () => {
  for (const bad of ["-1", "+5", "1.5", "1e3", "0x10", "", "Sunday, 06-Nov-94 08:49:37 GMT", "2026-09-26T10:00:00Z"]) {
    const { e, delays } = retryEngine({ "retry-after": bad });
    await assert.rejects(() => e.postJson("/x", {}), MudabApiError);
    assert.deepEqual(delays, [200, 400], bad);
  }
});

test("a Retry-After beyond 30 s is not retried: the error surfaces at once", async () => {
  const far = new Date(Date.now() + 3_600_000).toUTCString();
  for (const long of ["31", "999999999", far]) {
    const { e, mt, delays } = retryEngine({ "retry-after": long });
    await assert.rejects(() => e.postJson("/x", {}), (err) => err instanceof MudabApiError && err.status === 429);
    assert.equal(mt.calls.length, 1, long);
    assert.deepEqual(delays, [], long);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdates only", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter([" 2 ", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("1.5", now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});

test("numeric engine options must be integers in range", () => {
  const cases: [string, number, RegExp][] = [
    ["maxRetries", Infinity, /^Invalid option maxRetries: expected an integer from 0 to 10, got Infinity\.$/],
    ["maxRetries", 11, /from 0 to 10, got 11/],
    ["maxRetries", -1, /got -1/],
    ["timeoutMs", -5, /^Invalid option timeoutMs: expected an integer from 0 to 2147483647, got -5\.$/],
    ["timeoutMs", NaN, /got NaN/],
    ["timeoutMs", 1.5, /got 1\.5/],
    ["retryDelayMs", 30_001, /^Invalid option retryDelayMs: expected an integer from 0 to 30000/],
    ["maxResponseBytes", -1, /^Invalid option maxResponseBytes: expected an integer from 0 to 9007199254740991, got -1\.$/],
  ];
  for (const [name, value, message] of cases) {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err) => err instanceof MudabValidationError && message.test(err.message),
      `${name}=${value}`,
    );
  }
  // Boundaries are accepted.
  new RequestEngine({ maxRetries: 0, timeoutMs: 0, retryDelayMs: 0, maxResponseBytes: 0 });
  new RequestEngine({ maxRetries: 10, timeoutMs: 2_147_483_647, retryDelayMs: 30_000 });
});

test("userinfo in the base URL is redacted from error messages but still sent", async () => {
  const mt = makeMockTransport(() => rawResponse("boom", "text/plain", 500));
  const e = new RequestEngine({ baseUrl: "http://user:secret@127.0.0.1:1/base", transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/STATION_SMALL", {}),
    (err) =>
      err instanceof MudabApiError &&
      err.message === "HTTP 500 for POST http://***@127.0.0.1:1/base/STATION_SMALL: boom" &&
      err.url === "http://***@127.0.0.1:1/base/STATION_SMALL",
  );
  assert.equal(mt.last().url, "http://user:secret@127.0.0.1:1/base/STATION_SMALL");
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://user:secret@example.org/" }),
    (err) => err instanceof MudabValidationError && !err.message.includes("secret"),
  );
  assert.equal(redactUrl("https://example.org/x"), "https://example.org/x");
  assert.equal(redactUrl("not a url"), "not a url");
});

test("the engine rejects a base URL with a query or fragment (library users)", () => {
  for (const baseUrl of ["http://h.test/x?y=1", "http://u:secret@h.test/x#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err) =>
        err instanceof MudabValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#)." &&
        !err.message.includes("secret"),
    );
  }
});

test("the engine checks userAgent and defaultHeaders before any request", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  for (const [options, message] of [
    [{ userAgent: "" }, "Invalid userAgent: Expected a non-empty value."],
    [{ userAgent: "a\nb" }, "Invalid userAgent: Value contains control characters."],
    [{ userAgent: "€" }, "Invalid userAgent: Value contains characters outside Latin-1 (above U+00FF)."],
    [{ defaultHeaders: { "X-Trace": "a\r\nb" } }, 'Invalid defaultHeaders["X-Trace"]: Value contains control characters.'],
    [{ defaultHeaders: { "Bad Name": "x" } }, 'Invalid defaultHeaders name: Expected an HTTP header name (a token), got "Bad Name".'],
  ] as const) {
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, ...options }),
      (err) => err instanceof MudabValidationError && err.message === message,
      JSON.stringify(options),
    );
  }
  assert.equal(mt.calls.length, 0);
  assert.equal(assertHeaderValue("User-Agent", "ok\t1"), "ok\t1");
  assert.equal(headerValueProblem("x"), undefined);
  assert.equal(headerValueProblem(" "), "Expected a non-empty value.");
  assert.equal(headerNameProblem("X-Trace-Id"), undefined);
});

test("the engine checks the raw base URL, before stripping trailing slashes", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "https://h.example/x/ ", transport: mt.transport }),
    (err) => err instanceof MudabValidationError && err.message === "Invalid baseUrl: A base URL cannot have surrounding whitespace.",
  );
  assert.equal(mt.calls.length, 0);
});

test("a redirect's Location is read from a Headers object, a Map and any header case", async () => {
  const shapes: unknown[] = [
    new Headers({ Location: "https://elsewhere.test/x" }),
    new Map([["Location", "https://elsewhere.test/x"]]),
    { Location: "https://elsewhere.test/x" },
    { LOCATION: "https://elsewhere.test/x" },
  ];
  for (const headers of shapes) {
    const e = new RequestEngine({
      baseUrl: "https://h.test/b",
      transport: async () => ({ status: 302, headers: headers as Record<string, string>, body: Buffer.alloc(0) }),
    });
    await assert.rejects(
      e.postJson("/x", {}),
      (err) =>
        err instanceof MudabApiError &&
        err.message === "HTTP 302 for POST https://h.test/b/x: redirect to https://elsewhere.test/x not followed",
    );
  }
});

test("a transport response without a status is a MudabNetworkError, never success", async () => {
  const e = new RequestEngine({
    transport: async () =>
      ({ headers: {}, body: Buffer.from(JSON.stringify({ V_STATION_SMALL: [] })) }) as unknown as HttpResponse,
  });
  await assert.rejects(e.postJson("/STATION_SMALL", {}), MudabNetworkError);
});

test("postJson decodes by the declared charset, drops a BOM, and rejects an unknown charset", async () => {
  const text = "Säure KÖRKWITZ µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const mt = makeMockTransport(() =>
      rawResponse(Buffer.from(JSON.stringify([text]), encoding), `application/json; charset=${charset}`),
    );
    assert.deepEqual(await new RequestEngine({ transport: mt.transport }).postJson("/x", {}), [text], charset);
  }
  const bom = makeMockTransport(() =>
    rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("[]")]), "application/json"),
  );
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).postJson("/x", {}), []);
  const unknown = makeMockTransport(() => rawResponse("[]", "application/json; charset=x-bogus"));
  await assert.rejects(new RequestEngine({ transport: unknown.transport }).postJson("/x", {}), MudabParseError);
});

test("a parse error says what came back: the parser's reason, content type, size and start", async () => {
  const cases: [string, string, RegExp][] = [
    [
      "<html><body>Wartungsarbeiten</body></html>",
      "text/html",
      /^POST https:\/\/geoportal\.bafg\.de\/mudab\/rest\/BaseController\/FilterElements\/STATION_SMALL: the answer is not valid JSON: .+\. The reply \(content type "text\/html", 42 bytes\) starts with "<html><body>Wartungsarbeiten<\/body><\/html>"\. It looks like an HTML page/,
    ],
    ['{"V_STATION_SMALL":[{"a":1', "application/json", /^POST https:\/\/geoportal\.bafg\.de\/mudab\/rest\/BaseController\/FilterElements\/STATION_SMALL: the answer is not valid JSON: .*JSON.*\. The reply \(content type "application\/json", 26 bytes\) starts with/],
  ];
  for (const [body, type, message] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, type));
    await assert.rejects(
      new RequestEngine({ transport: mt.transport }).postJson("/STATION_SMALL", {}),
      (err) => err instanceof MudabParseError && message.test(err.message),
      body,
    );
  }
});

test("a parse error is one line: the parser's reason quotes the body's line breaks folded (B01-2)", async () => {
  // V8's reason quotes the first characters of the body raw, line breaks included: a plain
  // maintenance page split the ERROR record over two stderr lines.
  for (const body of ["<html>\r\n<head><title>Wartungsarbeiten</title></head></html>", "oops\n2026-10-09T00:00:00.000Z INFO"]) {
    const mt = makeMockTransport(() => rawResponse(body, "text/html"));
    await assert.rejects(new RequestEngine({ transport: mt.transport }).postJson("/STATION_SMALL", {}), (err) => {
      assert.ok(err instanceof MudabParseError);
      assert.doesNotMatch(err.message, /[\r\n]/, JSON.stringify(err.message));
      assert.match(err.message, /^POST https:\/\/geoportal\.bafg\.de\/mudab\/rest\/BaseController\/FilterElements\/STATION_SMALL: the answer is not valid JSON: Unexpected token/);
      return true;
    });
  }
});

test("toWellFormed replaces half a character and keeps whole ones", () => {
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("cutText never cuts inside a surrogate pair", () => {
  assert.equal(cutText("a\u{1f600}b", 2), "a");
  assert.equal(cutText("a\u{1f600}b", 3), "a\u{1f600}");
  assert.equal(cutText("abc", 5), "abc");
});

test("server text cut to a length limit keeps every message well-formed", async () => {
  // "a" first, so an even cut lands after the high half of an emoji; without it, an odd one.
  for (const text of ["a" + "\u{1f600}".repeat(600), "\u{1f600}".repeat(600)]) {
    for (const [status, body] of [
      [500, { message: text }],
      [500, text],
      [200, { errors: [{ message: text }] }],
    ] as const) {
      const mt = makeMockTransport(() =>
        typeof body === "string" ? rawResponse(body, "text/plain", status) : jsonResponse(body, status),
      );
      const err = await new MudabClient({ transport: mt.transport, maxRetries: 0 }).stations().catch((caught: unknown) => caught);
      assert.ok(err instanceof MudabApiError, String(err));
      assert.equal(toWellFormed(err.message), err.message, `${status} ${typeof body}`);
      assert.match(err.message, /…$/);
    }
    const mt = makeMockTransport(() => rawResponse(`{"x${text}`, "application/json"));
    const err = await new MudabClient({ transport: mt.transport }).stations().catch((caught: unknown) => caught);
    assert.ok(err instanceof MudabParseError);
    assert.equal(toWellFormed(err.message), err.message);
  }
});

test("a transport's error text and a redirect target are cut in the message; location keeps the target", async () => {
  const long = "y".repeat(10_000);
  const thrown = new RequestEngine({ baseUrl: "https://a.test", transport: async () => { throw new Error(long); } });
  const err = await thrown.postJson("/x", {}).catch((caught: unknown) => caught);
  assert.ok(err instanceof MudabNetworkError);
  // The request it names, then the transport's text, cut at 500 characters (+ "…").
  assert.ok(err.message.startsWith("POST https://a.test/x failed: yyy"), err.message.slice(0, 40));
  assert.ok(err.message.length <= "POST https://a.test/x failed: ".length + 501, String(err.message.length));
  const target = `https://b.test/${long}`;
  const redirect = new RequestEngine({
    baseUrl: "https://a.test",
    transport: async () => ({ status: 301, headers: { location: target }, body: Buffer.alloc(0) }),
  });
  const moved = await redirect.postJson("/x", {}).catch((caught: unknown) => caught);
  assert.ok(moved instanceof MudabApiError);
  assert.ok(moved.message.length < 700, String(moved.message.length));
  assert.equal(moved.location, target);
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node's transport sends the pair UTF-8 encoded, so that is the form a server echoes.
  const basic = Buffer.from("alice:pä ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ message: `no: Basic ${basic} / alice:pä ss-pw / pä ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:p%C3%A4%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.postJson("/x", {}), (err: unknown) => {
    assert.ok(err instanceof MudabApiError);
    for (const form of [basic, "alice:pä ss-pw", "pä ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("cleartextProblem: exact wording, host with port, loopback range, never the secret", () => {
  assert.equal(cleartextProblem("http://mirror.example:8080/api"), "requests to mirror.example:8080 are sent unencrypted (http:, not https:)");
  assert.equal(
    cleartextProblem("http://alice:pw@mirror.example"),
    "the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://alice:pw@mirror.example", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(cleartextProblem("http://mirror.example", ["the login"]), "the login is sent unencrypted to mirror.example (http:, not https:)");
  for (const url of ["https://alice:pw@mirror.example", "http://127.8.9.10", "http://localhost:1", "http://[::1]/", "not a url"]) {
    assert.equal(cleartextProblem(url), undefined, url);
  }
  assert.notEqual(cleartextProblem("http://128.0.0.1"), undefined);
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse(fx.parameters),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.postJson("/x", {});
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://***@example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://***@example.test/x" },
  ]);
});

test("onRetry is never called without a retry (none for a reset connection: it is not retried)", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse(fx.parameters)).transport, sleep: async () => {}, onRetry });
  await ok.postJson("/x", {});
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.postJson("/x", {}), MudabApiError);
  const reset = new RequestEngine({
    transport: makeMockTransport(() => {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    }).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(reset.postJson("/x", {}), MudabNetworkError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.postJson("/x", {}), MudabApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.postJson("/x", {}), MudabApiError);
  assert.equal(events.length, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const e = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse(fx.parameters))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await e.postJson("/x", {});
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), MudabValidationError);
});

test("a network error names the request: a timeout, the size cap, a refused connection, DNS, a reset", async () => {
  const url = "https://***@mirror.example/api/STATION_SMALL";
  const boom = (code: string, message: string) => Object.assign(new Error(message), { code });
  const cases: Array<[string, Partial<ConstructorParameters<typeof RequestEngine>[0]>, () => Promise<HttpResponse>, string]> = [
    ["timeout", { timeoutMs: 5 }, () => new Promise<HttpResponse>(() => {}), "Request timed out after 5ms"],
    ["size cap", { maxResponseBytes: 3 }, async () => rawResponse("[1,2,3,4]", "application/json"), "Response exceeded the size limit of 3 bytes (maxResponseBytes; --max-response-bytes on the CLI)"],
    ["refused", {}, async () => { throw boom("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9"); }, "connect ECONNREFUSED 127.0.0.1:9"],
    ["dns", {}, async () => { throw boom("ENOTFOUND", "getaddrinfo ENOTFOUND mirror.example"); }, "getaddrinfo ENOTFOUND mirror.example"],
    ["reset", {}, async () => { throw new MudabNetworkError("socket hang up"); }, "socket hang up"],
    ["invalid", {}, async () => ({ headers: {}, body: Buffer.alloc(0) }) as unknown as HttpResponse, "The transport returned an invalid response (status is not an HTTP status code)."],
  ];
  for (const [name, options, respond, reason] of cases) {
    const mt = makeMockTransport(respond);
    const e = new RequestEngine({ baseUrl: "https://user:pw@mirror.example/api", transport: mt.transport, ...options });
    await assert.rejects(e.postJson("/STATION_SMALL", {}), (err: unknown) => {
      assert.ok(err instanceof MudabNetworkError, name);
      assert.equal(err.message, `POST ${url} failed: ${reason}`, name);
      if (name === "refused" || name === "dns" || name === "reset") assert.ok(err.cause instanceof Error, name);
      return true;
    });
  }
});

test("a refused loopback connection names the request (real transport)", async () => {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const e = new RequestEngine({ baseUrl: `http://127.0.0.1:${port}/mudab` });
  await assert.rejects(e.postJson("/STATION_SMALL", {}), (err: unknown) => {
    assert.ok(err instanceof MudabNetworkError);
    assert.match(err.message, new RegExp(`^POST http://127\\.0\\.0\\.1:${port}/mudab/STATION_SMALL failed: connect ECONNREFUSED`));
    assert.ok(err.cause instanceof Error);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=x-bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  // With the prototype set, its "x-bogus" charset was read as the answer's and refused.
  assert.deepEqual(await e.postJson("/x", {}), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.postJson("/x", {}), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.postJson("/x", {}), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.postJson("/x", {}), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.postJson("/x", {}), (err: unknown) => err instanceof MudabParseError && /JSON/.test(err.message));
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof MudabValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  const base = new URL("https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.postJson("/STATION_SMALL", {}), (err: unknown) => {
      assert.ok(err instanceof MudabParseError, what);
      assert.ok(err.message.startsWith(`POST ${base.protocol}//***@${base.host}`), err.message);
      assert.ok(err.message.includes("/FilterElements/STATION_SMALL: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.postJson("/STATION_SMALL", {});
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `POST https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements/STATION_SMALL: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.postJson("/x", {}), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.postJson("/x", {}), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), MudabValidationError);
});

test("an answer longer than V8's longest string is a MudabParseError naming the request, from either decode (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length — on the fatal decode, and on the
  // replacing decode after a body that is not valid UTF-8.
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  for (const [label, huge, failOn] of [
    ["valid", Buffer.from('{"V_STATION_SMALL":[]}            '), "fatal"],
    ["invalid bytes", Buffer.concat([Buffer.from('{"V_STATION_SMALL":["'), Buffer.from([0xff]), Buffer.from('"]}')]), "replacing"],
  ] as const) {
    const decode = TextDecoder.prototype.decode;
    const mock = t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
      if (input !== undefined && input.byteLength === huge.length && (failOn === "fatal" ? this.fatal : !this.fatal)) throw tooLong;
      return decode.call(this, input, options);
    });
    const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
    await assert.rejects(e.postJson("/STATION_SMALL", {}), (err: unknown) => {
      assert.ok(err instanceof MudabParseError, `${label}: ${String(err)}`);
      assert.ok(err.message.startsWith(
        `POST https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements/STATION_SMALL: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters`,
      ), `${label}: ${err.message}`);
      return true;
    });
    mock.mock.restore();
  }
});

test("a misspelled option is a MudabValidationError naming it, never ignored (03-1)", async () => {
  // `timeout` for `timeoutMs` used to be ignored: the call ran with the 30 s default.
  const mt = makeMockTransport(() => jsonResponse(fx.stations));
  for (const [options, message] of [
    [{ timeout: 500 }, 'Invalid options: unknown option "timeout" (did you mean timeoutMs?).'],
    [{ timeoutms: 500 }, 'Invalid options: unknown option "timeoutms" (did you mean timeoutMs?).'],
    [{ retries: 1 }, 'Invalid options: unknown option "retries" (did you mean maxRetries?).'],
    [{ proxy: "http://p" }, 'Invalid options: unknown option "proxy"; the options are baseUrl, transport, userAgent, defaultHeaders, timeoutMs, maxRetries, retryDelayMs, maxResponseBytes, sleep, onRetry, onWarning, bigIntegerKeys.'],
    // The name is quoted visibly.
    [{ "ti\u200bmeout": 1 }, 'Invalid options: unknown option "ti\\u200bmeout"; the options are baseUrl, transport, userAgent, defaultHeaders, timeoutMs, maxRetries, retryDelayMs, maxResponseBytes, sleep, onRetry, onWarning, bigIntegerKeys.'],
  ] as const) {
    assert.throws(() => new RequestEngine({ ...options, transport: mt.transport } as never), (err: unknown) =>
      err instanceof MudabValidationError && err.message === message, JSON.stringify(options));
    assert.throws(() => new MudabClient({ ...options, transport: mt.transport } as never), MudabValidationError);
  }
  // An unset key (from a spread config) changes nothing; the known ones pass.
  const e = new RequestEngine({ proxy: undefined, timeoutMs: 500, transport: mt.transport } as never);
  assert.ok(await e.postJson("/STATION_SMALL", {}));
  assert.equal(mt.calls.length, 1);
});
