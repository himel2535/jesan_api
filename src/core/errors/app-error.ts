import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Machine-readable errors. Every error body keeps Nest's shape
 * (`statusCode`, `error`, `message`) and adds a stable `code`; errors about
 * one input also carry `field` and `errors[]`. The frontend chooses the text
 * to show from `code`, never from `message` (English, for developers).
 *
 * Naming: UPPER_SNAKE `<SUBJECT>_<PROBLEM>` (see CLAUDE.md). A published code
 * never changes meaning. Never put personal data or another business's ids
 * or names in a code, field or message.
 */
export interface FieldError {
  /** Request key; dotted path for nested values (`proposedChange.creditLimit`). */
  field: string;
  code: string;
  message: string;
}

export interface ErrorBody {
  statusCode: number;
  error?: string;
  message: string | string[];
  code: string;
  field?: string;
  errors?: FieldError[];
}

const PHRASES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function phraseFor(status: number): string | undefined {
  return PHRASES[status];
}

/** `nameEn` → `NAME_EN`, `proposedChange.creditLimit` → `CREDIT_LIMIT`, `Idempotency-Key` → `IDEMPOTENCY_KEY`. */
export function codeSubject(field: string): string {
  const last = field.split('.').pop() ?? field;
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** The response body for one coded error. */
export function errorBody(
  status: number,
  code: string,
  message: string,
  field?: string,
): ErrorBody {
  return {
    statusCode: status,
    error: phraseFor(status),
    message,
    code,
    ...(field ? { field, errors: [{ field, code, message }] } : {}),
  };
}

// Nest's own exception classes, so `instanceof BadRequestException` still holds.
export const badRequest = (code: string, message: string, field?: string) =>
  new BadRequestException(errorBody(HttpStatus.BAD_REQUEST, code, message, field));
export const unauthorized = (code: string, message: string) =>
  new UnauthorizedException(errorBody(HttpStatus.UNAUTHORIZED, code, message));
export const forbidden = (code: string, message: string, field?: string) =>
  new ForbiddenException(errorBody(HttpStatus.FORBIDDEN, code, message, field));
export const notFoundError = (code: string, message: string, field?: string) =>
  new NotFoundException(errorBody(HttpStatus.NOT_FOUND, code, message, field));
export const conflict = (code: string, message: string, field?: string) =>
  new ConflictException(errorBody(HttpStatus.CONFLICT, code, message, field));
