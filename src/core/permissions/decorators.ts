import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'requiredPermissions';
export const ANY_MEMBER_KEY = 'anyBusinessMember';

/** The caller must hold every listed permission in the business of the URL. */
export const RequirePermission = (...keys: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, keys);

/**
 * Lets any member of the business in. Business routes without a permission are
 * refused by default, so this has to be stated on purpose.
 */
export const AnyBusinessMember = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ANY_MEMBER_KEY, true);
