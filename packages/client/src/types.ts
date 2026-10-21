// Response and request types for the MUDAB (Meeresumweltdatenbank) REST API.
//
// The API is a set of "FilterElements" POST endpoints. Each takes a FilterRequest
// body and returns a single-key object wrapping a homogeneous row array. The row
// item shapes below come from the OpenAPI spec, corrected against the live API
// (the spec's response wrapper keys and its Compartment enum are both incomplete).
//
// A field typed `| null` is sent as `null` in some real rows (counted on the whole tables on
// 2026-10-21), so a strict consumer has to handle it; the others were never null then.

/**
 * Compartment ("Kompartiment") code, from the `COMPT_DS` field. Common values,
 * verified live: `CW` = Wasser (water), `CS` = Sediment, `CF` = Biota,
 * `BL` = Biologie. Typed as an open string on purpose — the spec's enum is NOT
 * exhaustive (e.g. `MM` also occurs), so a fixed union would reject real data.
 */
export type Compartment = string;

/** `PROJECTSTATION_SMALL` item — a project station. */
export interface ProjectStation {
  metadataid?: number;
  /** Ascending project-station id. */
  PROJECTSTATIONID?: number;
  /** Project-station name. */
  NAME_PS?: string;
  /** Region (e.g. "Nordsee", "Ostsee"). */
  REGION?: string;
  /** Institute the project station belongs to; `null` for some (14 of 1,948 on 2026-10-21). */
  INSTITUT?: string | null;
}

/** `STATION_SMALL` item — a measurement station. */
export interface Messstation {
  metadataid?: number;
  /** Measurement-station name. */
  STATNAME_ST?: string;
  /** Name of the project station this station belongs to. */
  NAME_PS?: string;
  /** Station type; `null` for some rows (2,030 of 83,986 on 2026-10-21). */
  STATIONTYPE_ST?: string | null;
  /** Compartment code (see {@link Compartment}). */
  COMPT_DS?: Compartment;
}

/** `MV_PARAMETER` (and the compartment-specific variants) item — a measured parameter. */
export interface Parameter {
  metadataid?: number;
  COMPT_DS?: Compartment;
  /** Parameter abbreviation (e.g. "24DP"). */
  PARAMETER?: string;
  /** Parameter group code; `null` for a parameter in no group (118 of 889 on 2026-10-21). */
  PARAMETERGRUPPE?: string | null;
  /** Parameter name (e.g. "Dichloroprop"). */
  PARAM_NAME?: string;
  /** Parameter group code (duplicate of PARAMETERGRUPPE in practice, `null` with it). */
  PARGROUP?: string | null;
  /** Parameter-group name (e.g. "Pesticides (general)"); `null` with PARAMETERGRUPPE. */
  PARAMGROUP_NAME?: string | null;
}

/** `MV_STATION_MSMNT` item — a single measured value at a station. */
export interface ParameterValue {
  metadataid?: number;
  /** Measurement-station name. */
  STATNAME_ST?: string;
  /** Composite "<station> <date> <time>". */
  STATNAME_DATE_TIME?: string;
  PARAMETERID_PM?: string;
  /** Parameter code / name. */
  PARAMCODE_PM?: string;
  /** Measurement date, YYYYMMDD. */
  DATE_STM?: string;
  /** Measurement time, HHMM. */
  TIME_STM?: string;
  /** The measured value, a JSON number in live responses. */
  VALUE_MS?: number;
}

/** `V_PLC_STATION` item — a HELCOM PLC (Pollution Load Compilation) station. */
export interface HelcomPLCStation {
  metadataid?: number;
  /** Station name. */
  STATION_NAME?: string;
  /** Station code. */
  STATION_CODE?: string;
  /** Bundesland (federal state) code of the station. */
  LAND_CD?: string;
  /**
   * Latitude; `null` for some stations (the 19 `MUNCP_FL_LD` municipal plants on 2026-10-21; the
   * `UNMONITORED` pseudo-stations have 0/0 instead).
   */
  ST_LAT?: number | null;
  /** Longitude; `null` with ST_LAT. */
  ST_LON?: number | null;
  SUBCM_CODE?: string;
  SUBCM_NAME?: string;
  MON_TYPE?: string;
}

