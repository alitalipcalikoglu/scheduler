/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class SchedulerError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    JOB_NOT_FOUND: 404,
    JOB_EXISTS: 409,
    RUN_NOT_FOUND: 404,
    RUN_ACTIVE: 409,
    RUN_NOT_CANCELLABLE: 409,
    JOB_DISABLED: 409,
    INVALID_SCHEDULE: 400,
    INVALID_TARGET: 400,
    UNKNOWN_TARGET_KEY: 400,
    BODY_TOO_LARGE: 413,
    INVALID_CURSOR: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof SchedulerError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.statusCode = SchedulerError.STATUS[code];
    this.details = details;
  }
}
