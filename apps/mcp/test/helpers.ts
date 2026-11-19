// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of the
// MUDAB API (the client's tables.ts: live rows of 2026-11-19, POST only, the range honoured and
// nothing else, the rows under the live wrapper key), and the client's transport helpers. The
// generic harness (a connection, a config, a log recorder, the HTTP server) is harness.ts.

import { makeMockTransport, type MockTransport } from "@maschinenlesbar.org/mudab-client/test/helpers";
import { apiLog, mudabApi, sampleTables, type ApiLog, type Tables } from "@maschinenlesbar.org/mudab-client/test/tables";

export * from "@maschinenlesbar.org/mudab-client/test/helpers";
export * from "@maschinenlesbar.org/mudab-client/test/tables";

/** A mock transport on the MUDAB API over `tables` (the sample by default), with its request log. */
export function mudab(tables: Tables = sampleTables(), log: ApiLog = apiLog()): MockTransport & { log: ApiLog } {
  return { ...makeMockTransport(mudabApi(tables, log)), log };
}
