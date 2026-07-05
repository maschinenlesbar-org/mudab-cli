// Response and request types for the MUDAB (Meeresumweltdatenbank) REST API.
//
// The API is a set of "FilterElements" POST endpoints. Each takes a FilterRequest
// body and returns a single-key object wrapping a homogeneous row array. The row
// item shapes below come from the OpenAPI spec, corrected against the live API
// (the spec's response wrapper keys and its Compartment enum are both incomplete).

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
  /** Institute the project station belongs to. */
  INSTITUT?: string;
}

/** `STATION_SMALL` item — a measurement station. */
export interface Messstation {
  metadataid?: number;
  /** Measurement-station name. */
  STATNAME_ST?: string;
  /** Name of the project station this station belongs to. */
  NAME_PS?: string;
  /** Station type. */
  STATIONTYPE_ST?: string;
  /** Compartment code (see {@link Compartment}). */
  COMPT_DS?: Compartment;
}

/** `MV_PARAMETER` (and the compartment-specific variants) item — a measured parameter. */
export interface Parameter {
  metadataid?: number;
  COMPT_DS?: Compartment;
  /** Parameter abbreviation (e.g. "24DP"). */
  PARAMETER?: string;
  /** Parameter group code. */
  PARAMETERGRUPPE?: string;
  /** Parameter name (e.g. "Dichloroprop"). */
  PARAM_NAME?: string;
  /** Parameter group code (duplicate of PARAMETERGRUPPE in practice). */
  PARGROUP?: string;
  /** Parameter-group name (e.g. "Pesticides (general)"). */
  PARAMGROUP_NAME?: string;
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
  /** The measured value (a string in the source data). */
  VALUE_MS?: string;
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
  /** Latitude. */
  ST_LAT?: number;
  /** Longitude. */
  ST_LON?: number;
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
  /** Measured-value label. */
  NAME?: number | string;
  STATION_CODE?: string;
  STATION_NAME?: string;
  /** The value. */
  VALUE?: number;
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
  ST_LAT?: number;
  ST_LON?: number;
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
  and?: FilterCondition;
  or?: FilterCondition;
}

/** Result window: skip `from`, return up to `count` rows. */
export interface Range {
  from?: number;
  count?: number;
}

/** Sort order. */
export interface OrderBy {
  /** Column to sort by. */
  col: string;
  /** Direction (ascending or descending). */
  dir?: "asc" | "desc";
}

/**
 * The request body shared by every MUDAB endpoint. All fields are optional; an
 * empty body returns the whole table (which for measurements is enormous — always
 * send a `range`).
 *
 * IMPORTANT — verified against the live API: only `range` is honoured. Despite the
 * OpenAPI spec advertising every endpoint as a "filterbare Liste", the live server
 * **ignores `filter` and `orderby`** (a filter that should match nothing still
 * returns the full page). They are kept here to mirror the documented schema, but
 * do not rely on them — filter and sort client-side. NB: a `range` MUST include
 * `from` (a count-only range is answered with an HTTP 500).
 */
export interface FilterRequest {
  filter?: Filter;
  range?: Range;
  orderby?: OrderBy;
}
