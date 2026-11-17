/** A unit of measure a business sells in, from its config (Akij: bag). */
export interface DealershipUnit {
  key: string;
  nameEn: string;
  nameBn: string;
  /** Decimal places allowed for quantities (0 = whole numbers). */
  decimals: number;
}

export interface DealershipConfig {
  units: DealershipUnit[];
  defaultUnitKey: string;
  codePrefixes: { product: string; customer: string; supplier: string };
  principalSupplier: { nameEn: string; nameBn: string } | null;
}

const FALLBACK_UNIT: DealershipUnit = { key: 'unit', nameEn: 'Unit', nameBn: 'একক', decimals: 0 };

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function parseUnit(value: unknown): DealershipUnit | null {
  const unit = record(value);
  const key = text(unit['key'], '');
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(key)) {
    return null;
  }
  const decimals = typeof unit['decimals'] === 'number' ? unit['decimals'] : 0;
  return {
    key,
    nameEn: text(unit['nameEn'], key),
    nameBn: text(unit['nameBn'], key),
    decimals: Math.min(3, Math.max(0, Math.trunc(decimals))),
  };
}

/**
 * Reads a dealership business's settings from `businesses.config`. Every value
 * has a safe default, and the older `{ unit: {...} }` shape is still understood,
 * so existing rows keep working.
 */
export function parseDealershipConfig(raw: unknown): DealershipConfig {
  const config = record(raw);
  const listed = Array.isArray(config['units']) ? (config['units'] as unknown[]) : [];
  let units = listed.map(parseUnit).filter((unit): unit is DealershipUnit => unit !== null);
  if (units.length === 0) {
    const legacy = parseUnit(config['unit']);
    units = [legacy ?? FALLBACK_UNIT];
  }
  const requested = text(config['defaultUnit'], '');
  const defaultUnitKey = units.some((unit) => unit.key === requested)
    ? requested
    : (units[0] ?? FALLBACK_UNIT).key;

  const prefixes = record(config['codePrefixes']);
  const prefix = (value: unknown, fallback: string) => {
    const candidate = text(value, fallback);
    return /^[A-Z][A-Z0-9]{0,5}$/.test(candidate) ? candidate : fallback;
  };

  const principal = record(config['principalSupplier']);
  const principalName = text(principal['nameEn'], '');

  return {
    units,
    defaultUnitKey,
    codePrefixes: {
      product: prefix(prefixes['product'], 'P'),
      customer: prefix(prefixes['customer'], 'C'),
      supplier: prefix(prefixes['supplier'], 'S'),
    },
    principalSupplier: principalName
      ? { nameEn: principalName, nameBn: text(principal['nameBn'], principalName) }
      : null,
  };
}
