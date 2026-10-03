// Public entry point for the API client library.

export {
  MudabClient,
  extractRows,
  normalizeRange,
  DEFAULT_PAGE_SIZE,
  MAX_RANGE_END,
  PARAMETER_COMPARTMENTS,
} from "./client.js";
export type { MudabClientOptions, ParameterCompartment } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
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
} from "./errors.js";
export { assertValid } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
