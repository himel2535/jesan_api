import { ClassConstructor, plainToInstance } from 'class-transformer';
import { gatedFieldsOf } from './visible-with';

/** Deletes, in place, every gated field the caller has no permission for. */
function removeForbidden(value: unknown, permissions: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      removeForbidden(item, permissions);
    }
    return;
  }
  if (typeof value !== 'object' || value === null || value instanceof Date) {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [field, permission] of Object.entries(gatedFieldsOf(value.constructor))) {
    if (!permissions.has(permission)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete record[field];
    }
  }
  for (const nested of Object.values(record)) {
    removeForbidden(nested, permissions);
  }
}

/**
 * Builds a response from `data`: only fields declared on the class are kept, and
 * fields marked @VisibleWith are dropped unless the caller holds that permission.
 * The hiding happens here on the server, never only in the browser.
 */
export function serializeForAccess<T>(
  type: ClassConstructor<T>,
  data: unknown,
  permissions: ReadonlySet<string>,
): unknown {
  const instance = plainToInstance(type, data, { excludeExtraneousValues: true });
  removeForbidden(instance, permissions);
  return instance;
}
