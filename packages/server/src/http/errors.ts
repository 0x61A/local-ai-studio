export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new HttpError(400, code, message, details);
  }
  static unauthorized(message = "Oturum token'i gecersiz veya eksik.") {
    return new HttpError(401, "unauthorized", message);
  }
  static forbidden(code: string, message: string) {
    return new HttpError(403, code, message);
  }
  static notFound(message = "Kaynak bulunamadi.") {
    return new HttpError(404, "not_found", message);
  }
  static conflict(code: string, message: string) {
    return new HttpError(409, code, message);
  }
}
