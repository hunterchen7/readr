export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(message = "Not found") {
  return new AppError(404, message);
}

export function badRequest(message = "Bad request") {
  return new AppError(400, message);
}

export function forbidden(message = "Forbidden") {
  return new AppError(403, message);
}

export function conflict(message = "Conflict") {
  return new AppError(409, message);
}

export function payloadTooLarge(message = "Payload too large") {
  return new AppError(413, message);
}
