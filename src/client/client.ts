// MudabClient — a typed client over the MUDAB (Meeresumweltdatenbank) REST API
// (geoportal.bafg.de/mudab/rest/BaseController/FilterElements): marine-monitoring
// data from the German coastal Bundesländer and research institutions.
//
// Every endpoint is a POST that takes a FilterRequest (filter / range / orderby)
// and returns a single-key object wrapping the row array. There is NO auth. Only
// `range` is honoured, and it needs a `from` (the server ignores filter/orderby,
// and answers a count-only range with HTTP 500, so the client fills from 0);
// filter the rows yourself. Without
// a range the server returns the WHOLE table, so every list method sends a default
// page (from 0, count DEFAULT_PAGE_SIZE = 100) unless asked for `{ all: true }`.
//
//   const c = new MudabClient();
//   await c.stations({ range: { from: 0, count: 10 } });
//   const water = await c.parameters({ range: { from: 0, count: 100 } }, "wasser");
//   const cw = (await c.parameters({ all: true })).filter((p) => p.COMPT_DS === "CW"); // whole table

import { RequestEngine, cleanDetail, type EngineOptions } from "./engine.js";
import { MudabParseError, MudabValidationError } from "./errors.js";
import type {
  Compartment,
  FilterRequest,
  ListRequest,
  HelcomPLCStation,
  Messstation,
  MesswertPLC,
  Parameter,
  ParameterPLC,
  ParameterValue,
  ProjectStation,
} from "./types.js";

/** Options for the MUDAB client (engine options only — the API needs no auth). */
export type MudabClientOptions = EngineOptions;

/** The four compartment-specific parameter endpoints. */
export type ParameterCompartment = "biologie" | "biota" | "wasser" | "sediment";

const COMPARTMENT_ENDPOINT: Record<ParameterCompartment, string> = {
  biologie: "/MV_PARAMETER_BIOLOGIE",
  biota: "/MV_PARAMETER_BIOTA",
  wasser: "/MV_PARAMETER_WASSER",
  sediment: "/MV_PARAMETER_SEDIMENT",
};

/** The compartments `parameters()` accepts, in the order the CLI lists them. */
export const PARAMETER_COMPARTMENTS: readonly ParameterCompartment[] = ["biologie", "biota", "wasser", "sediment"];

/** One row of the compartment code table: a `COMPT_DS` code, its label and its `parameters()` endpoint. */
export interface CompartmentCode {
  /** The `COMPT_DS` code as it appears in the rows. */
  readonly code: Compartment;
  /** Human-readable label (German, with the English in brackets where it differs). */
  readonly label: string;
  /** The compartment to pass to `parameters(req, compartment)` for this code's parameters. */
  readonly parameterCompartment: ParameterCompartment;
}

/**
 * The compartment (`COMPT_DS`) code table, verified live. NOTE: this is NOT
 * exhaustive — the API also returns codes outside the documented set (e.g. `MM`).
 * The CLI's `compartments` command prints it as is.
 */
export const COMPARTMENT_CODES: readonly CompartmentCode[] = Object.freeze([
  Object.freeze({ code: "CW", label: "Wasser (water)", parameterCompartment: "wasser" }),
  Object.freeze({ code: "CS", label: "Sediment", parameterCompartment: "sediment" }),
  Object.freeze({ code: "CF", label: "Biota", parameterCompartment: "biota" }),
  Object.freeze({ code: "BL", label: "Biologie (biology)", parameterCompartment: "biologie" }),
] as const);

/**
 * The endpoint of a compartment. The lookup checks own keys only, so an unknown
 * value (`"WASSER"`, or `"toString"`/`"__proto__"`, which a plain object inherits)
 * is a `MudabValidationError`, not a TypeError from deep inside the engine.
 */
