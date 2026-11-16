import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AppRequest, AuthContext, BusinessAccess } from '../common/request-context';

/** The signed-in user (set by JwtAuthGuard). */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext | undefined =>
    context.switchToHttp().getRequest<AppRequest>().auth,
);

/** The caller's role and permissions in the business of the URL (set by BusinessAccessGuard). */
export const CurrentAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): BusinessAccess | undefined =>
    context.switchToHttp().getRequest<AppRequest>().access,
);
