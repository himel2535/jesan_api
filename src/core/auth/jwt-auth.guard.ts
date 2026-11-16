import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { AppRequest } from '../common/request-context';
import { ACCESS_COOKIE } from './auth.constants';
import { readCookie } from './cookies';
import { OriginChecker } from './origin-checker';
import { RevocationList } from './revocation-list';
import { TokenService } from './token.service';

/** Pulls an access token from the cookie or from an `Authorization: Bearer` header. */
export function extractAccessToken(
  request: Request,
): { token: string; viaCookie: boolean } | undefined {
  const cookie = readCookie(request, ACCESS_COOKIE);
  if (cookie) {
    return { token: cookie, viaCookie: true };
  }
  const header = request.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token ? { token, viaCookie: false } : undefined;
  }
  return undefined;
}

/**
 * Global guard: every route needs a valid access token unless marked @Public().
 * It checks the signature and expiry and the in-memory revocation list, with no
 * database query.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly revocation: RevocationList,
    private readonly origins: OriginChecker,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const found = extractAccessToken(request);
    const payload = found ? this.tokens.verifyAccessToken(found.token) : null;
    if (!found || !payload || this.revocation.has(payload.sid)) {
      throw new UnauthorizedException();
    }
    if (found.viaCookie) {
      this.origins.assertAllowed(request);
    }

    request.auth = { userId: payload.sub, sessionId: payload.sid, viaCookie: found.viaCookie };
    return true;
  }
}
