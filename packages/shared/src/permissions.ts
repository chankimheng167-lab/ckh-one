/**
 * Permission codes. Roles are tenant-configurable bundles of these codes;
 * the defaults below seed every new tenant.
 */
export const P = {
  // Platform (Super Admin only — not grantable inside a tenant)
  PLATFORM_TENANTS_MANAGE: 'platform.tenants.manage',
  PLATFORM_SUBSCRIPTIONS_MANAGE: 'platform.subscriptions.manage',

  // Tenant administration
  TENANT_USERS_MANAGE: 'tenant.users.manage',
  TENANT_ROLES_MANAGE: 'tenant.roles.manage',
  TENANT_SETTINGS_MANAGE: 'tenant.settings.manage',

  // Master data
  CUSTOMERS_VIEW_ALL: 'customers.view_all',
  CUSTOMERS_MANAGE: 'customers.manage',
  CUSTOMERS_CREDIT_MANAGE: 'customers.credit.manage',
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_MANAGE: 'products.manage',
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',

  // Sales force automation
  SALES_DASHBOARD_VIEW: 'sales.dashboard.view',
  SALES_CUSTOMERS_VIEW_ASSIGNED: 'sales.customers.view_assigned',
  SALES_CUSTOMERS_VIEW_BALANCE: 'sales.customers.view_balance',
  SALES_CUSTOMERS_ASSIGN: 'sales.customers.assign',
  SALES_CATALOG_VIEW: 'sales.catalog.view',
  SALES_QUOTATIONS_MANAGE: 'sales.quotations.manage',
  SALES_ORDERS_CREATE: 'sales.orders.create',
  SALES_ORDERS_VIEW_OWN: 'sales.orders.view_own',
  SALES_ORDERS_VIEW_TEAM: 'sales.orders.view_team',
  SALES_ORDERS_VIEW_ALL: 'sales.orders.view_all',
  SALES_ORDERS_CANCEL: 'sales.orders.cancel',
  SALES_ORDERS_APPROVE: 'sales.orders.approve',
  SALES_FULFILLMENT_RESERVE: 'sales.fulfillment.reserve',
  SALES_FULFILLMENT_PICK_PACK: 'sales.fulfillment.pick_pack',
  SALES_FULFILLMENT_DISPATCH: 'sales.fulfillment.dispatch',
  SALES_INVOICES_CREATE: 'sales.invoices.create',
  SALES_RETURNS_REQUEST: 'sales.returns.request',
  SALES_RETURNS_RECEIVE: 'sales.returns.receive',
  SALES_COLLECTIONS_SUBMIT: 'sales.collections.submit',
  SALES_COLLECTIONS_VERIFY: 'sales.collections.verify',
  SALES_VISITS_MANAGE: 'sales.visits.manage',
  SALES_VISITS_VIEW_TEAM: 'sales.visits.view_team',
  SALES_TARGETS_VIEW: 'sales.targets.view',
  SALES_TARGETS_MANAGE: 'sales.targets.manage',
  SALES_COMMISSIONS_VIEW: 'sales.commissions.view',
  SALES_COMMISSIONS_MANAGE: 'sales.commissions.manage',
  SALES_TERRITORIES_MANAGE: 'sales.territories.manage',
  SALES_TEAMS_MANAGE: 'sales.teams.manage',
  SALES_REPORTS_VIEW: 'sales.reports.view',
  SALES_SETTINGS_MANAGE: 'sales.settings.manage',
  // HR & Payroll hand-off
  HR_PAYROLL_MANAGE: 'hr.payroll.manage',

  // POS Sales & Cashier
  POS_ACCESS: 'pos.access',
  POS_SALES_CREATE: 'pos.sales.create',
  POS_SALES_VIEW_ALL: 'pos.sales.view_all',
  POS_DISCOUNT_APPLY: 'pos.discount.apply',
  POS_DISCOUNT_OVERRIDE: 'pos.discount.override',
  POS_PRICE_OVERRIDE: 'pos.price.override',
  POS_REFUNDS_CREATE: 'pos.refunds.create',
  POS_RECEIPT_REPRINT: 'pos.receipts.reprint',
  POS_CASH_DRAWER: 'pos.cash.drawer',
  POS_SHIFT_CLOSE: 'pos.shift.close',
  POS_SHIFT_APPROVE: 'pos.shift.approve',
  POS_PAYMENTS_VERIFY: 'pos.payments.verify',
  POS_REPORTS_VIEW: 'pos.reports.view',
  POS_ALL_BRANCHES: 'pos.branches.all',
  POS_REGISTERS_MANAGE: 'pos.registers.manage',
  POS_DEVICES_MANAGE: 'pos.devices.manage',
  POS_SETTINGS_MANAGE: 'pos.settings.manage',
} as const;