/** `V_GEMESSENE_PARA_PLC` item — a parameter measured at a PLC station. */
export interface ParameterPLC {
  metadataid?: number;
  /** Parameter abbreviation. */
  PARAMETER?: string;
  /** Parameter group. */
  PARAMETERGRUPPE?: string;
  /** Station code. */
  STATION_CODE?: string;
  /** Year of the last measurement. */
  LETZTE_MESSUNG?: string;
  /** Unique id of the measurement, STATION_CODE + PARAMETER. */
  PRKEY?: string;
  STATION_NAME?: string;
  /** Number of measured values. */
  ANZ_MESSWERTE?: number;
  SUBCM_CODE?: string;
  SUBCM_NAME?: string;
}

/** `V_MESSWERTE_PLC` item — a measured value at a PLC station. */
export interface MesswertPLC {
  metadataid?: number;
  /** Running number of the datum. */
  NUMMER?: number;
  /** Measured-value label: the parameter, e.g. "Ntot", "Ptot", "FLOW" (a string in every live row). */
  NAME?: string;
  STATION_CODE?: string;
  STATION_NAME?: string;
  /** The value; `null` when there is none (38 of 19,711 rows on 2026-10-21): drop nulls before arithmetic. */
  VALUE?: number | null;
  /** Aggregation type, "TOT" or "AVE". */
  PARAM_TYPE?: string;
  /** Numeric code for NAME. */
  PARAM_ID?: string;
  /** Year of measurement (for PERIOD_TYPE "A"). */
  PERIOD_NAME?: string;
  /** Aggregation duration, "A". */
  PERIOD_TYPE?: string;
  /** Bundesland (federal state) code. */
  LAND_CD?: string;
  /** The station's latitude; `null` for the stations that have none (see HelcomPLCStation). */
  ST_LAT?: number | null;
  /** The station's longitude; `null` with ST_LAT. */
  ST_LON?: number | null;
  SUBCM_CODE?: string;
  SUBCM_NAME?: string;
  MON_TYPE?: string;
  /** Unit of the value. */
  VAL_UNIT?: string;
  AREA?: number;
}

// --- Request (FilterRequest) ----------------------------------------------------

/** One filter condition: a column, an SQL-ish operator, and a value. */
export interface FilterCondition {
  /** Column name (a field of the endpoint's row schema, e.g. "COMPT_DS"). */
  col: string;
  /** SQL-ish comparison operator (e.g. "=", "like", ">", "<"). */
  op: string;
  /** Comparison value. */
  value: string;
}

/** A filter: a single condition, applied as `and` or `or`. */
export interface Filter {
  and?: FilterCondition | undefined;
  or?: FilterCondition | undefined;
}

/** Result window: skip `from`, return up to `count` rows. */
export interface Range {
  from?: number | undefined;
  count?: number | undefined;
}

/** Sort order. */
export interface OrderBy {
  /** Column to sort by. */
  col: string;
  /** Direction (ascending or descending). */
  dir?: "asc" | "desc" | undefined;
}

/**
 * The request body shared by every MUDAB endpoint. All fields are optional; an
 * empty body returns the whole table (for measurements ~187,000 rows / ~42 MB on
 * 2026-09-15). The client's list methods therefore always send a range — a default
 * page unless the caller passes `{ all: true }` (see {@link ListRequest}).
 *
 * IMPORTANT — verified against the live API: only `range` is honoured. Despite the
 * OpenAPI spec advertising every endpoint as a "filterbare Liste", the live server
 * **ignores `filter` and `orderby`** (a filter that should match nothing still
 * returns the full page). They are kept here to mirror the documented schema, but
 * do not rely on them — filter and sort client-side. NB: the server answers a
 * count-only range with an HTTP 500, so the client's list methods fill in `from: 0`.
 */
export interface FilterRequest {
  filter?: Filter | undefined;
  range?: Range | undefined;
  orderby?: OrderBy | undefined;
}

/**
 * What a list method takes: a {@link FilterRequest} plus `all`, the library's
 * whole-table opt-out. Without `all`, the client completes the `range` to a default
 * page (`from` 0, `count` `DEFAULT_PAGE_SIZE` = 100) before sending it; with
 * `all: true` it sends no range, so the server returns the whole table (for
 * measurements ~187,000 rows / ~42 MB). `all` itself is never sent, and `all: true`
 * together with a `range` is a `MudabValidationError`.
 */
export interface ListRequest extends FilterRequest {
  all?: boolean | undefined;
}
