/** An xAPI request that failed in a way the spec maps to a specific HTTP status. */
export class XapiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'XapiError';
    this.status = status;
    this.code = code;
  }

  static badRequest(message: string, code = 'invalid_request'): XapiError {
    return new XapiError(400, code, message);
  }

  static forbidden(message: string, code = 'forbidden'): XapiError {
    return new XapiError(403, code, message);
  }

  static conflict(message: string, code = 'conflict'): XapiError {
    return new XapiError(409, code, message);
  }

  static preconditionFailed(message: string, code = 'precondition_failed'): XapiError {
    return new XapiError(412, code, message);
  }

  static notFound(message: string, code = 'not_found'): XapiError {
    return new XapiError(404, code, message);
  }
}
