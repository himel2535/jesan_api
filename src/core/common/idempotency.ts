import { badRequest } from '../errors';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Checks an optional `Idempotency-Key` header: 8-64 letters, digits, - or _.
 * Sending the same key again returns the first result instead of saving twice.
 */
export function idempotencyKeyOf(value: string | undefined): string | undefined {
  if (value !== undefined && !IDEMPOTENCY_KEY.test(value)) {
    throw badRequest(
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key must be 8-64 letters, digits, - or _',
      'Idempotency-Key',
    );
  }
  return value;
}

/**
 * Like `idempotencyKeyOf`, but the header must be present: used where a
 * repeated request must be provably safe to retry (no optional fallback).
 */
export function requiredIdempotencyKeyOf(value: string | undefined): string {
  if (value === undefined) {
    throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', 'Idempotency-Key');
  }
  idempotencyKeyOf(value);
  return value;
}
