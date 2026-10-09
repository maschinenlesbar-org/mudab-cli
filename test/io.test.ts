// handleOutputErrors (src/cli/io.ts) on fake streams: what a stdout write error logs.
// The process-level pipe behaviour (EPIPE, ENOTCONN) is conformance test P7's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleOutputErrors } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

test("a stdout write error other than a closed pipe is an ERROR record of mudab.output, in the run's format, and exits 1", () => {
  // Only a reader that has gone is a success; EBADF, ENOSPC or EIO means the output is incomplete.
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => exits.push(code), log);
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "mudab.output", msg: "Could not write to stdout: write EBADF" },
  ]);
  assert.deepEqual(written, []);
});

test("without a logger, a stdout write error is a text ERROR record on the streams' stderr", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => exits.push(code));
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /^\S+Z ERROR \[mudab\.output\] Could not write to stdout: write EBADF\n$/);
});
