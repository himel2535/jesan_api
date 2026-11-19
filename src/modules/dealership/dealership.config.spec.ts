import { describe, expect, it } from 'vitest';
import { parseDealershipConfig } from './dealership.config';

describe('parseDealershipConfig', () => {
  it('reads units, the default unit, code prefixes and the principal supplier', () => {
    const config = parseDealershipConfig({
      units: [
        { key: 'kg', nameEn: 'Kilogram', nameBn: 'কেজি', decimals: 3 },
        { key: 'ton', nameEn: 'Ton', nameBn: 'টন', decimals: 3 },
      ],
      defaultUnit: 'ton',
      codePrefixes: { product: 'RD', customer: 'RC', supplier: 'RS', purchase: 'RP', order: 'RO' },
      creditLimitMode: 'block',
      collectionMethods: ['cash', 'bkash', 'Bad Key', 'cash'],
      timezone: 'Asia/Kolkata',
      backdateLimitDays: 3,
      stockAdjustmentLimit: 25,
      principalSupplier: { nameEn: 'Rod Maker', nameBn: 'রড প্রস্তুতকারক' },
    });
    expect(config.units.map((unit) => unit.key)).toEqual(['kg', 'ton']);
    expect(config.defaultUnitKey).toBe('ton');
    expect(config.codePrefixes).toEqual({
      product: 'RD',
      customer: 'RC',
      supplier: 'RS',
      purchase: 'RP',
      order: 'RO',
      delivery: 'DEL',
      collection: 'COL',
    });
    expect(config.creditLimitMode).toBe('block');
    expect(config.collectionMethods).toEqual(['cash', 'bkash']);
    expect(config).toMatchObject({
      timezone: 'Asia/Kolkata',
      backdateLimitDays: 3,
      stockAdjustmentLimit: 25,
    });
    expect(config.principalSupplier).toEqual({ nameEn: 'Rod Maker', nameBn: 'রড প্রস্তুতকারক' });
  });

  it('still understands the older single-unit shape', () => {
    const config = parseDealershipConfig({
      unit: { key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 },
    });
    expect(config.units).toEqual([{ key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 }]);
    expect(config.defaultUnitKey).toBe('bag');
  });

  it('falls back to safe defaults for missing or broken values', () => {
    const config = parseDealershipConfig({
      units: [{ key: 'Bad Key' }, 'nonsense'],
      defaultUnit: 'nope',
      codePrefixes: { product: 'p-1', customer: '' },
      timezone: 'Mars/Olympus',
      backdateLimitDays: -1,
      stockAdjustmentLimit: 2.5,
    });
    expect(config.units.map((unit) => unit.key)).toEqual(['unit']);
    expect(config.defaultUnitKey).toBe('unit');
    expect(config.codePrefixes).toEqual({
      product: 'P',
      customer: 'C',
      supplier: 'S',
      purchase: 'PUR',
      order: 'ORD',
      delivery: 'DEL',
      collection: 'COL',
    });
    expect(config.creditLimitMode).toBe('warn');
    expect(config.collectionMethods).toEqual(['cash', 'bkash', 'nagad', 'bank', 'cheque']);
    expect(config).toMatchObject({
      timezone: 'Asia/Dhaka',
      backdateLimitDays: 7,
      stockAdjustmentLimit: 10,
    });
    expect(config.principalSupplier).toBeNull();
    expect(parseDealershipConfig(null).units).toHaveLength(1);
  });
});
