import { Injectable } from '@nestjs/common';
import { badRequest } from '../errors';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

/**
 * argon2id (the library's default algorithm, checked by a test) with the OWASP
 * minimum parameters: 19 MiB of memory, 2 passes, 1 lane.
 */
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real check, so an unknown user cannot be told
   * apart from a wrong password by how long the answer takes.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);
    await this.verify(await this.dummyHash, password);
  }

  /**
   * Length rules plus: the password must not be the user's own email or phone.
   * `field` is the request key the password came in (for the error).
   */
  assertAcceptable(
    password: string,
    personal: { email?: string | null; phone?: string | null },
    field = 'password',
  ) {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw badRequest(
        'PASSWORD_TOO_SHORT',
        `Password must be at least ${String(PASSWORD_MIN_LENGTH)} characters`,
        field,
      );
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      throw badRequest(
        'PASSWORD_TOO_LONG',
        `Password must be at most ${String(PASSWORD_MAX_LENGTH)} characters`,
        field,
      );
    }
    const lowered = password.toLowerCase();
    const own = [personal.email, personal.phone].filter((value): value is string => !!value);
    if (own.some((value) => value.toLowerCase() === lowered)) {
      throw badRequest(
        'PASSWORD_MATCHES_IDENTITY',
        'Password must not be your email or phone number',
        field,
      );
    }
  }
}
