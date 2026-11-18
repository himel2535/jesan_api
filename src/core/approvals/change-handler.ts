import { Prisma } from '../../generated/prisma/client';

/** A JSON value stored in snapshots and proposals (money as fixed strings). */
export type ChangeValue = string | number | boolean | null;
export type ChangeValues = Record<string, ChangeValue>;

/** What the handler is told about the request it works for. */
export interface ChangeContext {
  businessId: string;
  businessType: string;
  /** Who acts now: the requester (create, preview) or the approver (apply). */
  actorUserId: string;
  /** The actor's permissions in this business. */
  permissions: ReadonlySet<string>;
  /** The reason given for the change (set while applying). */
  reason?: string;
  /**
   * Prefix for the `field` of errors about a proposed value: "proposedChange."
   * for a change request, "" for a direct change (the value is a body key).
   */
  fieldPrefix: string;
}

export interface LoadedRecord {
  /** The record's version; a request is stale when it no longer matches. */
  version: number;
  /** Short label for lists, e.g. "P-0001 Sample OPC 50kg". */
  label: string;
  /** Current values of every field this handler can change. */
  values: ChangeValues;
}

/** One line of the impact preview, e.g. stock +50 bags or balance 12000.00 → 0.00. */
export interface ImpactLine {
  key: string;
  label: string;
  before?: ChangeValue;
  after?: ChangeValue;
  delta?: string;
  unit?: string;
  note?: string;
  /** Hidden from viewers without this permission. */
  visibleWith?: string;
}

export interface FieldRule {
  label: string;
  /** Needed to change the field directly, and to approve a request that changes it. */
  directPermission: string;
  /** Needed to see the field's values (and to request a change to it). */
  visibleWith?: string;
}

export type ProposedChange = { kind: 'edit'; values: ChangeValues } | { kind: 'void' };

/**
 * How a module plugs a record type into the change-request workflow. The core
 * locks, checks versions, records statuses and the audit log, and runs every
 * apply inside one transaction; the handler only reads and writes its own
 * tables through `tx` (a client limited to the business).
 *
 * Rules for handlers:
 * - `load` with forUpdate must lock the row (SELECT ... FOR UPDATE).
 * - `applyEdit` / `applyVoid` must bump the record's version and write every
 *   side effect (stock, balances, ledger, counters) through `tx`, so a failure
 *   anywhere rolls everything back. Reversals are dated on the void date.
 * - Never hard delete financial or stock records: void them.
 */
export interface ChangeHandler {
  entityType: string;
  /** Business types this handler applies to; omitted means every type. */
  businessTypes?: readonly string[];
  /** Needed to request a change at all (the record must be visible). */
  viewPermission: string;
  /** Fields a change request may edit. */
  fields: Readonly<Record<string, FieldRule>>;
  /**
   * Rules for fields named by pattern rather than listed in `fields`, e.g. the
   * lines of a document (`items.<id>.quantity`). Returns undefined for keys
   * that cannot be changed.
   */
  fieldRule?(key: string): FieldRule | undefined;
  /** Present when the record can be voided. */
  void?: { label: string; directPermission: string };

  load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    entityId: string,
    options: { forUpdate: boolean },
  ): Promise<LoadedRecord | null>;

  /** Returns the normalized values; throws BadRequestException when invalid. */
  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues;

  /** Throws when the void is not allowed (e.g. stock would go negative). */
  validateVoid?(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    current: LoadedRecord,
  ): Promise<void>;

  preview(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ): Promise<ImpactLine[]>;

  applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    entityId: string,
    current: LoadedRecord,
    values: ChangeValues,
  ): Promise<void>;

  applyVoid?(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    entityId: string,
    current: LoadedRecord,
    reason: string,
  ): Promise<void>;
}
