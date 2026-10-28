'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const s = useSession();
  const [tenantCode, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState<{ companyDisplayName: string | null; logoUrl: string | null } | null>(null);

  useEffect(() => {
    try {
      setTenant(localStorage.getItem('ckh.tenant') ?? '');
    } catch { /* ignore */ }
  }, []);
  // Show the company's own branding as soon as the company code is known.
  useEffect(() => {
    if (tenantCode.length < 3) return;
    const t = setTimeout(() => {
      api.get(`/auth/theme?tenantCode=${encodeURIComponent(tenantCode)}`).then((th) => {
        s.applyTheme(th.cssVariables);
        setBrand(th);
      }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [tenantCode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await s.login(tenantCode.trim(), email.trim(), password);
      try { localStorage.setItem('ckh.tenant', tenantCode.trim()); } catch { /* ignore */ }
      location.href = '/';
    } catch (err) {
      setError((err as Error).message === 'You appear to be offline' ? 'You are offline. Sign in once while online to use the app offline.' : 'Company code, email or password is incorrect.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card stack" style={{ width: '100%', maxWidth: 380 }} onSubmit={submit}>
        <div className="brand" style={{ fontSize: '1.2rem' }}>
          {brand?.logoUrl ? <img src={brand.logoUrl} alt="" /> : <span className="logo">C1</span>}
          {brand?.companyDisplayName ?? 'CKH ONE'}
        </div>
        <div className="muted small">Sign in to the sales app</div>
        <label className="field"><span>Company code</span><input value={tenantCode} onChange={(e) => setTenant(e.target.value)} autoCapitalize="none" required /></label>
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="notice bad">{error}</div>}
        <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="small muted">Platform owner? <a href="/platform/">Super Admin sign-in</a></div>
      </form>
    </div>
  );
}
