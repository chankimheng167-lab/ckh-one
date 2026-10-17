'use client';
import { useState } from 'react';
import { PosShell, usePos } from '@/components/PosShell';
import { ApprovalSheet } from '@/components/PosApproval';
import { ErrorBox, Field, Page } from '@/components/ui';
import type { ApiError } from '@/lib/api';
import { useQueryParam } from '@/lib/hooks';
import { printReceipt } from '@/lib/receipt';

export default function ReceiptPage() {
  return (
    <PosShell needRegister={false}>
      <Receipt />
    </PosShell>
  );
}

/** Prints a sale receipt or refund slip (?id= sale, ?returnId= return) in the chosen paper size and language. */
function Receipt() {
  const saleId = useQueryParam('id');
  const returnId = useQueryParam('returnId');
  const { ctx } = usePos();
  const r = ctx.settings.receipt ?? {};
  const [paper, setPaper] = useState<'58' | '80' | 'A4'>(ctx.register?.hardware?.receiptPaper ?? r.paper ?? '80');
  const [language, setLanguage] = useState<'en' | 'km' | 'zh'>(r.languages?.[0] ?? 'en');
  const [html, setHtml] = useState<string | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function print(approval?: { userId: string; pin: string }) {
    setBusy(true);
    setError(null);
    try {
      setHtml(await printReceipt({ saleId: saleId ?? undefined, returnId: returnId ?? undefined, paper, language, approval }));
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'APPROVAL_REQUIRED') setAskPin(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (!saleId && !returnId) return <ErrorBox error="No receipt chosen." />;
  return (
    <Page title={returnId ? 'Refund slip' : 'Receipt'} subtitle="Each print is recorded. Printing again is a reprint, marked on the slip, and needs a supervisor unless you may reprint.">
      <div className="form-grid">
        <Field label="Paper">
          <select value={paper} onChange={(e) => setPaper(e.target.value as any)}><option value="58">58 mm</option><option value="80">80 mm</option><option value="A4">A4</option></select>
        </Field>
        <Field label="Language">
          <select value={language} onChange={(e) => setLanguage(e.target.value as any)}><option value="en">English</option><option value="km">ខ្មែរ (Khmer)</option><option value="zh">中文 (Chinese)</option></select>
        </Field>
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => print()}>Print</button>
        <a className="btn" href={saleId ? `/pos/sales/view/?id=${saleId}` : `/pos/returns/view/?id=${returnId}`}>Back</a>
      </div>
      <ErrorBox error={error} />
      {html && (
        <div className="card" style={{ maxWidth: paper === 'A4' ? 820 : 380 }}>
          <iframe title="Receipt" sandbox="" srcDoc={html} style={{ width: '100%', height: 640, border: 0, background: '#fff' }} />
        </div>
      )}
      {askPin && ctx.register && (
        <ApprovalSheet registerId={ctx.register.id} needs={['pos.receipts.reprint']} onClose={() => setAskPin(false)} onApprove={(a) => { setAskPin(false); void print(a); }} />
      )}
      {askPin && !ctx.register && <div className="notice warn">Choose a register first to ask a supervisor for approval.</div>}
    </Page>
  );
}
