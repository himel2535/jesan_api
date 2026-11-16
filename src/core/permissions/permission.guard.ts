import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { AppRequest } from '../common/request-context';
import { ANY_MEMBER_KEY, PERMISSION_KEY } from './decorators';

/**
 * Enforces `@RequirePermission(...)`. Business routes that state neither a
 * permission nor `@AnyBusinessMember()` are refused, so a forgotten annotation
 * can never expose data.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSION_KEY,
      targets,
    );
    const { access } = context.switchToHttp().getRequest<AppRequest>();

    if (required && required.length > 0) {
      if (!access || !required.every((key) => access.permissions.has(key))) {
        throw new ForbiddenException('Access denied');
      }
      return true;
    }
    if (access) {
      if (this.reflector.getAllAndOverride<boolean | undefined>(ANY_MEMBER_KEY, targets)) {
        return true;
      }
      throw new ForbiddenException('Access denied');
    }
    return true; // not a business route: signing in is enough
  }
}
