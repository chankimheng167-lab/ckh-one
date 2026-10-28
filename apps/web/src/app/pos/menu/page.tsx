'use client';
import Link from 'next/link';
import { P } from '@ckh/shared';
import { PosShell, usePos } from '@/components/PosShell';
import { Page } from '@/components/ui';

export default function PosMenuPage() {
  return (
    <PosShell needRegister={false}>
      <Menu />
    </PosShell>
  );
}

const ITEMS: { href: string; label: string; hint: string; perm?: string; any?: string[] }[] = [
  { href: '/pos/', label: 'POS dashboard', hint: 'Today’s sales, open shifts, low stock' },
  { href: '/pos/sell/', label: 'Sell', hint: 'The checkout screen', perm: P.POS_SALES_CREATE },
  { href: '/pos/products/', label: 'Product catalog', hint: 'Prices and stock lookup' },
  { href: '/pos/held/', label: 'Held sales', hint: 'Parked carts on this register' },
  { href: '/pos/sales/', label: 'Sales history', hint: 'Receipts, payments and refunds' },
  { href: '/pos/returns/', label: 'Returns and refunds', hint: 'Take items back and refund', perm: P.POS_REFUNDS_CREATE },
  { href: '/pos/shifts/', label: 'Cashier shifts', hint: 'Open, count and close the drawer' },
  { href: '/pos/cash/', label: 'Cash movements', hint: 'Cash in and out of the drawer' },
  { href: '/pos/payments/', label: 'Payments to verify', hint: 'Confirm or reject transfers and KHQR', perm: P.POS_PAYMENTS_VERIFY },
  { href: '/pos/reconciliation/', label: 'Reconciliation', hint: 'Books against tills, pending payments', perm: P.POS_REPORTS_VIEW },
  { href: '/pos/reports/', label: 'Daily sales report', hint: 'Totals by register, cashier, method, tax', perm: P.POS_REPORTS_VIEW },
  { href: '/pos/registers/', label: 'Registers', hint: 'Checkout counters, staff branches, licence use', any: [P.POS_REGISTERS_MANAGE, P.POS_REPORTS_VIEW] },
  { href: '/pos/receipt-settings/', label: 'Receipt settings', hint: 'Header, footer, languages, paper', perm: P.POS_SETTINGS_MANAGE },
  { href: '/pos/printers/', label: 'Printer settings', hint: 'Printer, cash drawer and scanner per register', any: [P.POS_DEVICES_MANAGE, P.POS_REGISTERS_MANAGE] },
  { href: '/pos/devices/', label: 'Device management', hint: 'Windows POS computers and their licences', perm: P.POS_DEVICES_MANAGE },
  { href: '/pos/sync/', label: 'Offline sync status', hint: 'Sales uploaded by Windows POS devices', any: [P.POS_DEVICES_MANAGE, P.POS_SALES_VIEW_ALL] },
  { href: '/pos/settings/', label: 'POS settings', hint: 'Discount limits, payment methods, ledger accounts, my PIN' },
];

function Menu() {
  const { can } = usePos();
  const show = ITEMS.filter((i) => (!i.perm || can(i.perm)) && (!i.any || i.any.some(can)));
  return (
    <Page title="POS menu" actions={<Link className="btn" href="/">Back to CKH ONE</Link>}>
      <div className="pos-tiles">
        {show.map((i) => (
          <a key={i.href} href={i.href} className="btn pos-tile" style={{ textDecoration: 'none' }}>
            <b>{i.label}</b>
            <span className="small muted">{i.hint}</span>
          </a>
        ))}
      </div>
    </Page>
  );
}
