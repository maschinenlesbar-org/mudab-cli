import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, assertHeaderValue, cleartextProblem, parseRetryAfter } from "../src/client/engine.js";
import { headerNameProblem, headerValueProblem } from "../src/client/validate.js";
import { MudabApiError, MudabNetworkError, MudabParseError, MudabValidationError, cutText, redactUrl, toWellFormed } from "../src/client/errors.js";
import { MudabClient } from "../src/client/client.js";
import { makeMockTransport, jsonResponse, rawResponse, jsonBodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";
import type { HttpResponse } from "../src/client/http.js";

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
      (err) => err instanceof MudabParseError && err.message === "Empty response body from /x",
    );
  }
});

test("postJson throws MudabParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.postJson("/x", {}), MudabParseError);
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
      /^Failed to parse JSON response from \/STATION_SMALL: .+\. The reply \(content type "text\/html", 42 bytes\) starts with "<html><body>Wartungsarbeiten<\/body><\/html>"\. It looks like an HTML page/,
    ],
    ['{"V_STATION_SMALL":[{"a":1', "application/json", /^Failed to parse JSON response from \/STATION_SMALL: .*JSON.*\. The reply \(content type "application\/json", 26 bytes\) starts with/],
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

test("toWellFormed replaces half a character and keeps whole ones", () => {
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a� b� \u{1f600}");
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
  assert.ok(err.message.length <= 501, String(err.message.length));
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
