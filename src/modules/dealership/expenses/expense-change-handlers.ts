import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  ChangeContext,
  ChangeHandler,
  ChangeValues,
  FieldRule,
  ImpactLine,
  LoadedRecord,
  ProposedChange,
} from '../../../core/approvals/change-handler';
import { fromDbDate, isCalendarDate, toDbDate, todayIn } from '../../../core/common/business-time';
import { MONEY_PATTERN, moneyString, toDecimal } from '../../../core/common/money';
import { lockRows } from '../../../core/database/row-lock';
import { badRequest, conflict } from '../../../core/errors';
import { DealershipConfig, parseDealershipConfig } from '../dealership.config';
import { DEALERSHIP_TYPE } from '../dealership.permissions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function configOf(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<DealershipConfig> {
  const business = await tx.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { config: true },
  });
  return parseDealershipConfig(business.config);
}

function text(
  ctx: ChangeContext,
  key: string,
  value: unknown,
  limit: number,
  code: string,
): string | null {
  if (value !== null && (typeof value !== 'string' || value.trim().length > limit)) {
    throw badRequest(
      code,
      `${key} must be text of at most ${String(limit)} characters`,
      `${ctx.fieldPrefix}${key}`,
    );
  }
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function date(
  ctx: ChangeContext,
  key: string,
  value: unknown,
  subject: string,
  timezone: string,
): string {
  const field = `${ctx.fieldPrefix}${key}`;
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    throw badRequest(`${subject}_INVALID`, 'Not a real date', field);
  }
  if (value > todayIn(timezone)) {
    throw badRequest(`${subject}_IN_FUTURE`, 'The date cannot be in the future', field);
  }
  return value;
}

// =============================================================================
// Expenses
// =============================================================================

interface ExpenseState {
  status: string;
  amount: Prisma.Decimal;
  timezone: string;
  methods: string[];
}

const EXPENSE_FIELDS: Record<string, FieldRule> = {
  expenseDate: { label: 'Expense date', directPermission: 'expense.edit' },
  categoryId: { label: 'Expense kind', directPermission: 'expense.edit' },
  method: { label: 'Method', directPermission: 'expense.edit' },
  amount: { label: 'Amount', directPermission: 'expense.edit', visibleWith: 'expense.view' },
  note: { label: 'Description', directPermission: 'expense.edit' },
  proofNote: { label: 'Proof note', directPermission: 'expense.edit' },
};

/**
 * Correcting or voiding an expense. Staff send a change request; whoever holds
 * `expense.edit` / `expense.void` (owner level by default) may do it directly.
 * A void only flips the status: the cash book and the expense report count
 * active rows, so no reversing entry is needed and nothing is ever deleted.
 */
@Injectable()
export class ExpenseChangeHandler implements ChangeHandler {
  readonly entityType = 'expense';
  readonly businessTypes = [DEALERSHIP_TYPE];
  readonly viewPermission = 'expense.view';
  readonly fields = EXPENSE_FIELDS;
  readonly void = { label: 'Void expense', directPermission: 'expense.void' };
  private readonly states = new WeakMap<LoadedRecord, ExpenseState>();

