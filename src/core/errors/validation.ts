import {
  HttpException,
  HttpStatus,
  ValidationError,
  ValidationPipe,
  ValidationPipeOptions,
} from '@nestjs/common';
import { codeSubject, FieldError } from './app-error';

/** class-validator constraint → problem part of the code. Anything else is INVALID. */
const PROBLEMS: Record<string, string> = {
  isNotEmpty: 'REQUIRED',
  isDefined: 'REQUIRED',
  minLength: 'TOO_SHORT',
  maxLength: 'TOO_LONG',
  arrayMinSize: 'TOO_SHORT',
  arrayMaxSize: 'TOO_LONG',
  min: 'TOO_SMALL',
  max: 'TOO_LARGE',
  whitelistValidation: 'NOT_ALLOWED',
};

export function problemFor(constraint: string): string {
  return PROBLEMS[constraint] ?? 'INVALID';
}

/** One entry per field; REQUIRED wins, otherwise the first broken rule. */
export function fieldErrors(errors: ValidationError[], parent = ''): FieldError[] {
  const result: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const constraints = Object.entries(error.constraints ?? {});
    const chosen = constraints.find(([key]) => problemFor(key) === 'REQUIRED') ?? constraints[0];
    if (chosen) {
      const [name, message] = chosen;
      result.push({ field, code: `${codeSubject(field)}_${problemFor(name)}`, message });
    }
    if (error.children?.length) {
      result.push(...fieldErrors(error.children, field));
    }
  }
  return result;
}

/**
 * Nest's ValidationPipe with the same flat `message` list as before, plus
 * `code: VALIDATION_FAILED` and `errors[]` with a code for every field.
 */
export class AppValidationPipe extends ValidationPipe {
  constructor(options?: ValidationPipeOptions) {
    super(options);
    this.exceptionFactory = (errors: ValidationError[]) => {
      const body = {
        statusCode: 400,
        error: 'Bad Request',
        message: this.flattenValidationErrors(errors),
        code: 'VALIDATION_FAILED',
        errors: fieldErrors(errors),
      };
      return new HttpException(body, HttpStatus.BAD_REQUEST);
    };
  }
}