function compartmentEndpoint(compartment: unknown): string {
  if (typeof compartment === "string" && Object.hasOwn(COMPARTMENT_ENDPOINT, compartment)) {
    return COMPARTMENT_ENDPOINT[compartment as ParameterCompartment];
  }
  throw new MudabValidationError(
    `Invalid compartment: expected one of ${PARAMETER_COMPARTMENTS.join(", ")}, got ` +
      `${typeof compartment === "string" ? JSON.stringify(compartment) : String(compartment)}.`,
  );
}

/** Name what came back instead of the row wrapper, for the shape error. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "an empty object";
  const shown = keys
    .slice(0, 5)
    .map((k) => JSON.stringify(k.length > 40 ? `${k.slice(0, 40)}…` : k))
    .join(", ");
  let text = `an object with the key${keys.length === 1 ? "" : "s"} ${shown}${keys.length > 5 ? ", …" : ""}`;
  // An error object delivered with status 200 (e.g. {"message": "ORA-00942: ..."}):
  // show its message, so the failure reads as one rather than as "no data".
  const record = value as Record<string, unknown>;
  for (const key of ["detail", "message", "error"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim() !== "") {
      text += ` (${key}: ${JSON.stringify(cleanDetail(raw))})`;
      break;
    }
  }
  return text;
}

/**
 * Extract the row array from a MUDAB response. The API returns a single-key object
 * wrapping the array, but the key is not reliably the path name (e.g.
 * `/STATION_SMALL` -> key `V_STATION_SMALL`), so any one key is accepted; a bare
 * array is taken as is. Anything else — an error object sent with status 200, a
 * second key, `null`, a string — throws a `MudabParseError` naming what came back,
 * so a server-side failure never reads as an empty result.
 */
export function extractRows<T>(res: unknown, path = "the API"): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res !== null && typeof res === "object") {
    const keys = Object.keys(res);
    const only = keys.length === 1 ? (res as Record<string, unknown>)[keys[0] as string] : undefined;
    if (Array.isArray(only)) return only as T[];
  }
  throw new MudabParseError(
    `Unexpected response shape from ${path}: expected a JSON object wrapping one row array, ` +
      `got ${describeShape(res)}.`,
  );
}

/**
 * The largest end of a range (`from + count`) the server accepts: 2^31 - 1. It
 * computes the end as a 32-bit integer, and its front end answers anything larger
 * with an HTML 403 Forbidden (seen live on 2026-09-26, after which the host stopped
 * answering the client for a while).
 */
export const MAX_RANGE_END = 2_147_483_647;

function rangeInt(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_RANGE_END) {
    throw new MudabValidationError(
      `Invalid ${name}: expected an integer from 0 to ${MAX_RANGE_END}, got ${typeof value === "string" ? JSON.stringify(value) : String(value)}.`,
    );
  }
  return value;
}

/**
 * Rows a list method asks for when the request sets no `count`. MUDAB answers a
 * request without a range with the WHOLE table (measurements ~187,000 rows / ~42 MB
 * on 2026-09-15), so the client always sends a page unless the caller opts out
 * with `{ all: true }`.
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * The request body a list method sends for `req`, checked before anything is sent.
 *
 * - `{ all: true }` sends no range (the whole table); `all` together with a `range`,
 *   or an `all` that is not a boolean, is a `MudabValidationError`.
 * - Otherwise the range is completed to a page: a missing `count` becomes
 *   {@link DEFAULT_PAGE_SIZE} and a missing `from` becomes 0 (the server answers a
 *   count-only range with HTTP 500, so `from` is always sent).
 * - `from`/`count` must be integers from 0, and `from + count` must not exceed
 *   {@link MAX_RANGE_END}, defaulted count included.
 *
 * `filter`/`orderby` are passed through (the server ignores them); `all` is never
 * sent. Idempotent for a request without `all`.
 */
