/**
 * Uniform error surface for the façade: every PostgREST failure is rethrown
 * as a DbError tagged with the façade operation that issued the query, so
 * engine logs point at the calling site rather than a raw REST payload.
 */

interface PostgrestErrorLike {
  message: string;
  code?: string;
}

export class DbError extends Error {
  readonly op: string;
  /** Postgres/PostgREST error code (e.g. '23505' unique_violation) if known. */
  readonly code: string | undefined;

  constructor(op: string, cause: PostgrestErrorLike) {
    super(`db.${op} failed: ${cause.message}`);
    this.name = 'DbError';
    this.op = op;
    this.code = cause.code;
  }
}

/**
 * Minimal structural view of a PostgREST response. Exported so call sites can
 * re-type embedded-join results: without generated Database types supabase-js
 * infers every embed as an array, but PostgREST returns an object for
 * many-to-one joins, so those queries cast through this shape.
 */
export interface PgResult<T> {
  data: T | null;
  error: PostgrestErrorLike | null;
  /** Present when a query requests an exact PostgREST count. */
  count?: number | null;
}

/** Unwrap a query that must return data (insert/update with .select(), lists). */
export function unwrapRows<T>(op: string, result: PgResult<T>): T {
  if (result.error) throw new DbError(op, result.error);
  if (result.data === null) throw new DbError(op, { message: 'no rows returned' });
  return result.data;
}

/** Unwrap a .maybeSingle() lookup where "not found" is a valid null result. */
export function unwrapMaybe<T>(op: string, result: PgResult<T>): T | null {
  if (result.error) throw new DbError(op, result.error);
  return result.data;
}

/** Unwrap a write that returns no rows; only the error channel matters. */
export function assertOk(op: string, result: { error: PostgrestErrorLike | null }): void {
  if (result.error) throw new DbError(op, result.error);
}
