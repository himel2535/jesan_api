import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AppRequest } from '../common/request-context';

/**
 * Rate limit per signed-in user instead of per IP address, for endpoints that
 * could be misused to probe data (such as looking up whether a user exists).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: Record<string, unknown>): Promise<string> {
    const req = request as unknown as AppRequest;
    return Promise.resolve(req.auth ? `user:${req.auth.userId}` : `ip:${req.ip ?? 'unknown'}`);
  }
}
