import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { adminLogin, adminLogout, adminStatus, ApiError, type AdminLogin } from './api.js';
const KEY = 'table-tennis:admin-session:v1';

export function useAdminSession() {
  const [session, setSession] = useState<AdminLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expire = useCallback(() => {
    ++generation.current;
    clearTimeout(timeout.current);
    try { sessionStorage.removeItem(KEY); } catch { /* memory session already cleared */ }
    setSession(null); setError('登入已到期，請重新登入管理員。');
  }, []);
  const accept = useCallback((value: AdminLogin) => {
    clearTimeout(timeout.current);
    try { sessionStorage.setItem(KEY, value.token); } catch { /* usable in memory until reload */ }
    setSession(value); setError('');
    // Server-supplied duration; never rely on the device's wall clock.
    timeout.current = setTimeout(expire, Math.max(0, Date.parse(value.expiresAt) - Date.parse(value.serverNow)));
  }, [expire]);
  useEffect(() => {
    let active = true;
    const check = async () => {
      let token;
      try { token = sessionStorage.getItem(KEY); } catch { return; }
      if (!token) return;
      const current = generation.current;
      try {
        const value = await adminStatus(token);
        if (active && current === generation.current) accept({ ...value, token });
      } catch (failure) {
        if (active && current === generation.current) {
          if (failure instanceof ApiError && failure.code === 'ADMIN_UNAUTHORIZED') expire();
          else setError('無法確認管理員登入，請確認網路後重試登入。');
        }
      }
    };
    void check();
    const wake = () => { if (!document.hidden) void check(); };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { active = false; clearTimeout(timeout.current); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [accept, expire]);
  const login = async (username: string, password: string) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    const current = ++generation.current;
    try {
      const result = await adminLogin(username, password);
      if (current === generation.current) accept(result);
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : '登入失敗，請重試。'); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  const logout = async () => {
    if (!session || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    ++generation.current;
    try {
      await adminLogout(session.token);
      clearTimeout(timeout.current);
      try { sessionStorage.removeItem(KEY); } catch { /* cleared from memory below */ }
      setSession(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '登出失敗，請重試。'); }
    finally { pending.current = false; setBusy(false); }
  };
  return { session, busy, error, login, logout, expire };
}

export function AdminPanel({ admin }: { admin: ReturnType<typeof useAdminSession> }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await admin.login(username, password)) { setPassword(''); setOpen(false); }
  }
  return <section className="admin-section" aria-label="管理員功能">
    {admin.session ? <div className="admin-session-bar"><p role="status">管理員 {admin.session.username} 已登入，可修改或刪除今日所有登記。</p><button type="button" className="secondary-button" disabled={admin.busy} onClick={() => void admin.logout()}>{admin.busy ? '處理中…' : '登出管理員'}</button></div>
      : <button type="button" className="admin-toggle" aria-expanded={open} aria-controls="admin-login" onClick={() => { setOpen(value => !value); setPassword(''); }}>{open ? '關閉管理員登入' : '管理員登入'}</button>}
    {!admin.session && open && <form id="admin-login" className="card admin-login" onSubmit={submit} aria-label="管理員登入表單">
      <h2>管理員登入</h2><p>僅管理員需要登入，隊員可直接登記。</p>
      <fieldset disabled={admin.busy}><div className="field"><label htmlFor="admin-username">管理員帳號</label><input id="admin-username" autoComplete="username" value={username} maxLength={64} required onChange={event => setUsername(event.target.value)} /></div>
        <div className="field"><label htmlFor="admin-password">管理員密碼</label><input id="admin-password" type="password" autoComplete="current-password" value={password} maxLength={256} required onChange={event => setPassword(event.target.value)} /></div>
        <button className="primary-button" type="submit" disabled={admin.busy}>{admin.busy ? '登入中…' : '登入管理員'}</button>
      </fieldset><small>登入最長 2 小時，可隨時登出。</small>
    </form>}
    {admin.error && <p className="error-box admin-error" role="alert">{admin.error}</p>}
  </section>;
}
