import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { describe, expect, it } from 'vitest';
import { badRequest, codeSubject, conflict, notFoundError } from './app-error';
import { AppExceptionFilter, defaultCode } from './exception.filter';
import { AppValidationPipe, problemFor } from './validation';

class AddressDto {
  @IsString()
  @MaxLength(5)
  line!: string;
}

class SampleDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(10)
  note!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+8801\d{9}$/)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true, transform: true };
const metadata = { type: 'body' as const, metatype: SampleDto };

async function failure(pipe: ValidationPipe, value: unknown) {
  try {
    await pipe.transform(value, metadata);
  } catch (error) {
    return (error as HttpException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a validation error');
}

function fakeHost() {
  const sent: { status?: number; body?: unknown; ended?: boolean } = {};
  const response = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
    end() {
      sent.ended = true;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('error codes', () => {
  it('turns a request key into the subject of a code', () => {
    expect(codeSubject('phone')).toBe('PHONE');
    expect(codeSubject('nameEn')).toBe('NAME_EN');
    expect(codeSubject('proposedChange.creditLimit')).toBe('CREDIT_LIMIT');
    expect(codeSubject('Idempotency-Key')).toBe('IDEMPOTENCY_KEY');
    expect(codeSubject('Product')).toBe('PRODUCT');
  });

  it('builds a body with code, field and errors, keeping Nest’s classes', () => {
    const error = badRequest('PHONE_INVALID', 'Phone number is not valid', 'phone');
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Phone number is not valid',
      code: 'PHONE_INVALID',
      field: 'phone',
      errors: [{ field: 'phone', code: 'PHONE_INVALID', message: 'Phone number is not valid' }],
    });
    expect(conflict('STALE_REQUEST', 'stale')).toBeInstanceOf(ConflictException);
    expect(notFoundError('PRODUCT_NOT_FOUND', 'Product not found').getResponse()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Product not found',
      code: 'PRODUCT_NOT_FOUND',
    });
  });
});

describe('AppValidationPipe', () => {
  const pipe = new AppValidationPipe(OPTIONS);
  const plain = new ValidationPipe(OPTIONS);

  it('keeps exactly the message list Nest would send', async () => {
    const inputs = [
      {},
      { note: 'x', phone: '017', isActive: 'yes' },
      { note: 'fine note', extra: 1 },
      { note: 'fine note', address: { line: 'far too long' } },
    ];
    for (const input of inputs) {
      const ours = await failure(pipe, input);
      const nests = await failure(plain, input);
      expect(ours['message']).toEqual(nests['message']);
      expect(ours).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    }
  });

  it('adds one code per field, REQUIRED first', async () => {
    const missing = await failure(pipe, {});
    expect(missing['code']).toBe('VALIDATION_FAILED');
    expect(missing['errors']).toEqual([
      { field: 'note', code: 'NOTE_REQUIRED', message: 'note should not be empty' },
    ]);

    const wrong = await failure(pipe, { note: 'x', phone: '017', isActive: 'yes' });
    expect((wrong['errors'] as { field: string; code: string }[]).map((e) => e.code)).toEqual([
      'NOTE_TOO_SHORT',
      'PHONE_INVALID',
      'IS_ACTIVE_INVALID',
    ]);
  });

  it('names unknown and nested fields', async () => {
    const extra = await failure(pipe, { note: 'fine note', extra: 1 });
    expect(extra['errors']).toEqual([
      expect.objectContaining({ field: 'extra', code: 'EXTRA_NOT_ALLOWED' }),
    ]);
    const nested = await failure(pipe, { note: 'fine note', address: { line: 'far too long' } });
    expect(nested['errors']).toEqual([
      expect.objectContaining({ field: 'address.line', code: 'LINE_TOO_LONG' }),
    ]);
  });

  it('maps constraints to the fixed problem words', () => {
    expect(problemFor('isNotEmpty')).toBe('REQUIRED');
    expect(problemFor('isDefined')).toBe('REQUIRED');
    expect(problemFor('minLength')).toBe('TOO_SHORT');
    expect(problemFor('maxLength')).toBe('TOO_LONG');
    expect(problemFor('min')).toBe('TOO_SMALL');
    expect(problemFor('max')).toBe('TOO_LARGE');
    expect(problemFor('whitelistValidation')).toBe('NOT_ALLOWED');
    for (const other of ['isString', 'matches', 'isUUID', 'isIn', 'isEmail', 'somethingNew']) {
      expect(problemFor(other)).toBe('INVALID');
    }
  });
});

describe('AppExceptionFilter', () => {
  const filter = new AppExceptionFilter();

  it('adds a default code by status and keeps the rest of the body', () => {
    const cases: [unknown, number, string][] = [
      [new UnauthorizedException(), 401, 'UNAUTHENTICATED'],
      [new NotFoundException('Cannot GET /api/v1/nope'), 404, 'ROUTE_NOT_FOUND'],
      [new ThrottlerException(), 429, 'RATE_LIMITED'],
      [new ServiceUnavailableException('Database is not configured'), 503, 'SERVICE_UNAVAILABLE'],
      [new HttpException('Teapot', 418), 418, 'HTTP_418'],
    ];
    for (const [exception, status, code] of cases) {
      const { host, sent } = fakeHost();
      filter.catch(exception, host);
      expect(sent.status).toBe(status);
      expect(sent.body).toMatchObject({ statusCode: status, code });
    }
    const { host, sent } = fakeHost();
    filter.catch(new NotFoundException('User not found'), host);
    expect(sent.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'User not found',
      code: 'NOT_FOUND',
    });
  });

  it('never replaces a code that is already there', () => {
    const { host, sent } = fakeHost();
    filter.catch(conflict('STALE_REQUEST', 'stale'), host);
    expect(sent.body).toMatchObject({ statusCode: 409, code: 'STALE_REQUEST' });
  });

  it('answers unknown errors with a plain 500 and no details', () => {
    const { host, sent } = fakeHost();
    filter.catch(new Error('secret detail from deep inside'), host);
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('maps statuses to default codes', () => {
    expect(defaultCode(400, 'x')).toBe('BAD_REQUEST');
    expect(defaultCode(403, 'Access denied')).toBe('ACCESS_DENIED');
    expect(defaultCode(409, 'x')).toBe('CONFLICT');
    expect(defaultCode(502, 'x')).toBe('INTERNAL_ERROR');
  });
});
