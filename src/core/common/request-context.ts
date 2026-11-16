import type { Request } from 'express';

/** Who is calling: set by JwtAuthGuard. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** True when the token came from a cookie (needs the CSRF origin check). */
  viaCookie: boolean;
}

export interface AccessRole {
  id: string;
  key: string;
  nameEn: string;
  nameBn: string;
}

/** What the caller may do inside one business: set by BusinessAccessGuard. */
export interface BusinessAccess {
  businessId: string;
  businessSlug: string;
  businessType: string;
  role: AccessRole | null;
  isPlatformOwner: boolean;
  permissions: ReadonlySet<string>;
}

export interface AppRequest extends Request {
  auth?: AuthContext;
  access?: BusinessAccess;
}
