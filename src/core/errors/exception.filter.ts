import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/** Code for errors thrown without one (guards, Nest itself, the throttler). */
export function defaultCode(status: number, message: unknown): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'ACCESS_DENIED';
    case 404:
      return typeof message === 'string' && message.startsWith('Cannot ')
        ? 'ROUTE_NOT_FOUND'
        : 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${String(status)}`;
  }
}

/**
 * Adds `code` to every error response and otherwise leaves it as Nest would
 * send it (same body, status and headers such as Retry-After).
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const body: Record<string, unknown> =
        typeof raw === 'string' ? { statusCode: status, message: raw } : { ...raw };
      if (typeof body['code'] !== 'string') {
        body['code'] = defaultCode(status, body['message']);
      }
      if (status >= 500) {
        this.logger.error(exception.message, exception.stack);
      }
      this.send(response, status, body);
      return;
    }
    this.logger.error(
      exception instanceof Error ? exception.message : 'Unknown error',
      exception instanceof Error ? exception.stack : undefined,
    );
    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      statusCode: 500,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }

  private send(response: Response, status: number, body: Record<string, unknown>): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(status).json(body);
  }
}
