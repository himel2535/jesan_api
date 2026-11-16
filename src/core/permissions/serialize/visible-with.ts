import { Expose } from 'class-transformer';

const GATED_FIELDS = Symbol('gatedFields');

type GatedFields = Record<string, string>;

/**
 * Marks a response field that is sent only to callers holding `permission`.
 * Anything not declared with @Expose() or @VisibleWith() is never sent at all.
 */
export function VisibleWith(permission: string): PropertyDecorator {
  return (target, propertyKey) => {
    Expose()(target, propertyKey);
    const constructor = target.constructor;
    const existing = (Reflect.getMetadata(GATED_FIELDS, constructor) ?? {}) as GatedFields;
    Reflect.defineMetadata(
      GATED_FIELDS,
      { ...existing, [String(propertyKey)]: permission },
      constructor,
    );
  };
}

export function gatedFieldsOf(constructor: object): GatedFields {
  return (Reflect.getMetadata(GATED_FIELDS, constructor) ?? {}) as GatedFields;
}
