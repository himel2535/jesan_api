/**
 * Business-data isolation for Prisma.
 *
 * Modules register the models that hold business data. For those models every
 * query must be limited to one business:
 *  - the default client (PrismaService.client) refuses any query whose
 *    where/data lacks a businessId (a forgotten filter fails loudly), and
 *  - the scoped client (PrismaService.forBusiness(id)) adds the businessId to
 *    every query by itself, and refuses a different one.
 *
 * Raw SQL ($queryRaw, $executeRaw) is not covered: raw SQL on business data
 * must filter on business_id itself.
 */

const tenantModels = new Set<string>();

/** Called by modules at start-up, e.g. registerTenantModels(['Product']). */
export function registerTenantModels(models: readonly string[]): void {
  for (const model of models) {
    tenantModels.add(model);
  }
}

export function isTenantModel(model: string | undefined): boolean {
  return model !== undefined && tenantModels.has(model);
}

export class TenantScopeError extends Error {
  constructor(model: string, operation: string, problem: string) {
    super(`Business data isolation: ${model}.${operation} ${problem}`);
    this.name = 'TenantScopeError';
  }
}

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

type Args = Record<string, unknown>;

function asRecord(value: unknown): Args {
  return typeof value === 'object' && value !== null ? (value as Args) : {};
}

function rowsOf(data: unknown): Args[] {
  return (Array.isArray(data) ? (data as unknown[]) : [data]).map(asRecord);
}

/** Throws unless the query is limited to exactly one business. */
export function assertTenantScoped(model: string, operation: string, args: unknown): void {
  const record = asRecord(args);

  if (CREATE_OPERATIONS.has(operation)) {
    if (rowsOf(record['data']).some((row) => typeof row['businessId'] !== 'string')) {
      throw new TenantScopeError(model, operation, 'without data.businessId');
    }
    return;
  }

  const businessId = asRecord(record['where'])['businessId'];
  if (typeof businessId !== 'string') {
    throw new TenantScopeError(model, operation, 'without where.businessId');
  }
  if (operation === 'upsert' && asRecord(record['create'])['businessId'] !== businessId) {
    throw new TenantScopeError(model, operation, 'with a create.businessId of another business');
  }
  const moved = asRecord(record[operation === 'upsert' ? 'update' : 'data'])['businessId'];
  if ((UPDATE_OPERATIONS.has(operation) || operation === 'upsert') && moved !== undefined) {
    if (moved !== businessId) {
      throw new TenantScopeError(model, operation, 'cannot move a row to another business');
    }
  }
}

/** Returns the arguments with the business filled in everywhere it belongs. */
export function scopeTenantArgs(
  businessId: string,
  model: string,
  operation: string,
  args: unknown,
): Args {
  const record = { ...asRecord(args) };
  const claim = (value: unknown, where: string): void => {
    if (value !== undefined && value !== businessId) {
      throw new TenantScopeError(model, operation, `with ${where} of another business`);
    }
  };

  if (CREATE_OPERATIONS.has(operation)) {
    const rows = rowsOf(record['data']).map((row) => {
      claim(row['businessId'], 'data.businessId');
      return { ...row, businessId };
    });
    record['data'] = Array.isArray(record['data']) ? rows : rows[0];
    return record;
  }

  const where = asRecord(record['where']);
  claim(where['businessId'], 'where.businessId');
  record['where'] = { ...where, businessId };

  if (operation === 'upsert') {
    const create = asRecord(record['create']);
    claim(create['businessId'], 'create.businessId');
    record['create'] = { ...create, businessId };
    claim(asRecord(record['update'])['businessId'], 'update.businessId');
  }
  if (UPDATE_OPERATIONS.has(operation)) {
    claim(asRecord(record['data'])['businessId'], 'data.businessId');
  }
  return record;
}
