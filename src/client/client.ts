// MudabClient — a typed client over the MUDAB (Meeresumweltdatenbank) REST API
// (geoportal.bafg.de/mudab/rest/BaseController/FilterElements): marine-monitoring
// data from the German coastal Bundesländer and research institutions.
//
// Every endpoint is a POST that takes a FilterRequest (filter / range / orderby)
// and returns a single-key object wrapping the row array. There is NO auth.
//
//   const c = new MudabClient();
//   await c.stations({ range: { count: 10 } });
//   await c.parameters({ filter: { and: { col: "COMPT_DS", op: "=", value: "CW" } } });

import { RequestEngine, cleanDetail, type EngineOptions } from "./engine.js";
import { MudabParseError, MudabValidationError } from "./errors.js";
import type {
  FilterRequest,
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
 * Check a request's `range` before it is sent: `from`/`count` integers from 0, a
 * `count` only together with a `from` (the server answers a count-only range with
 * HTTP 500), and `from + count` at most {@link MAX_RANGE_END}.
 */
function assertRange(req: FilterRequest | undefined): void {
  const range: unknown = req?.range;
  if (range === undefined) return;
  if (range === null || typeof range !== "object" || Array.isArray(range)) {
    throw new MudabValidationError(
      `Invalid range: expected an object with from and count, got ${JSON.stringify(range)}.`,
    );
  }
  const { from: rawFrom, count: rawCount } = range as Record<string, unknown>;
  const from = rangeInt("range.from", rawFrom);
  const count = rangeInt("range.count", rawCount);
  if (count !== undefined && from === undefined) {
    throw new MudabValidationError(
      "Invalid range: a count needs a from (the server answers a count-only range with HTTP 500), " +
        "e.g. { from: 0, count: 10 }.",
    );
  }
  if (from !== undefined && count !== undefined && from + count > MAX_RANGE_END) {
    throw new MudabValidationError(
      `Invalid range: from + count must not exceed ${MAX_RANGE_END} ` +
        `(the server refuses a larger range end with HTTP 403), got ${from + count}.`,
    );
  }
}

export class MudabClient {
  private readonly engine: RequestEngine;

  constructor(options: MudabClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** POST a FilterRequest to `resource` and return the extracted row array. */
  private async filterList<T>(resource: string, req: FilterRequest = {}): Promise<T[]> {
    assertRange(req);
    const res = await this.engine.postJson<unknown>(resource, req);
    return extractRows<T>(res, resource);
  }

  /** Measurement stations (`STATION_SMALL`). */
  stations(req?: FilterRequest): Promise<Messstation[]> {
    return this.filterList("/STATION_SMALL", req);
  }

  /** Project stations (`PROJECTSTATION_SMALL`). */
  projectStations(req?: FilterRequest): Promise<ProjectStation[]> {
    return this.filterList("/PROJECTSTATION_SMALL", req);
  }

  /**
   * Measured parameters (`MV_PARAMETER`). Pass a compartment to hit the
   * compartment-specific endpoint (`MV_PARAMETER_{BIOLOGIE,BIOTA,WASSER,SEDIMENT}`).
   */
  parameters(req?: FilterRequest, compartment?: ParameterCompartment): Promise<Parameter[]> {
    const resource = compartment ? COMPARTMENT_ENDPOINT[compartment] : "/MV_PARAMETER";
    return this.filterList(resource, req);
  }

  /** Individual station measurements (`MV_STATION_MSMNT`) — a very large table. */
  measurements(req?: FilterRequest): Promise<ParameterValue[]> {
    return this.filterList("/MV_STATION_MSMNT", req);
  }

  /** HELCOM PLC stations (`V_PLC_STATION`). */
  plcStations(req?: FilterRequest): Promise<HelcomPLCStation[]> {
    return this.filterList("/V_PLC_STATION", req);
  }

  /** Parameters measured at PLC stations (`V_GEMESSENE_PARA_PLC`). */
  plcParameters(req?: FilterRequest): Promise<ParameterPLC[]> {
    return this.filterList("/V_GEMESSENE_PARA_PLC", req);
  }

  /** Measured values at PLC stations (`V_MESSWERTE_PLC`). */
  plcMeasurements(req?: FilterRequest): Promise<MesswertPLC[]> {
    return this.filterList("/V_MESSWERTE_PLC", req);
  }
}
