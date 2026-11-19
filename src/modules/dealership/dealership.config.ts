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
  codePrefixes: {
    product: string;
    customer: string;
    supplier: string;
    purchase: string;
    order: string;
    delivery: string;
    collection: string;
  };
  principalSupplier: { nameEn: string; nameBn: string } | null;
  /** IANA time zone for business dates (purchase dates, months). */
  timezone: string;
  /** How many days back staff without purchase.edit may date a purchase. */
  backdateLimitDays: number;
  /** Per product, per user, per day: the most stock one may adjust without approval. */
  stockAdjustmentLimit: number;
  /** Over the credit limit on delivery: 'warn' (deliver, flag it) or 'block'. */
  creditLimitMode: 'warn' | 'block';
  /** Ways a customer may pay (keys), e.g. cash, bkash, nagad, bank, cheque. */
  collectionMethods: string[];
}

const DEFAULT_TIMEZONE = 'Asia/Dhaka';

function validTimezone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export const DEFAULT_COLLECTION_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'cheque'];

function methodList(value: unknown): string[] {
  const listed = Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].filter(
        (item) => /^[a-z][a-z0-9_]{0,15}$/.test(item),
      )
    : [];
  return listed.length > 0 ? listed : [...DEFAULT_COLLECTION_METHODS];
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
      purchase: prefix(prefixes['purchase'], 'PUR'),
      order: prefix(prefixes['order'], 'ORD'),
      delivery: prefix(prefixes['delivery'], 'DEL'),
      collection: prefix(prefixes['collection'], 'COL'),
    },
    principalSupplier: principalName
      ? { nameEn: principalName, nameBn: text(principal['nameBn'], principalName) }
      : null,
    timezone: validTimezone(text(config['timezone'], DEFAULT_TIMEZONE)),
    backdateLimitDays: wholeNumber(config['backdateLimitDays'], 7, 0, 3660),
    stockAdjustmentLimit: wholeNumber(config['stockAdjustmentLimit'], 10, 0, 1_000_000),
    creditLimitMode: config['creditLimitMode'] === 'block' ? 'block' : 'warn',
    collectionMethods: methodList(config['collectionMethods']),
  };
}
