/**
 * HTTP error helper used by every route module.
 *
 * Owned by: Lead. Throw `AppError` (or return a rejected promise containing it)
 * and `app.ts` will serialise `{ error: { code, message, details } }` with the
 * matching status code.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const notFound = (message: string, details?: unknown): AppError =>
  new AppError(404, 'NOT_FOUND', message, details);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'CONFLICT', message, details);

export const upstreamError = (message: string, details?: unknown): AppError =>
  new AppError(502, 'UPSTREAM_ERROR', message, details);

export const notConfigured = (message: string, details?: unknown): AppError =>
  new AppError(400, 'NOT_CONFIGURED', message, details);