  async load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    options: { forUpdate: boolean },
  ) {
    if (options.forUpdate) await lockRows(tx, 'expenses', ctx.businessId, [id]);
    const [row, config] = await Promise.all([
      tx.expense.findUnique({
        where: { id },
        select: {
          code: true,
          status: true,
          expenseDate: true,
          categoryId: true,
          method: true,
          amount: true,
          note: true,
          proofNote: true,
          version: true,
        },
      }),
      configOf(tx, ctx.businessId),
    ]);
    if (!row) return null;
    const record: LoadedRecord = {
      version: row.version,
      label: `${row.code} (${fromDbDate(row.expenseDate)})`,
      values: {
        status: row.status,
        expenseDate: fromDbDate(row.expenseDate),
        categoryId: row.categoryId,
        method: row.method,
        amount: moneyString(row.amount),
        note: row.note,
        proofNote: row.proofNote,
      },
    };
    this.states.set(record, {
      status: row.status,
      amount: row.amount,
      timezone: config.timezone,
      methods: config.expenseMethods,
    });
    return record;
  }

  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues {
    const state = this.stateOf(current);
    if (state.status === 'void') {
      throw conflict('EXPENSE_ALREADY_VOID', 'This expense is void');
    }
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      const field = `${ctx.fieldPrefix}${key}`;
      if (key === 'expenseDate') {
        values[key] = date(ctx, key, value, 'EXPENSE_DATE', state.timezone);
      } else if (key === 'categoryId') {
        if (typeof value !== 'string' || !UUID.test(value)) {
          throw badRequest(
            'EXPENSE_CATEGORY_NOT_FOUND_OR_INACTIVE',
            'Expense kind not found or inactive',
            field,
          );
        }
        values[key] = value;
      } else if (key === 'method') {
        if (typeof value !== 'string' || !state.methods.includes(value)) {
          throw badRequest('EXPENSE_METHOD_UNKNOWN', 'Not one of this business’s methods', field);
        }
        values[key] = value;
      } else if (key === 'amount') {
        if (
          typeof value !== 'string' ||
          !MONEY_PATTERN.test(value) ||
          !toDecimal(value).greaterThan(0)
        ) {
          throw badRequest(
            'AMOUNT_INVALID',
            'amount must be above zero, like "5000.00" (as a string)',
            field,
          );
        }
        values[key] = moneyString(toDecimal(value));
      } else if (key === 'note') {
        values[key] = text(ctx, key, value, 500, 'NOTE_INVALID');
      } else if (key === 'proofNote') {
        values[key] = text(ctx, key, value, 200, 'PROOF_NOTE_INVALID');
      } else {
        throw badRequest('FIELD_NOT_CHANGEABLE', `Field "${key}" cannot be changed`, field);
      }
    }
    return values;
  }

  validateVoid(
    _tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
  ): Promise<void> {
    if (this.stateOf(current).status === 'void') {
      throw conflict('EXPENSE_ALREADY_VOID', 'This expense is already void');
    }
    return Promise.resolve();
  }

  /**
   * What the change does to the money paid out. The kind is checked here too,
   * so an approver sees a real name rather than an id.
   */
  async preview(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ): Promise<ImpactLine[]> {
    const state = this.stateOf(current);
    const lines: ImpactLine[] = [];
    if (change.kind === 'void') {
      lines.push({
        key: 'expense.amount',
        label: 'Expense',
        before: moneyString(state.amount),
        after: '0.00',
        note: 'Voided: it leaves the cash book and the expense report.',
        visibleWith: 'expense.view',
      });
      return lines;
    }
    const categoryId = change.values['categoryId'];
    if (typeof categoryId === 'string') {
      const category = await this.requireCategory(tx, ctx, categoryId, 'categoryId');
      lines.push({
        key: 'expense.category',
        label: 'Expense kind',
        before: String(current.values['categoryId']),
        after: category.nameEn,
      });
    }
    for (const [key, rule] of Object.entries(EXPENSE_FIELDS)) {
      if (key === 'categoryId' || !(key in change.values)) continue;
      const after = change.values[key] ?? null;
      const before = current.values[key] ?? null;
      if (after === before) continue;
      lines.push({
        key: `expense.${key}`,
        label: rule.label,
        before,
        after,
        ...(rule.visibleWith ? { visibleWith: rule.visibleWith } : {}),
      });
    }
    return lines;
  }

  async applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    _current: LoadedRecord,
    values: ChangeValues,
  ) {
    if (typeof values['categoryId'] === 'string') {
      await this.requireCategory(tx, ctx, values['categoryId'], 'categoryId');
    }
    await tx.expense.update({
      where: { id },
      data: {
        ...('expenseDate' in values
          ? { expenseDate: toDbDate(String(values['expenseDate'])) }
          : {}),
        ...('categoryId' in values ? { categoryId: String(values['categoryId']) } : {}),
        ...('method' in values ? { method: String(values['method']) } : {}),
        ...('amount' in values ? { amount: toDecimal(String(values['amount'])) } : {}),
        ...('note' in values ? { note: values['note'] as string | null } : {}),
        ...('proofNote' in values ? { proofNote: values['proofNote'] as string | null } : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  }

  async applyVoid(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    reason: string,
  ) {
    await this.validateVoid(tx, ctx, current);
    await tx.expense.update({
      where: { id },
      data: {
        status: 'void',
        voidedAt: new Date(),
        voidedBy: ctx.actorUserId,
        voidReason: reason,
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  }

  private async requireCategory(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    key: string,
  ): Promise<{ nameEn: string }> {
    const category = await tx.expenseCategory.findUnique({
      where: { id },
      select: { nameEn: true, isActive: true },
    });
    if (!category?.isActive) {
      throw badRequest(
        'EXPENSE_CATEGORY_NOT_FOUND_OR_INACTIVE',
        'Expense kind not found or inactive',
        `${ctx.fieldPrefix}${key}`,
      );
    }
    return category;
  }

  private stateOf(record: LoadedRecord): ExpenseState {
    const state = this.states.get(record);
    if (!state) throw new Error('ExpenseChangeHandler: record was not loaded by this handler');
    return state;
  }
}

// =============================================================================
// Expense kinds
// =============================================================================

const INACTIVE_NOTE = 'While inactive it cannot be chosen for new expenses; existing ones stay.';

const CATEGORY_FIELDS: Record<string, FieldRule> = {
  isActive: { label: 'Active', directPermission: 'expense.category.manage' },
};

/**
 * Deactivating or reactivating an expense kind. Staff with no
 * `expense.category.manage` send a change request instead. Kinds are never
 * voided or deleted: deactivation takes that place, as with master data.
 */
export const expenseCategoryChangeHandler: ChangeHandler = {
  entityType: 'expense_category',
  businessTypes: [DEALERSHIP_TYPE],
  viewPermission: 'expense.view',
  fields: CATEGORY_FIELDS,

  async load(tx, ctx, id, { forUpdate }) {
    if (forUpdate) await lockRows(tx, 'expense_categories', ctx.businessId, [id]);
    const row = await tx.expenseCategory.findUnique({
      where: { id },
      select: { nameEn: true, version: true, isActive: true },
    });
    return row
      ? { version: row.version, label: row.nameEn, values: { isActive: row.isActive } }
      : null;
  },

  validateEdit(ctx, _current, proposed) {
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      if (key !== 'isActive' || typeof value !== 'boolean') {
        throw badRequest(
          'IS_ACTIVE_INVALID',
          'isActive must be true or false',
          `${ctx.fieldPrefix}${key}`,
        );
      }
      values[key] = value;
    }
    return values;
  },

  preview(_tx, _ctx, current, change) {
    if (change.kind !== 'edit' || !('isActive' in change.values)) {
      return Promise.resolve([]);
    }
    const after = change.values['isActive'];
    return Promise.resolve([
      {
        key: 'expense_category.isActive',
        label: 'Active',
        before: current.values['isActive'] ?? null,
        after: after ?? null,
        ...(after === false ? { note: INACTIVE_NOTE } : {}),
      },
    ]);
  },

  async applyEdit(tx, ctx, id, _current, values) {
    await tx.expenseCategory.update({
      where: { id },
      data: {
        ...(typeof values['isActive'] === 'boolean' ? { isActive: values['isActive'] } : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  },
};
