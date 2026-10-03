export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Records in another organization are reported as "not found", never "forbidden",
// so a caller cannot learn that an id exists elsewhere.
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in required");
export const forbidden = () => new HttpError(403, "forbidden", "Your role does not allow this action");
export const unprocessable = (message: string) => new HttpError(422, "unprocessable", message);
