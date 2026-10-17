-- CKH ONE — accounting core: chart of accounts, double-entry journal,
-- customer invoices (accounts receivable), receipts, credit notes.
--
-- Sales orders never post to the ledger. Revenue is posted when an invoice
-- is issued (per accounting_settings.revenue_recognition), COGS when goods
-- are delivered, and cash only when a receipt is verified.

CREATE TABLE chart_of_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  account_type  text NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  parent_id     uuid,
  is_postable   boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES chart_of_accounts (tenant_id, id)
);

-- Which ledger accounts sales documents post to, and when.
CREATE TABLE accounting_settings (
  tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ar_account_id              uuid,
  revenue_account_id         uuid,
  sales_discount_account_id  uuid,
  vat_output_account_id      uuid,
  cogs_account_id            uuid,
  inventory_account_id       uuid,
  cash_account_id            uuid,
  bank_account_id            uuid,
  commission_expense_account_id uuid,
  commission_payable_account_id uuid,
  -- ON_INVOICE: revenue at invoice. ON_DELIVERY: invoice auto-created at delivery.
  revenue_recognition        text NOT NULL DEFAULT 'ON_INVOICE' CHECK (revenue_recognition IN ('ON_INVOICE', 'ON_DELIVERY')),
  inventory_valuation        text NOT NULL DEFAULT 'WEIGHTED_AVERAGE' CHECK (inventory_valuation IN ('WEIGHTED_AVERAGE', 'FIFO')),
  FOREIGN KEY (tenant_id, ar_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, revenue_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_discount_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, vat_output_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cogs_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cash_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, commission_expense_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, commission_payable_account_id) REFERENCES chart_of_accounts (tenant_id, id)
);

CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number          text NOT NULL,
  entry_date      date NOT NULL,
  description     text,
  source_type     text,          -- INVOICE, RECEIPT, CREDIT_NOTE, DELIVERY, COMMISSION, MANUAL
  source_id       uuid,
  status          text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  reversal_of_id  uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX journal_entries_source_idx ON journal_entries (tenant_id, source_type, source_id);

CREATE TABLE journal_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  journal_entry_id  uuid NOT NULL,
  account_id        uuid NOT NULL,
  debit             numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit            numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  customer_id       uuid,
  description       text,
  CHECK ((debit = 0) <> (credit = 0)),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);

-- Every posted entry must balance; checked at commit so lines can be
-- inserted one at a time inside a transaction.
CREATE OR REPLACE FUNCTION journal_entry_must_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_id uuid := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  d numeric; c numeric; n integer;
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
    INTO d, c, n FROM journal_lines WHERE journal_entry_id = entry_id;
  IF n > 0 AND d <> c THEN
    RAISE EXCEPTION 'Journal entry % does not balance (debit %, credit %)', entry_id, d, c;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_must_balance();

-- ---------------------------------------------------------------------------
-- Accounts receivable
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  customer_id       uuid NOT NULL,
  branch_id         uuid,
  sales_order_id    uuid,          -- FK added in 0004 once sales_orders exists
  sales_rep_id      uuid,          -- FK added in 0004
  invoice_date      date NOT NULL,
  due_date          date NOT NULL,
  currency          char(3) NOT NULL,
  exchange_rate     numeric(18,8) NOT NULL DEFAULT 1,
  subtotal          numeric(18,2) NOT NULL,
  discount_total    numeric(18,2) NOT NULL DEFAULT 0,
  tax_total         numeric(18,2) NOT NULL DEFAULT 0,
  grand_total       numeric(18,2) NOT NULL,
  amount_paid       numeric(18,2) NOT NULL DEFAULT 0,
  amount_credited   numeric(18,2) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID')),
  journal_entry_id  uuid,
  notes             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  CHECK (amount_paid >= 0 AND amount_credited >= 0 AND amount_paid + amount_credited <= grand_total),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX invoices_customer_idx ON invoices (tenant_id, customer_id, status);
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  line_no             integer NOT NULL,
  product_id          uuid,
  description         text NOT NULL,
  quantity            numeric(18,4) NOT NULL,
  unit_price          numeric(18,4) NOT NULL,
  discount_amount     numeric(18,2) NOT NULL DEFAULT 0,
  tax_rate_percent    numeric(7,4) NOT NULL DEFAULT 0,
  tax_amount          numeric(18,2) NOT NULL DEFAULT 0,
  net_amount          numeric(18,2) NOT NULL,
  line_total          numeric(18,2) NOT NULL,
  sales_order_line_id uuid,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE TABLE customer_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  customer_id       uuid NOT NULL,
  receipt_date      date NOT NULL,
  amount            numeric(18,2) NOT NULL CHECK (amount > 0),
  currency          char(3) NOT NULL,
  payment_method    text NOT NULL,
  payment_reference text,
  deposit_account_id uuid,
  journal_entry_id  uuid,
  status            text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, deposit_account_id) REFERENCES chart_of_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);

CREATE TABLE receipt_allocations (
  tenant_id    uuid NOT NULL,
  receipt_id   uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (receipt_id, invoice_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES customer_receipts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE TABLE credit_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  customer_id       uuid NOT NULL,
  invoice_id        uuid,
  credit_date       date NOT NULL,
  reason            text NOT NULL,
  currency          char(3) NOT NULL,
  subtotal          numeric(18,2) NOT NULL,
  tax_total         numeric(18,2) NOT NULL DEFAULT 0,
  grand_total       numeric(18,2) NOT NULL CHECK (grand_total > 0),
  journal_entry_id  uuid,
  status            text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'VOID')),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);

CREATE TABLE credit_note_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  credit_note_id    uuid NOT NULL,
  line_no           integer NOT NULL,
  product_id        uuid,
  description       text NOT NULL,
  quantity          numeric(18,4) NOT NULL,
  unit_price        numeric(18,4) NOT NULL,
  tax_rate_percent  numeric(7,4) NOT NULL DEFAULT 0,
  tax_amount        numeric(18,2) NOT NULL DEFAULT 0,
  net_amount        numeric(18,2) NOT NULL,
  line_total        numeric(18,2) NOT NULL,
  restock           boolean NOT NULL DEFAULT false,
  UNIQUE (credit_note_id, line_no),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

-- Outstanding balance per customer (what reps may see when authorised).
CREATE VIEW customer_balances WITH (security_invoker = true) AS
SELECT i.tenant_id,
       i.customer_id,
       SUM(i.grand_total - i.amount_paid - i.amount_credited) AS outstanding,
       SUM(CASE WHEN i.due_date < CURRENT_DATE THEN i.grand_total - i.amount_paid - i.amount_credited ELSE 0 END) AS overdue,
       MIN(i.due_date) FILTER (WHERE i.grand_total - i.amount_paid - i.amount_credited > 0) AS oldest_due_date
FROM invoices i
WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID')
GROUP BY i.tenant_id, i.customer_id;
