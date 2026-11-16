import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
}

/** Random 256-bit refresh token. Only its hash is ever stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccessToken(userId: string, sessionId: string): string {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId };
    return this.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  }

  /** The payload of a valid, unexpired access token; null otherwise. */
  verifyAccessToken(token: string): AccessTokenPayload | null {
    try {
      const payload = this.jwt.verify<Partial<AccessTokenPayload>>(token, {
        algorithms: ['HS256'],
      });
      return typeof payload.sub === 'string' && typeof payload.sid === 'string'
        ? { sub: payload.sub, sid: payload.sid }
        : null;
    } catch {
      return null;
    }
  }
}
