// Public entry point for the API client library.

export {
  MudabClient,
  extractRows,
  reportedErrors,
  WRAPPER_KEYS,
  normalizeRange,
  DEFAULT_PAGE_SIZE,
  MAX_RANGE_END,
  PARAMETER_COMPARTMENTS,
  COMPARTMENT_CODES,
  compartmentProblem,
} from "./client.js";
export type { CompartmentCode, MudabClientOptions, ParameterCompartment } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  cleartextProblem,
  parseRetryAfter,
  quoteServerText,
  serverTextForMessage,
} from "./engine.js";
export type { EngineOptions, RawResponse, RetryEvent } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export {
  MudabError,
  MudabApiError,
  MudabNetworkError,
  MudabValidationError,
  MudabParseError,
  redactUrl,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  cutForMessage,
  cutText,
  toWellFormed,
  quoteValue,
  MAX_MESSAGE_VALUE_LENGTH,
} from "./errors.js";
export {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  listProblem,
  normalizeToken,
  splitList,
  tokenProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export {
  findStations,
  findParameters,
  getMeasurements,
  getRiverLoads,
  listRows,
  readPages,
  resolveCompartment,
  unitOf,
  fold,
  TABLES,
  TABLE_PATHS,
  PAGE_ROWS,
  DEFAULT_MAX_PAGES,
  STATION_KINDS,
  PLC_KINDS,
  LOAD_GROUPS,
  MEASUREMENT_PARAMETERS,
  MEASUREMENTS_CACHE_MS,
  PLC_PARAMETERS,
} from "./operations.js";
export type {
  Ambiguous,
  FindStationsInput,
  FindParametersInput,
  GetMeasurementsInput,
  GetRiverLoadsInput,
  ListRowsInput,
  LoadGroup,
  LoadRow,
  LoadTotal,
  LoadsAnswer,
  LoadsSearched,
  MeasurementParameterSummary,
  MeasurementSeries,
  MeasurementValue,
  MeasurementsAnswer,
  MeasurementsSearched,
  MeasurementStation,
  PagesRead,
  ParameterEntry,
  ParameterSearch,
  ParametersSearched,
  PlcKind,
  PlcParameterEntry,
  PlcStationEntry,
  ProjectStationEntry,
  RowsAnswer,
  StationKind,
  StationSearch,
  StationsSearched,
  TableName,
} from "./operations.js";

export * from "./types.js";
