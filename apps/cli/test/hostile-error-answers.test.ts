// A large error answer ends in one clean ERROR record within a small heap (security audit
// 2026-10-27, class C of create-cli-template): the server text cleaned for a message is cut
// before it is cleaned, and cleaned without one `+=` per character. A 4 MB JSON message, an
// 8 MB plain-text body or a 4 MB message in an error envelope sent with 200 aborted the bin
// under a 128 MB heap (SIGABRT, heap out of memory). The bin runs in a child process with
// --max-old-space-size, against a local server; no request leaves the machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
const call = ["stations", "--all"];

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Serve `status`, `contentType` and `body` to one run of the bin with a heap of `heapMb`, then stop. */
async function runWithAnswer(status: number, contentType: string, body: Buffer, heapMb: number): Promise<Run> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", contentType);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await new Promise<Run>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, "--base-url", base, "--max-retries", "0", ...call],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** No crash, exit 1, nothing on stdout, and one cut ERROR record of mudab.api. */
function oneErrorRecord(run: Run, label: string, head: RegExp): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
  assert.equal(run.code, 1, `${label}: exit ${run.code} ${run.signal} ${run.stderr.slice(0, 500)}`);
  assert.equal(run.stdout, "");
  const records = run.stderr.trim().split("\n");
  assert.equal(records.length, 1, `${label}: ${run.stderr.slice(0, 500)}`);
  assert.match(records[0] ?? "", head, label);
  assert.ok((records[0] ?? "").length < 5000, `${label}: the record is cut`);
}

test("a 16 MB JSON error message ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  const run = await runWithAnswer(500, "application/json", Buffer.from(`{"message":"${"x ".repeat(8_000_000)}"}`), 128);
  oneErrorRecord(run, "JSON detail", /ERROR \[mudab\.api\] HTTP 500 /);
});

test("a 16 MB plain-text error body ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  const run = await runWithAnswer(500, "text/plain", Buffer.from("x ".repeat(8_000_000)), 128);
  oneErrorRecord(run, "plain text", /ERROR \[mudab\.api\] HTTP 500 /);
});

test("a 16 MB message in an error envelope sent with 200 ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  const run = await runWithAnswer(200, "application/json", Buffer.from(`{"errors":[{"message":"${"x ".repeat(8_000_000)}"}]}`), 128);
  oneErrorRecord(run, "envelope", /ERROR \[mudab\.api\] /);
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap", STARTS_A_PROCESS, async () => {
  // 6 million repairs (36 MB): one `+=` each made a rope node and exhausted a 128 MB heap.
  const n = 6_000_000;
  const run = await runWithAnswer(200, "application/json", Buffer.from(`{"V_STATION_SMALL":[{"STATNAME_ST":"${"\\ud800".repeat(n)}"}]}`), 128);
  assert.notEqual(run.signal, "SIGABRT", "aborted");
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, run.stderr.slice(0, 500));
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  assert.match(run.stderr, new RegExp(`WARN  \\[mudab\\.api\\] POST \\S+: ${n} characters of the answer were not valid text`));
});
