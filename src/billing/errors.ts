/**
 * Typed error for the billing API. Carries an HTTP status and a stable,
 * machine-readable code so callers (and the agent) can branch on `code`
 * without string-matching human messages.
 */
export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }

  static unauthorized(message = "Missing or invalid billing credential."): BillingError {
    return new BillingError(401, "unauthorized", message);
  }

  static notFound(message: string): BillingError {
    return new BillingError(404, "not_found", message);
  }

  static conflict(message: string): BillingError {
    return new BillingError(409, "conflict", message);
  }

  static badRequest(message: string): BillingError {
    return new BillingError(400, "bad_request", message);
  }
}
