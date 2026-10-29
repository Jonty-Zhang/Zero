/** Public HTTP diagnostics; the admission flag is only meaningful for 400/409. */
export class HttpError extends Error {
  readonly status: number;
  readonly verificationNotStarted: boolean;
  constructor(message: string, status: number, verificationNotStarted = false) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.verificationNotStarted = verificationNotStarted;
  }
}
