/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class FlagError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    FLAG_NOT_FOUND: 404,
    FLAG_EXISTS: 409,
    UNKNOWN_ENV: 404,
    INVALID_VALUE: 400,
    INVALID_RULE: 400,
    VALUE_TOO_LARGE: 413,
    INVALID_CURSOR: 400,
    FORBIDDEN: 403,
    ACTOR_REQUIRED: 400,
    CHANGE_NOT_FOUND: 404,
    SELF_APPROVAL: 403,
    CHANGE_STALE: 409,
    CHANGE_CLOSED: 409,
  };

  /**
   * @param {keyof typeof FlagError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'FlagError';
    this.code = code;
    this.statusCode = FlagError.STATUS[code];
    this.details = details;
  }
}
