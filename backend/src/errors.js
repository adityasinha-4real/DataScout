/**
 * Every failure leaving the API has the shape { error: { code, message } }.
 * Routes throw AppError; the handler below is the only place that formats it.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required.') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const notFound = (message = 'Resource not found.') =>
  new AppError(404, 'NOT_FOUND', message);
export const conflict = (code, message) => new AppError(409, code, message);
export const payloadTooLarge = (message) =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message);

/** Express 5 error middleware. Must keep all four parameters. */
export function errorHandler(isProduction) {
  return (err, req, res, _next) => {
    const isApp = err instanceof AppError;
    const status = isApp ? err.status : 500;

    const body = {
      error: {
        code: isApp ? err.code : 'INTERNAL_ERROR',
        message: isApp ? err.message : 'Something went wrong on our end.',
      },
    };
    if (isApp && err.details !== undefined) {
      body.error.details = err.details;
    }
    // Stack traces are a development aid only; never ship them to clients.
    if (!isProduction && !isApp && err instanceof Error) {
      body.error.stack = err.stack;
    }
    if (status >= 500 && !isProduction) {
      console.error(err);
    }
    res.status(status).json(body);
  };
}

export function notFoundHandler() {
  return (req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${req.method} ${req.path}.`,
      },
    });
  };
}
