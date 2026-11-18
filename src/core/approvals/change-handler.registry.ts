import { Injectable } from '@nestjs/common';
import { ChangeHandler } from './change-handler';

const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

/** Record types that support change requests; filled in by modules at start-up. */
@Injectable()
export class ChangeHandlerRegistry {
  private readonly handlers = new Map<string, ChangeHandler>();

  register(handler: ChangeHandler): void {
    if (!ENTITY_TYPE_PATTERN.test(handler.entityType)) {
      throw new Error(`Invalid change handler entity type "${handler.entityType}"`);
    }
    if (this.handlers.has(handler.entityType)) {
      throw new Error(`Change handler "${handler.entityType}" is registered twice`);
    }
    if (Object.keys(handler.fields).length === 0 && !handler.void) {
      throw new Error(`Change handler "${handler.entityType}" allows neither edits nor voids`);
    }
    if (handler.void && (!handler.applyVoid || !handler.validateVoid)) {
      throw new Error(`Change handler "${handler.entityType}" declares void without applyVoid`);
    }
    this.handlers.set(handler.entityType, handler);
  }

  /** The handler for a type, if it applies to this kind of business. */
  find(entityType: string, businessType: string): ChangeHandler | undefined {
    const handler = this.handlers.get(entityType);
    if (!handler) {
      return undefined;
    }
    return !handler.businessTypes || handler.businessTypes.includes(businessType)
      ? handler
      : undefined;
  }

  /** Lets tests replace a handler; never used by the app itself. */
  unregister(entityType: string): void {
    this.handlers.delete(entityType);
  }
}
