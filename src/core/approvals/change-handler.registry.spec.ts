import { describe, expect, it } from 'vitest';
import { ChangeHandler } from './change-handler';
import { ChangeHandlerRegistry } from './change-handler.registry';

function handler(overrides: Partial<ChangeHandler> = {}): ChangeHandler {
  return {
    entityType: 'widget',
    viewPermission: 'widget.view',
    fields: { price: { label: 'Price', directPermission: 'widget.price.edit' } },
    load: () => Promise.resolve(null),
    validateEdit: (_ctx, _current, proposed) => proposed,
    preview: () => Promise.resolve([]),
    applyEdit: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ChangeHandlerRegistry', () => {
  it('finds a registered handler, limited to its business types', () => {
    const registry = new ChangeHandlerRegistry();
    registry.register(handler({ businessTypes: ['dealership'] }));
    expect(registry.find('widget', 'dealership')?.entityType).toBe('widget');
    expect(registry.find('widget', 'manufacturing')).toBeUndefined();
    expect(registry.find('nothing', 'dealership')).toBeUndefined();
  });

  it('refuses a duplicate, a bad name, a handler with nothing to change, and void without apply', () => {
    const registry = new ChangeHandlerRegistry();
    registry.register(handler());
    expect(() => {
      registry.register(handler());
    }).toThrow('registered twice');
    expect(() => {
      registry.register(handler({ entityType: 'Bad Name' }));
    }).toThrow('Invalid');
    expect(() => {
      registry.register(handler({ entityType: 'empty', fields: {} }));
    }).toThrow('neither edits nor voids');
    expect(() => {
      registry.register(
        handler({ entityType: 'voidable', void: { label: 'Void', directPermission: 'x.void' } }),
      );
    }).toThrow('without applyVoid');
  });
});
