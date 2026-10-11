// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/mudab-client/internal/http";
import { MudabClient } from "@maschinenlesbar.org/mudab-client/internal/client";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/mudab-client/test/helpers";

export * from "@maschinenlesbar.org/mudab-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [mudab.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** What the CLI did with one input: exit code, captured output, requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, requests sent. */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  requests: HttpRequest[];
}

/**
 * Send one input through the CLI (`run(argv)`, its client built on a recording mock
 * transport) and through the library (`call(transport)`, typically
 * `new MudabClient({ transport, ... }).method(...)`) on a second recorder with the
 * same responder, and return both outcomes. A synchronous throw from the library call
 * (constructor validation) is captured like a rejection. A parity test asserts that
 * both reject without a request, or both send the same requests.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse([]),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const cliTransport = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (options) => new MudabClient({ ...options, transport: cliTransport.transport }),
  });
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliTransport.calls };

  const libTransport = makeMockTransport(responder);
  let lib: LibOutcome;
  try {
    const value = await call(libTransport.transport);
    lib = { ok: true, value, requests: libTransport.calls };
  } catch (e) {
    const error = e instanceof Error
      ? { name: e.constructor.name, message: e.message }
      : { name: typeof e, message: String(e) };
    lib = { ok: false, error, requests: libTransport.calls };
  }
  return { cli, lib };
}

/** The comparable part of recorded requests: method, URL, headers and the body as text. */
export function requestShapes(calls: HttpRequest[]): { method: string; url: string; headers: unknown; body: string | undefined }[] {
  return calls.map((c) => ({
    method: c.method,
    url: c.url,
    headers: c.headers,
    body: c.body === undefined ? undefined : c.body.toString("utf8"),
  }));
}
