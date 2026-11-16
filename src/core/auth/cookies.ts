import type { CookieOptions, Request, Response } from 'express';
import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';
import { AuthSettings } from './auth.settings';

function baseOptions(settings: AuthSettings): CookieOptions {
  return {
    httpOnly: true, // scripts in the page can never read the tokens
    secure: settings.secureCookies,
    sameSite: 'lax',
    ...(settings.cookieDomain ? { domain: settings.cookieDomain } : {}),
  };
}

export function setAuthCookies(
  response: Response,
  settings: AuthSettings,
  tokens: { accessToken: string; refreshToken: string },
): void {
  response.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...baseOptions(settings),
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseOptions(settings),
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export function clearAuthCookies(response: Response, settings: AuthSettings): void {
  response.clearCookie(ACCESS_COOKIE, { ...baseOptions(settings), path: '/' });
  response.clearCookie(REFRESH_COOKIE, { ...baseOptions(settings), path: REFRESH_COOKIE_PATH });
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
