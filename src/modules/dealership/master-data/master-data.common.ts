import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { BusinessAccess } from '../../../core/common/request-context';

export const PAGE_SIZE = 10;

export interface Actor {
  userId: string;
  ip?: string | undefined;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function requirePermission(access: BusinessAccess, key: string): void {
  if (!access.permissions.has(key)) {
    throw new ForbiddenException('Access denied');
  }
}

/** `active=true|false|all` as a Prisma filter. */
export function activeFilter(active: 'true' | 'false' | 'all'): { isActive?: boolean } {
  return active === 'all' ? {} : { isActive: active === 'true' };
}

/** A change with financial weight must say why. */
export function requireReason(reason: string | undefined): string {
  if (!reason) {
    throw new BadRequestException('A reason is required for this change');
  }
  return reason;
}

export function notFound(what: string): never {
  throw new NotFoundException(`${what} not found`);
}

/** Turns a unique-constraint violation into a 409 with a useful message. */
export function rethrowUnique(error: unknown, messages: Record<string, string>): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const detail = JSON.stringify(error.meta ?? {}) + error.message;
    for (const [hint, message] of Object.entries(messages)) {
      if (detail.includes(hint)) {
        throw new ConflictException(message);
      }
    }
    throw new ConflictException('This record already exists');
  }
  throw error;
}

/** Field-by-field before/after for the audit log; only fields that changed. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  // Values are plain strings, numbers, booleans or null (money as fixed strings).
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  for (const [field, value] of Object.entries(after)) {
    if (value !== undefined && !same(before[field] ?? null, value)) {
      changes[field] = { before: before[field] ?? null, after: value };
    }
  }
  return changes;
}
