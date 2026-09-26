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

import { RequestEngine, type EngineOptions } from "./engine.js";
import { MudabValidationError } from "./errors.js";
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

/**
 * Extract the row array from a MUDAB response. The API always returns a single-key
 * object wrapping the array, but the key is not reliably the path name (e.g.
 * `/STATION_SMALL` -> key `V_STATION_SMALL`), so we take the first array-valued
 * property rather than trusting a fixed key. Returns `[]` for a null/empty reply.
 */
export function extractRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    for (const value of Object.values(res as Record<string, unknown>)) {
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
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
    return extractRows<T>(res);
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
