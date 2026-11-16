import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { AppRequest } from '../common/request-context';
import { AccessResolver } from './access-resolver.service';

/**
 * For routes under `/b/:businessSlug/...`: checks on the server that the signed-in
 * user may enter that business, and puts their role and permissions on the request.
 * An unknown business and a business the user may not enter look the same (403),
 * so business slugs cannot be guessed.
 */
@Injectable()
export class BusinessAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: AccessResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const slug: unknown = request.params['businessSlug'];
    if (typeof slug !== 'string') {
      return true; // not a business route
    }
    if (!request.auth) {
      throw new ForbiddenException('Access denied');
    }

    const access = await this.resolver.resolve(request.auth.userId, slug);
    if (!access) {
      throw new ForbiddenException('Access denied');
    }
    request.access = access;
    return true;
  }
}
