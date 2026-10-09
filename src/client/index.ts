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
} from "./client.js";
export type { CompartmentCode, MudabClientOptions, ParameterCompartment } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  cleartextProblem,
  parseRetryAfter,
  serverTextForMessage,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
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
  redactCredentials,
  cutForMessage,
  MAX_MESSAGE_VALUE_LENGTH,
} from "./errors.js";
export { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
