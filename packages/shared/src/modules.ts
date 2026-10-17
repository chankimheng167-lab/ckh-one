/**
 * Subscription modules that a Super Admin can switch on/off per tenant.
 * Every protected API operation declares which module(s) it needs; the API
 * refuses the call when the tenant's subscription does not include them.
 */
export const MODULES = {
  // Platform core (always on for an active subscription)
  CORE: 'CORE',
  POS: 'POS',
  /** POS Sales & Cashier Management (web and Windows POS). */
  POS_SALES: 'POS_SALES',
  INVENTORY: 'INVENTORY',
  ACCOUNTING: 'ACCOUNTING',
  CRM: 'CRM',
  HR_PAYROLL: 'HR_PAYROLL',
  // Sales Force Automation add-ons
  SALES_TEAM_BASIC: 'SALES_TEAM_BASIC',
  SALES_ORDER_MANAGEMENT: 'SALES_ORDER_MANAGEMENT',
  SALES_TERRITORY_MANAGEMENT: 'SALES_TERRITORY_MANAGEMENT',
  SALES_COMMISSION_MANAGEMENT: 'SALES_COMMISSION_MANAGEMENT',
  SALES_ADVANCED_ANALYTICS: 'SALES_ADVANCED_ANALYTICS',
  SALES_OFFLINE_ORDERING: 'SALES_OFFLINE_ORDERING',
} as const;

export type ModuleCode = (typeof MODULES)[keyof typeof MODULES];

export const MODULE_CATALOG: { code: ModuleCode; name: string; requires: ModuleCode[] }[] = [
  { code: 'CORE', name: 'Core Platform', requires: [] },
  { code: 'POS', name: 'Point of Sale', requires: ['CORE', 'INVENTORY'] },
  { code: 'POS_SALES', name: 'POS Sales & Cashier', requires: ['CORE', 'INVENTORY'] },
  { code: 'INVENTORY', name: 'Inventory', requires: ['CORE'] },
  { code: 'ACCOUNTING', name: 'Accounting', requires: ['CORE'] },
  { code: 'CRM', name: 'CRM', requires: ['CORE'] },
  { code: 'HR_PAYROLL', name: 'HR & Payroll', requires: ['CORE'] },
  { code: 'SALES_TEAM_BASIC', name: 'Sales Team Basic', requires: ['CORE'] },
  { code: 'SALES_ORDER_MANAGEMENT', name: 'Sales Order Management', requires: ['SALES_TEAM_BASIC', 'INVENTORY'] },
  { code: 'SALES_TERRITORY_MANAGEMENT', name: 'Sales Territory Management', requires: ['SALES_TEAM_BASIC'] },
  { code: 'SALES_COMMISSION_MANAGEMENT', name: 'Sales Commission Management', requires: ['SALES_ORDER_MANAGEMENT'] },
  { code: 'SALES_ADVANCED_ANALYTICS', name: 'Advanced Sales Analytics', requires: ['SALES_ORDER_MANAGEMENT'] },
  { code: 'SALES_OFFLINE_ORDERING', name: 'Offline Mobile Ordering', requires: ['SALES_ORDER_MANAGEMENT'] },
];
