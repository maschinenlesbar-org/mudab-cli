// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { MudabClient as Client, normalizeRange, type ParameterCompartment } from "../src/client/client.js";
import {
  MudabError as BaseError,
  MudabParseError as ParseError,
  MudabValidationError as ValidationError,
} from "../src/client/errors.js";
import type { ListRequest } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.parameters();
const textBody = (text: string): unknown => ({ MV_PARAMETER: [{ PARAMETER: "X", PARAM_NAME: text }] });
const readText = (result: unknown): string => (result as Array<{ PARAM_NAME: string }>)[0]!.PARAM_NAME;
/**
 * 2xx bodies the call must reject (error objects, empty or wrong shapes, another table's
 * rows, non-object rows). `{"MV_PARAMETER":[]}` is not one: it means "no rows". An error
 * envelope (`{"errors":[…]}`, `{"error":…}`) is a MudabApiError with its messages, not a
 * parse error: client.test.ts covers it.
 */
const malformedBodies: unknown[] = [
  null,
  {},
  "text",
  42,
  { message: "ORA-00942: table or view does not exist" },
  { MV_PARAMETER: null },
  { MV_PARAMETER: [], meta: {} },
  { V_MESSWERTE_PLC: [{ NAME: "Ntot" }] },
  { MV_PARAMETER: [null, null] },
  { MV_PARAMETER: ["Datenbankfehler"] },
  [42],
  [[]],
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["stations(5)", () => new Client().stations(5 as unknown as ListRequest)],
  ["stations('x')", () => new Client().stations("x" as unknown as ListRequest)],
  ["stations([])", () => new Client().stations([] as unknown as ListRequest)],
  ["stations({ count: 5 })", () => new Client().stations({ count: 5 } as unknown as ListRequest)],
  ["stations({ range: { form: 5 } })", () => new Client().stations({ range: { form: 5 } } as unknown as ListRequest)],
  ["stations({ range: { count: '5' } })", () => new Client().stations({ range: { count: "5" as unknown as number } })],
  ["stations({ all: 'yes' })", () => new Client().stations({ all: "yes" as unknown as boolean })],
  ["parameters(5)", () => new Client().parameters(5 as unknown as ListRequest)],
  ["parameters({}, 5)", () => new Client().parameters({}, 5 as unknown as ParameterCompartment)],
  ["parameters({}, null)", () => new Client().parameters({}, null as unknown as ParameterCompartment)],
  ["normalizeRange(5)", () => normalizeRange(5 as unknown as ListRequest)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["retryDelayMs: 3e9", () => new Client({ retryDelayMs: 3_000_000_000 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as unknown as Record<string, string> })],
  ["options 'x'", () => new Client("x" as unknown as object)],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