export type PermissionCode = (typeof P)[keyof typeof P];

export const ALL_TENANT_PERMISSIONS: PermissionCode[] = Object.values(P).filter(
  (p) => !p.startsWith('platform.'),
) as PermissionCode[];

export const DEFAULT_ROLES: Record<string, { name: string; permissions: PermissionCode[] }> = {
  TENANT_ADMIN: {
    name: 'Tenant Administrator',
    permissions: ALL_TENANT_PERMISSIONS,
  },
  SALES_REP: {
    name: 'Sales Representative',
    permissions: [
      P.SALES_DASHBOARD_VIEW,
      P.SALES_CUSTOMERS_VIEW_ASSIGNED,
      P.SALES_CUSTOMERS_VIEW_BALANCE,
      P.SALES_CATALOG_VIEW,
      P.PRODUCTS_VIEW,
      P.SALES_QUOTATIONS_MANAGE,
      P.SALES_ORDERS_CREATE,
      P.SALES_ORDERS_VIEW_OWN,
      P.SALES_ORDERS_CANCEL,
      P.SALES_RETURNS_REQUEST,
      P.SALES_COLLECTIONS_SUBMIT,
      P.SALES_VISITS_MANAGE,
      P.SALES_TARGETS_VIEW,
      P.SALES_COMMISSIONS_VIEW,
    ],
  },
  SALES_SUPERVISOR: {
    name: 'Sales Supervisor',
    permissions: [
      P.SALES_DASHBOARD_VIEW,
      P.SALES_CUSTOMERS_VIEW_ASSIGNED,
      P.SALES_CUSTOMERS_VIEW_BALANCE,
      P.SALES_CUSTOMERS_ASSIGN,
      P.SALES_CATALOG_VIEW,
      P.PRODUCTS_VIEW,
      P.SALES_QUOTATIONS_MANAGE,
      P.SALES_ORDERS_CREATE,
      P.SALES_ORDERS_VIEW_OWN,
      P.SALES_ORDERS_VIEW_TEAM,
      P.SALES_ORDERS_CANCEL,
      P.SALES_RETURNS_REQUEST,
      P.SALES_ORDERS_APPROVE,
      P.SALES_VISITS_MANAGE,
      P.SALES_VISITS_VIEW_TEAM,
      P.SALES_TARGETS_VIEW,
      P.SALES_COMMISSIONS_VIEW,
      P.SALES_REPORTS_VIEW,
    ],
  },
  SALES_MANAGER: {
    name: 'Sales Manager',
    permissions: [
      P.SALES_DASHBOARD_VIEW,
      P.CUSTOMERS_VIEW_ALL,
      P.SALES_CUSTOMERS_VIEW_ASSIGNED,
      P.SALES_CUSTOMERS_VIEW_BALANCE,
      P.SALES_CUSTOMERS_ASSIGN,
      P.SALES_CATALOG_VIEW,
      P.PRODUCTS_VIEW,
      P.SALES_QUOTATIONS_MANAGE,
      P.SALES_ORDERS_CREATE,
      P.SALES_ORDERS_VIEW_ALL,
      P.SALES_ORDERS_CANCEL,
      P.SALES_RETURNS_REQUEST,
      P.SALES_ORDERS_APPROVE,
      P.SALES_VISITS_VIEW_TEAM,
      P.SALES_TARGETS_VIEW,
      P.SALES_TARGETS_MANAGE,
      P.SALES_COMMISSIONS_VIEW,
      P.SALES_COMMISSIONS_MANAGE,
      P.SALES_TERRITORIES_MANAGE,
      P.SALES_TEAMS_MANAGE,
      P.SALES_REPORTS_VIEW,
    ],
  },
  WAREHOUSE_OFFICER: {
    name: 'Warehouse Officer',
    permissions: [
      P.PRODUCTS_VIEW,
      P.INVENTORY_VIEW,
      P.SALES_ORDERS_VIEW_ALL,
      P.SALES_ORDERS_CANCEL,
      P.SALES_FULFILLMENT_RESERVE,
      P.SALES_FULFILLMENT_PICK_PACK,
      P.SALES_FULFILLMENT_DISPATCH,
      P.SALES_RETURNS_RECEIVE,
    ],
  },
  POS_CASHIER: {
    name: 'POS Cashier',
    permissions: [P.POS_ACCESS, P.POS_SALES_CREATE, P.POS_DISCOUNT_APPLY, P.POS_CASH_DRAWER, P.POS_SHIFT_CLOSE, P.PRODUCTS_VIEW],
  },
  POS_SUPERVISOR: {
    name: 'POS Supervisor',
    permissions: [
      P.POS_ACCESS, P.POS_SALES_CREATE, P.POS_SALES_VIEW_ALL, P.POS_DISCOUNT_APPLY, P.POS_DISCOUNT_OVERRIDE, P.POS_PRICE_OVERRIDE,
      P.POS_REFUNDS_CREATE, P.POS_RECEIPT_REPRINT, P.POS_CASH_DRAWER, P.POS_SHIFT_CLOSE, P.POS_SHIFT_APPROVE, P.POS_PAYMENTS_VERIFY,
      P.POS_REPORTS_VIEW, P.PRODUCTS_VIEW, P.INVENTORY_VIEW,
    ],
  },
  POS_MANAGER: {
    name: 'POS Manager',
    permissions: [
      P.POS_ACCESS, P.POS_SALES_CREATE, P.POS_SALES_VIEW_ALL, P.POS_DISCOUNT_APPLY, P.POS_DISCOUNT_OVERRIDE, P.POS_PRICE_OVERRIDE,
      P.POS_REFUNDS_CREATE, P.POS_RECEIPT_REPRINT, P.POS_CASH_DRAWER, P.POS_SHIFT_CLOSE, P.POS_SHIFT_APPROVE, P.POS_PAYMENTS_VERIFY,
      P.POS_REPORTS_VIEW, P.POS_ALL_BRANCHES, P.POS_REGISTERS_MANAGE, P.POS_DEVICES_MANAGE, P.POS_SETTINGS_MANAGE,
      P.PRODUCTS_VIEW, P.PRODUCTS_MANAGE, P.INVENTORY_VIEW, P.INVENTORY_ADJUST, P.CUSTOMERS_MANAGE,
    ],
  },
  BRANCH_ADMIN: {
    name: 'Branch Administrator',
    permissions: [
      P.POS_ACCESS, P.POS_SALES_CREATE, P.POS_SALES_VIEW_ALL, P.POS_DISCOUNT_APPLY, P.POS_DISCOUNT_OVERRIDE, P.POS_PRICE_OVERRIDE,
      P.POS_REFUNDS_CREATE, P.POS_RECEIPT_REPRINT, P.POS_CASH_DRAWER, P.POS_SHIFT_CLOSE, P.POS_SHIFT_APPROVE, P.POS_PAYMENTS_VERIFY,
      P.POS_REPORTS_VIEW, P.POS_REGISTERS_MANAGE, P.POS_DEVICES_MANAGE, P.PRODUCTS_VIEW, P.INVENTORY_VIEW, P.INVENTORY_ADJUST, P.CUSTOMERS_MANAGE,
    ],
  },
  ACCOUNTANT: {
    name: 'Accountant',
    permissions: [
      P.CUSTOMERS_VIEW_ALL,
      P.CUSTOMERS_CREDIT_MANAGE,
      P.SALES_CUSTOMERS_VIEW_BALANCE,
      P.SALES_ORDERS_VIEW_ALL,
      P.SALES_INVOICES_CREATE,
      P.SALES_COLLECTIONS_VERIFY,
      P.SALES_REPORTS_VIEW,
      P.POS_PAYMENTS_VERIFY,
      P.POS_REPORTS_VIEW,
      P.POS_SALES_VIEW_ALL,
    ],
  },
};
