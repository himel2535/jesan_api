import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  ChangeHandler,
  ChangeValues,
  ImpactLine,
  LoadedRecord,
} from '../../../core/approvals/change-handler';
import {
  MONEY_PATTERN,
  SIGNED_MONEY_PATTERN,
  moneyString,
  moneyStringOrNull,
  toDecimal,
} from '../../../core/common/money';
import { DEALERSHIP_TYPE } from '../dealership.permissions';

/**
 * Change-request handlers for the dealership master data: the sensitive fields
 * that staff may not change directly (prices, balances, limits, activation).
 * Master data is never voided; deactivation takes that place.
 */

const LOCKABLE_TABLES = {
  product: 'products',
  customer: 'customers',
  product_category: 'product_categories',
} as const;

/** SELECT ... FOR UPDATE on one row of this business (raw SQL: business filter written out). */
async function lockRow(
  tx: Prisma.TransactionClient,
  table: (typeof LOCKABLE_TABLES)[keyof typeof LOCKABLE_TABLES],
  id: string,
  businessId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ${Prisma.raw(`"${table}"`)}
    WHERE id = ${id}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
}

function money(value: unknown, field: string, signed = false): string {
  const pattern = signed ? SIGNED_MONEY_PATTERN : MONEY_PATTERN;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new BadRequestException(`${field} must be an amount like "570.50" (as a string)`);
  }
  return toDecimal(value).toFixed(2);
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be true or false`);
  }
  return value;
}

function changedLines(
  current: LoadedRecord,
  values: ChangeValues,
  fields: ChangeHandler['fields'],
  prefix: string,
): ImpactLine[] {
  return Object.entries(values).map(([key, after]) => ({
    key: `${prefix}.${key}`,
    label: fields[key]?.label ?? key,
    before: current.values[key] ?? null,
    after,
    ...(fields[key]?.visibleWith ? { visibleWith: fields[key].visibleWith } : {}),
  }));
}

const INACTIVE_NOTE = 'While inactive it cannot be chosen for new entries; existing records stay.';

// ---------------------------------------------------------------------------

const productFields = {
  purchasePrice: {
    label: 'Purchase price',
    directPermission: 'product.price.edit',
    visibleWith: 'product.cost.view',
  },
  isActive: { label: 'Active', directPermission: 'product.deactivate' },
} as const;

export const productChangeHandler: ChangeHandler = {
  entityType: 'product',
  businessTypes: [DEALERSHIP_TYPE],
  viewPermission: 'product.view',
  fields: productFields,

  async load(tx, ctx, id, { forUpdate }) {
    if (forUpdate) {
      await lockRow(tx, LOCKABLE_TABLES.product, id, ctx.businessId);
    }
    const row = await tx.product.findUnique({
      where: { id },
      select: {
        code: true,
        nameEn: true,
        version: true,
        purchasePrice: true,
        isActive: true,
      },
    });
    return row
      ? {
          version: row.version,
          label: `${row.code} ${row.nameEn}`,
          values: {
            purchasePrice: moneyString(row.purchasePrice),
            isActive: row.isActive,
          },
        }
      : null;
  },

  validateEdit(_ctx, _current, proposed) {
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      values[key] = key === 'isActive' ? flag(value, key) : money(value, key);
    }
    return values;
  },

  preview(_tx, _ctx, current, change) {
    if (change.kind !== 'edit') {
      return Promise.resolve([]);
    }
    const lines = changedLines(current, change.values, productFields, 'product');
    for (const line of lines) {
      if (line.key === 'product.isActive' && line.after === false) {
        line.note = INACTIVE_NOTE;
      }
    }
    return Promise.resolve(lines);
  },

  async applyEdit(tx, ctx, id, _current, values) {
    await tx.product.update({
      where: { id },
      data: {
        ...(typeof values['purchasePrice'] === 'string'
          ? { purchasePrice: toDecimal(values['purchasePrice']) }
          : {}),
        ...(typeof values['isActive'] === 'boolean' ? { isActive: values['isActive'] } : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  },
};

// ---------------------------------------------------------------------------

const customerFields = {
  openingBalance: {
    label: 'Opening balance',
    directPermission: 'customer.balance.edit',
    visibleWith: 'customer.due.view',
  },
  creditLimit: {
    label: 'Credit limit',
    directPermission: 'customer.balance.edit',
    visibleWith: 'customer.due.view',
  },
  isActive: { label: 'Active', directPermission: 'customer.deactivate' },
} as const;

export const customerChangeHandler: ChangeHandler = {
  entityType: 'customer',
  businessTypes: [DEALERSHIP_TYPE],
  viewPermission: 'customer.view',
  fields: customerFields,

  async load(tx, ctx, id, { forUpdate }) {
    if (forUpdate) {
      await lockRow(tx, LOCKABLE_TABLES.customer, id, ctx.businessId);
    }
    const row = await tx.customer.findUnique({
      where: { id },
      select: {
        code: true,
        nameEn: true,
        version: true,
        openingBalance: true,
        currentBalance: true,
        creditLimit: true,
        isActive: true,
      },
    });
    return row
      ? {
          version: row.version,
          label: `${row.code} ${row.nameEn}`,
          values: {
            openingBalance: moneyString(row.openingBalance),
            creditLimit: moneyStringOrNull(row.creditLimit),
            isActive: row.isActive,
            // Not changeable by request; read for the preview only.
            currentBalance: moneyString(row.currentBalance),
          },
        }
      : null;
  },

  validateEdit(_ctx, _current, proposed) {
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      if (key === 'isActive') {
        values[key] = flag(value, key);
      } else if (key === 'creditLimit') {
        values[key] = value === null ? null : money(value, key);
      } else {
        values[key] = money(value, key, true);
      }
    }
    return values;
  },

  preview(_tx, _ctx, current, change) {
    if (change.kind !== 'edit') {
      return Promise.resolve([]);
    }
    const lines = changedLines(current, change.values, customerFields, 'customer');
    const opening = change.values['openingBalance'];
    const before = current.values['currentBalance'];
    const previousOpening = current.values['openingBalance'];
    if (
      typeof opening === 'string' &&
      typeof before === 'string' &&
      typeof previousOpening === 'string'
    ) {
      // The current balance moves by the same amount as the opening balance.
      const delta = toDecimal(opening).minus(toDecimal(previousOpening));
      lines.push({
        key: 'customer.currentBalance',
        label: 'Current balance',
        before,
        after: toDecimal(before).plus(delta).toFixed(2),
        delta: (delta.isNegative() ? '' : '+') + delta.toFixed(2),
        visibleWith: 'customer.due.view',
      });
    }
    for (const line of lines) {
      if (line.key === 'customer.isActive' && line.after === false) {
        line.note = INACTIVE_NOTE;
      }
      if (line.key === 'customer.creditLimit' && line.after === null) {
        line.note = 'No credit limit';
      }
    }
    return Promise.resolve(lines);
  },

  async applyEdit(tx, ctx, id, current, values) {
    const opening = values['openingBalance'];
    const delta =
      typeof opening === 'string' && typeof current.values['openingBalance'] === 'string'
        ? toDecimal(opening).minus(toDecimal(current.values['openingBalance']))
        : null;
    await tx.customer.update({
      where: { id },
      data: {
        ...(typeof opening === 'string' ? { openingBalance: toDecimal(opening) } : {}),
        // Atomic: the current balance moves by the same amount.
        ...(delta && !delta.isZero() ? { currentBalance: { increment: delta } } : {}),
        ...('creditLimit' in values
          ? {
              creditLimit:
                typeof values['creditLimit'] === 'string' ? toDecimal(values['creditLimit']) : null,
            }
          : {}),
        ...(typeof values['isActive'] === 'boolean' ? { isActive: values['isActive'] } : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  },
};

// ---------------------------------------------------------------------------

const categoryFields = {
  isActive: { label: 'Active', directPermission: 'product.deactivate' },
} as const;

export const categoryChangeHandler: ChangeHandler = {
  entityType: 'product_category',
  businessTypes: [DEALERSHIP_TYPE],
  viewPermission: 'product.view',
  fields: categoryFields,

  async load(tx, ctx, id, { forUpdate }) {
    if (forUpdate) {
      await lockRow(tx, LOCKABLE_TABLES.product_category, id, ctx.businessId);
    }
    const row = await tx.productCategory.findUnique({
      where: { id },
      select: { nameEn: true, version: true, isActive: true },
    });
    return row
      ? { version: row.version, label: row.nameEn, values: { isActive: row.isActive } }
      : null;
  },

  validateEdit(_ctx, _current, proposed) {
    return Object.fromEntries(
      Object.entries(proposed).map(([key, value]) => [key, flag(value, key)]),
    );
  },

  preview(_tx, _ctx, current, change) {
    if (change.kind !== 'edit') {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      changedLines(current, change.values, categoryFields, 'product_category').map((line) =>
        line.after === false ? { ...line, note: INACTIVE_NOTE } : line,
      ),
    );
  },

  async applyEdit(tx, ctx, id, _current, values) {
    await tx.productCategory.update({
      where: { id },
      data: {
        ...(typeof values['isActive'] === 'boolean' ? { isActive: values['isActive'] } : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  },
};
