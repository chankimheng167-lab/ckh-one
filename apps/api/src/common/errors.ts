import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InvalidTransitionError, PricingError } from '@ckh/shared';
import { ZodError } from 'zod';
import { NotFoundRowError } from '../db/database.service';

/** Business-rule failure with a stable machine-readable code. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`, HttpStatus.NOT_FOUND);
export const forbidden = (msg = 'You do not have access to this resource') =>
  new DomainError('FORBIDDEN', msg, HttpStatus.FORBIDDEN);
export const conflict = (code: string, msg: string, details?: unknown) =>
  new DomainError(code, msg, HttpStatus.CONFLICT, details);

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const [status, body] = this.map(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(status).json(body);
  }

  private map(e: unknown): [number, ErrorBody] {
    const body = (code: string, message: string, details?: unknown): ErrorBody => ({
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    });

    if (e instanceof DomainError) return [e.status, body(e.code, e.message, e.details)];
    if (e instanceof ZodError) {
      return [400, body('VALIDATION_FAILED', 'Request validation failed', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))];
    }
    if (e instanceof PricingError) return [422, body('PRICING_INVALID', e.message)];
    if (e instanceof InvalidTransitionError) return [409, body('INVALID_STATUS_TRANSITION', e.message)];
    if (e instanceof NotFoundRowError) return [404, body('NOT_FOUND', 'Resource not found')];
    if (e instanceof HttpException) {
      const r = e.getResponse();
      const msg = typeof r === 'string' ? r : (r as any).message ?? e.message;
      return [e.getStatus(), body(HttpStatus[e.getStatus()] ?? 'HTTP_ERROR', Array.isArray(msg) ? msg.join('; ') : msg)];
    }
    // PostgreSQL errors
    const pg = e as { code?: string; constraint?: string; message?: string };
    if (pg && typeof pg.code === 'string') {
      if (pg.code === '23505') return [409, body('DUPLICATE', 'A record with the same unique value already exists', { constraint: pg.constraint })];
      if (pg.code === '23503') return [422, body('INVALID_REFERENCE', 'Referenced record does not exist in this company', { constraint: pg.constraint })];
      if (pg.code === '23514' && pg.constraint === 'stock_levels_no_oversell') return [409, body('INSUFFICIENT_STOCK', pg.message ?? 'Insufficient stock')];
      if (pg.code === '23514') return [422, body('CONSTRAINT_VIOLATION', 'Value not allowed', { constraint: pg.constraint })];
      if (pg.code === '42501') return [403, body('FORBIDDEN', 'Access denied')];
      if (pg.code === '40001' || pg.code === '40P01') return [409, body('CONCURRENT_UPDATE', 'Please retry: the record was changed concurrently')];
      if (pg.code === '22P02') return [400, body('INVALID_INPUT', 'Malformed identifier or value')];
    }
    return [500, body('INTERNAL_ERROR', 'Unexpected server error')];
  }
}
