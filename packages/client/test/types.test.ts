// Compile-time checks of the exported library types, and the runtime rule they rest on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASE_URL, MudabClient } from "../src/index.js";
import { jsonBodyOf, jsonResponse, makeMockTransport } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "mudab-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { MudabClient, type EngineOptions, type MudabClientOptions, type ListRequest, type FilterRequest, type Range, type Filter, type OrderBy } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const clientOptions: MudabClientOptions = allUndefined<MudabClientOptions>();",
        "export const request: ListRequest = allUndefined<ListRequest>();",
        "export const body: FilterRequest = allUndefined<FilterRequest>();",
        "export const range: Range = allUndefined<Range>();",
        "export const filter: Filter = allUndefined<Filter>();",
        "export const orderby: OrderBy = { col: 'STATNAME_ST', dir: undefined };",
        "export const client = new MudabClient({ baseUrl: process.env.MUDAB_BASE_URL, timeoutMs: 15_000 });",
        "const count: number | undefined = process.env.COUNT === undefined ? undefined : Number(process.env.COUNT);",
        "export const names = async (): Promise<unknown[]> => (await client.stations({ range: { from: 0, count }, all: undefined })).map((s) => s.STATNAME_ST);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => jsonResponse({ V_STATION_SMALL: [] }));
  const client = new MudabClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.stations({ filter: undefined, range: undefined, orderby: undefined, all: undefined });
  await client.stations({ range: { from: undefined, count: undefined } });
  for (const req of mt.calls) {
    assert.equal(req.url, `${DEFAULT_BASE_URL}/STATION_SMALL`);
    assert.equal(req.headers?.["User-Agent"], "mudab-cli");
    assert.deepEqual(jsonBodyOf(req), { range: { from: 0, count: 100 } });
  }
  assert.equal(mt.calls.length, 2);
});
