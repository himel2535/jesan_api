export const ACCESS_COOKIE = 'jesan_at';
export const REFRESH_COOKIE = 'jesan_rt';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A just-rotated refresh token that shows up again within this window is
 * rejected without ending the session (two tabs refreshing at once). After
 * the window it is treated as a stolen copy and the session is revoked.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** The refresh cookie is only sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Revoked session ids are remembered a little longer than an access token lives. */
export const REVOCATION_TTL_MS = (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000;

export const GENERIC_LOGIN_ERROR = 'Invalid credentials';
