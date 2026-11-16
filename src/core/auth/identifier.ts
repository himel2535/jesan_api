/** Emails are stored lowercase (the database enforces it). */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalizes a phone number to E.164. Bangladeshi numbers may be written
 * `01XXXXXXXXX`, `8801XXXXXXXXX` or `+8801XXXXXXXXX`. Returns null when the
 * value cannot be a phone number.
 */
export function normalizePhone(value: string): string | null {
  const compact = value.replace(/[\s\-().]/g, '');
  let candidate: string;
  if (/^01\d{9}$/.test(compact)) {
    candidate = `+880${compact.slice(1)}`;
  } else if (/^8801\d{9}$/.test(compact)) {
    candidate = `+${compact}`;
  } else {
    candidate = compact;
  }
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

export type LoginIdentifier = { email: string } | { phone: string } | null;

/** Sign-in accepts an email or a phone number in one field. */
export function parseLoginIdentifier(value: string): LoginIdentifier {
  if (value.includes('@')) {
    return { email: normalizeEmail(value) };
  }
  const phone = normalizePhone(value);
  return phone ? { phone } : null;
}
