import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { clearAuthCookies, setAuthCookies } from './cookies';
import { AuthSettings } from './auth.settings';

function fakeResponse() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  return { response: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
}

const settings = (overrides: Partial<AuthSettings>): AuthSettings =>
  ({ secureCookies: false, cookieDomain: undefined, ...overrides }) as AuthSettings;

describe('auth cookies', () => {
  const tokens = { accessToken: 'access', refreshToken: 'refresh' };

  it('are httpOnly and SameSite=Lax, and scope the refresh cookie to the auth endpoints', () => {
    const { response, cookie } = fakeResponse();
    setAuthCookies(response, settings({}), tokens);

    expect(cookie).toHaveBeenCalledWith(
      'jesan_at',
      'access',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', secure: false }),
    );
    expect(cookie).toHaveBeenCalledWith(
      'jesan_rt',
      'refresh',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/api/v1/auth' }),
    );
  });

  it('are Secure in production and carry the shared domain when one is set', () => {
    const { response, cookie } = fakeResponse();
    setAuthCookies(
      response,
      settings({ secureCookies: true, cookieDomain: 'example.com' }),
      tokens,
    );
    for (const call of cookie.mock.calls) {
      expect(call[2]).toMatchObject({ secure: true, domain: 'example.com' });
    }
  });

  it('are cleared with the same scope they were set with', () => {
    const { response, clearCookie } = fakeResponse();
    clearAuthCookies(response, settings({ secureCookies: true, cookieDomain: 'example.com' }));
    expect(clearCookie).toHaveBeenCalledWith(
      'jesan_at',
      expect.objectContaining({ path: '/', domain: 'example.com' }),
    );
    expect(clearCookie).toHaveBeenCalledWith(
      'jesan_rt',
      expect.objectContaining({ path: '/api/v1/auth', domain: 'example.com' }),
    );
  });
});
