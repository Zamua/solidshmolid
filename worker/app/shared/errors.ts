// Outcomes the pod service reports instead of a result. The runtime maps each
// to its HTTP status; nothing below the runtime knows status codes.

export class PodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFound extends PodError {}
/** The request is malformed (bad path, unparseable body). */
export class BadRequest extends PodError {}
/** No credentials, and the anonymous agent lacks access. */
export class Unauthenticated extends PodError {}
/** Credentials, but the agent lacks access. */
export class Forbidden extends PodError {}
export class Conflict extends PodError {}
export class PreconditionFailed extends PodError {}
export class UnsupportedMediaType extends PodError {}
export class NotAcceptable extends PodError {}
export class Unprocessable extends PodError {}
export class PayloadTooLarge extends PodError {}

export class MethodNotAllowed extends PodError {
  constructor(
    message: string,
    readonly allow: string[],
  ) {
    super(message);
  }
}

export class RangeNotSatisfiable extends PodError {
  constructor(readonly size: number) {
    super('requested range not satisfiable');
  }
}

/** The user's storage refused or failed; `retryAfter` in seconds when known. */
export class StorageUnavailable extends PodError {
  constructor(
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** The user's storage is full. */
export class InsufficientStorage extends PodError {}
