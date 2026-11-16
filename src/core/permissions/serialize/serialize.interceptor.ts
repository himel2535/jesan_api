import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClassConstructor } from 'class-transformer';
import { Observable, map } from 'rxjs';
import { AppRequest } from '../../common/request-context';
import { serializeForAccess } from './serialize';

const SERIALIZE_KEY = 'serializeWith';

/** Shapes the response with the given class (see @VisibleWith). */
export const SerializeWith = (type: ClassConstructor<unknown>): MethodDecorator & ClassDecorator =>
  SetMetadata(SERIALIZE_KEY, type);

@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const type = this.reflector.getAllAndOverride<ClassConstructor<unknown> | undefined>(
      SERIALIZE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!type) {
      return next.handle();
    }
    // Fails closed: with no access context, every gated field is dropped.
    const permissions =
      context.switchToHttp().getRequest<AppRequest>().access?.permissions ?? new Set<string>();
    return next.handle().pipe(map((data) => serializeForAccess(type, data, permissions)));
  }
}