export function normalizeRange(req: ListRequest = {}): FilterRequest {
  const { all, ...body } = req;
  if (all !== undefined && typeof all !== "boolean") {
    throw new MudabValidationError(
      `Invalid all: expected a boolean, got ${typeof all === "string" ? JSON.stringify(all) : String(all)}.`,
    );
  }
  const range: unknown = body.range;
  if (all === true) {
    if (range !== undefined) {
      throw new MudabValidationError(
        "Invalid range: all (the whole table) cannot be combined with a range.",
      );
    }
    return body;
  }
  if (range === undefined) return { ...body, range: { from: 0, count: DEFAULT_PAGE_SIZE } };
  if (range === null || typeof range !== "object" || Array.isArray(range)) {
    throw new MudabValidationError(
      `Invalid range: expected an object with from and count, got ${JSON.stringify(range)}.`,
    );
  }
  const { from: rawFrom, count: rawCount } = range as Record<string, unknown>;
  const from = rangeInt("range.from", rawFrom);
  const givenCount = rangeInt("range.count", rawCount);
  const count = givenCount ?? DEFAULT_PAGE_SIZE;
  const start = from ?? 0;
  if (start + count > MAX_RANGE_END) {
    throw new MudabValidationError(
      `Invalid range: from + count${givenCount === undefined ? ` (count defaults to ${DEFAULT_PAGE_SIZE})` : ""} ` +
        `must not exceed ${MAX_RANGE_END} (the server refuses a larger range end with HTTP 403), ` +
        `got ${start + count}.`,
    );
  }
  return { ...body, range: { from: start, count } };
}

/**
 * One method per MUDAB endpoint. Each list method takes a {@link ListRequest}: the
 * range is completed to a default page ({@link normalizeRange}), `{ all: true }`
 * fetches the whole table, and a bad range rejects with a `MudabValidationError`
 * before any request.
 */
export class MudabClient {
  private readonly engine: RequestEngine;

  constructor(options: MudabClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * POST the request to `resource` (completed to a default page by
   * {@link normalizeRange}, or with no range for `{ all: true }`) and return the
   * extracted row array.
   */
  private async filterList<T>(resource: string, req: ListRequest = {}): Promise<T[]> {
    const body = normalizeRange(req);
    const res = await this.engine.postJson<unknown>(resource, body);
    return extractRows<T>(res, resource);
  }

  /** Measurement stations (`STATION_SMALL`). */
  stations(req?: ListRequest): Promise<Messstation[]> {
    return this.filterList("/STATION_SMALL", req);
  }

  /** Project stations (`PROJECTSTATION_SMALL`). */
  projectStations(req?: ListRequest): Promise<ProjectStation[]> {
    return this.filterList("/PROJECTSTATION_SMALL", req);
  }

  /**
   * Measured parameters (`MV_PARAMETER`). Pass a compartment to hit the
   * compartment-specific endpoint (`MV_PARAMETER_{BIOLOGIE,BIOTA,WASSER,SEDIMENT}`);
   * any other value rejects with a `MudabValidationError` before a request is made.
   */
  async parameters(req?: ListRequest, compartment?: ParameterCompartment): Promise<Parameter[]> {
    const resource = compartment === undefined ? "/MV_PARAMETER" : compartmentEndpoint(compartment);
    return this.filterList(resource, req);
  }

  /** Individual station measurements (`MV_STATION_MSMNT`) — a very large table. */
  measurements(req?: ListRequest): Promise<ParameterValue[]> {
    return this.filterList("/MV_STATION_MSMNT", req);
  }

  /** HELCOM PLC stations (`V_PLC_STATION`). */
  plcStations(req?: ListRequest): Promise<HelcomPLCStation[]> {
    return this.filterList("/V_PLC_STATION", req);
  }

  /** Parameters measured at PLC stations (`V_GEMESSENE_PARA_PLC`). */
  plcParameters(req?: ListRequest): Promise<ParameterPLC[]> {
    return this.filterList("/V_GEMESSENE_PARA_PLC", req);
  }

  /** Measured values at PLC stations (`V_MESSWERTE_PLC`). */
  plcMeasurements(req?: ListRequest): Promise<MesswertPLC[]> {
    return this.filterList("/V_MESSWERTE_PLC", req);
  }
}
