/**
 * Sales order state machine.
 *
 * Draft → Submitted → Pending Approval → Approved → Stock Reserved → Picking
 *   → Packed → Dispatched → Delivered → Invoiced → Closed
 *
 * Plus: Rejected, Cancelled, Partially Delivered. Backorders are tracked per
 * line (qty_backordered) so an order can be Stock Reserved while part of it
 * waits for stock.
 *
 * Tenants can switch off optional steps (approval when within limits is
 * already automatic; pick/pack can be skipped) through OrderWorkflowSettings.
 */
export const ORDER_STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  STOCK_RESERVED: 'STOCK_RESERVED',
  PICKING: 'PICKING',
  PACKED: 'PACKED',
  DISPATCHED: 'DISPATCHED',
  PARTIALLY_DELIVERED: 'PARTIALLY_DELIVERED',
  DELIVERED: 'DELIVERED',
  INVOICED: 'INVOICED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const ORDER_ACTION = {
  SUBMIT: 'SUBMIT',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
  AUTO_APPROVE: 'AUTO_APPROVE',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  REVISE: 'REVISE',
  RESERVE: 'RESERVE',
  START_PICKING: 'START_PICKING',
  PACK: 'PACK',
  DISPATCH: 'DISPATCH',
  DELIVER_PARTIAL: 'DELIVER_PARTIAL',
  DELIVER: 'DELIVER',
  INVOICE: 'INVOICE',
  CLOSE: 'CLOSE',
  CANCEL: 'CANCEL',
} as const;

export type OrderAction = (typeof ORDER_ACTION)[keyof typeof ORDER_ACTION];

export interface OrderWorkflowSettings {
  /** When false, RESERVE goes straight to a state from which DISPATCH is allowed. */
  pickPackEnabled: boolean;
  /** Allow invoicing as soon as goods are dispatched (otherwise only after delivery is confirmed). */
  invoiceOnDispatch: boolean;
}

export const DEFAULT_WORKFLOW_SETTINGS: OrderWorkflowSettings = {
  pickPackEnabled: true,
  invoiceOnDispatch: false,
};

const S = ORDER_STATUS;
const A = ORDER_ACTION;

type TransitionTable = Partial<Record<OrderAction, { from: OrderStatus[]; to: OrderStatus }>>;

export function transitionTable(settings: OrderWorkflowSettings = DEFAULT_WORKFLOW_SETTINGS): TransitionTable {
  return {
    [A.SUBMIT]: { from: [S.DRAFT], to: S.SUBMITTED },
    [A.REQUIRE_APPROVAL]: { from: [S.SUBMITTED], to: S.PENDING_APPROVAL },
    [A.AUTO_APPROVE]: { from: [S.SUBMITTED], to: S.APPROVED },
    [A.APPROVE]: { from: [S.PENDING_APPROVAL], to: S.APPROVED },
    [A.REJECT]: { from: [S.PENDING_APPROVAL], to: S.REJECTED },
    [A.REVISE]: { from: [S.REJECTED], to: S.DRAFT },
    [A.RESERVE]: { from: [S.APPROVED], to: S.STOCK_RESERVED },
    [A.START_PICKING]: { from: settings.pickPackEnabled ? [S.STOCK_RESERVED] : [], to: S.PICKING },
    [A.PACK]: { from: settings.pickPackEnabled ? [S.PICKING] : [], to: S.PACKED },
    // Later shipments of backordered goods leave from PARTIALLY_DELIVERED.
    [A.DISPATCH]: {
      from: settings.pickPackEnabled ? [S.PACKED, S.PARTIALLY_DELIVERED] : [S.STOCK_RESERVED, S.PARTIALLY_DELIVERED],
      to: S.DISPATCHED,
    },
    [A.DELIVER_PARTIAL]: { from: [S.DISPATCHED, S.PARTIALLY_DELIVERED], to: S.PARTIALLY_DELIVERED },
    [A.DELIVER]: { from: [S.DISPATCHED, S.PARTIALLY_DELIVERED], to: S.DELIVERED },
    // The order becomes INVOICED once everything delivered is invoiced. Partial
    // invoices (see invoiceableStatuses) do not change the order status.
    [A.INVOICE]: { from: [S.DELIVERED], to: S.INVOICED },
    [A.CLOSE]: { from: [S.INVOICED], to: S.CLOSED },
    [A.CANCEL]: {
      from: [S.DRAFT, S.SUBMITTED, S.PENDING_APPROVAL, S.APPROVED, S.REJECTED, S.STOCK_RESERVED, S.PICKING, S.PACKED],
      to: S.CANCELLED,
    },
  };
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly action: OrderAction,
  ) {
    super(`Action ${action} is not allowed when order is ${from}`);
  }
}

export function nextStatus(
  from: OrderStatus,
  action: OrderAction,
  settings: OrderWorkflowSettings = DEFAULT_WORKFLOW_SETTINGS,
): OrderStatus {
  const t = transitionTable(settings)[action];
  if (!t || !t.from.includes(from)) throw new InvalidTransitionError(from, action);
  return t.to;
}

export function allowedActions(
  from: OrderStatus,
  settings: OrderWorkflowSettings = DEFAULT_WORKFLOW_SETTINGS,
): OrderAction[] {
  const table = transitionTable(settings);
  return (Object.keys(table) as OrderAction[]).filter((a) => table[a]!.from.includes(from));
}

/** Statuses in which an invoice may be raised for what has shipped so far. */
export function invoiceableStatuses(settings: OrderWorkflowSettings = DEFAULT_WORKFLOW_SETTINGS): OrderStatus[] {
  return settings.invoiceOnDispatch
    ? [S.DISPATCHED, S.PARTIALLY_DELIVERED, S.DELIVERED]
    : [S.PARTIALLY_DELIVERED, S.DELIVERED];
}

/** Statuses in which more stock may be reserved for backordered lines. */
export const BACKORDER_RESERVABLE_STATUSES: OrderStatus[] = [
  S.STOCK_RESERVED, S.PICKING, S.PACKED, S.DISPATCHED, S.PARTIALLY_DELIVERED,
];

/** Statuses from which delivered goods can be returned. */
export const RETURNABLE_STATUSES: OrderStatus[] = [S.PARTIALLY_DELIVERED, S.DELIVERED, S.INVOICED, S.CLOSED];

/** Statuses during which stock reservations exist and must be released on cancel. */
export const RESERVATION_HOLDING_STATUSES: OrderStatus[] = [S.STOCK_RESERVED, S.PICKING, S.PACKED];

/** Statuses in which order lines can still be edited. */
export const EDITABLE_STATUSES: OrderStatus[] = [S.DRAFT];
