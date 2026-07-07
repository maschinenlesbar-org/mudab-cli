import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { MudabApiError, MudabParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, jsonBodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";

test("buildUrl normalises the path (parameters travel in the body)", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/base/" });
  assert.equal(e.buildUrl("STATION_SMALL"), "https://example.test/base/STATION_SMALL");
  assert.equal(e.buildUrl("/x"), "https://example.test/base/x");
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

test("postJson returns null on an empty/204 body", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 204));
  const e = new RequestEngine({ transport: mt.transport });
  assert.equal(await e.postJson("/x", {}), null);
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

test("a 3xx is NOT followed and hints at the canonical base URL", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return { status: 301, headers: { location: "https://www.mudab.de/rest/x" }, body: Buffer.alloc(0) };
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}),
    (err) => err instanceof MudabApiError && err.status === 301 && /canonical base URL/.test(err.message),
  );
  assert.equal(calls, 1); // never followed the redirect
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
