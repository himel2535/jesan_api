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
