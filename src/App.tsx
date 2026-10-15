import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { charCount, taipeiDay, validateInput, NAME_MAX, REASON_MAX, type Entry, type Status, type Today } from '../shared/model.js';
import { ApiError, getToday, removeEntry, saveEntry } from './api.js';
import { newOwnership, readOwnership, writeOwnership, type Ownership } from './ownership.js';

const initialForm = { name: '', status: '' as Status | '', reason: '', eta: '' };
const timeLabel = (value: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const dateLabel = (day: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${day}T12:00:00+08:00`));

export function App() {
  const [today, setToday] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState('');
  const [form, setForm] = useState(initialForm);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [owners, setOwners] = useState<Ownership[]>(readOwnership);
  const [draft, setDraft] = useState<Ownership | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [withdraw, setWithdraw] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const clock = useRef<{ server: number; local: number } | null>(null);
  const dayRef = useRef('');
  const readSequence = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const actionRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const remember = useCallback((items: Ownership[]) => { writeOwnership(items); setOwners(items); }, []);
  const changeDay = useCallback((day: string) => {
    if (dayRef.current && dayRef.current !== day) {
      setToday(previous => previous ? { ...previous, day, entries: [] } : previous);
      setEditing(null); setDraft(null); setWithdraw(null); setDuplicate(false); setConfirmed(false);
      setNotice('新的一天開始了，昨日登記已到期。尚未送出的內容仍保留，可登記今天狀態。');
    }
    dayRef.current = day;
    const valid = readOwnership().filter(owner => owner.day === day);
    try { remember(valid); } catch { setOwners(valid); }
  }, [remember]);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const value = await getToday();
      if (!mounted.current || sequence !== readSequence.current) return;
      clock.current = { server: Date.parse(value.serverNow), local: performance.now() };
      changeDay(value.day);
      setToday(value); setSyncError('');
    } catch (failure) {
      if (mounted.current && sequence === readSequence.current) setSyncError(failure instanceof Error ? failure.message : '名單更新失敗，將自動重試。');
    } finally { if (mounted.current) setLoading(false); }
  }, [changeDay]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      const current = clock.current;
      if (current) {
        const day = taipeiDay(new Date(current.server + performance.now() - current.local));
        if (day !== dayRef.current) { changeDay(day); void refresh(); }
      }
    }, 500);
    const poll = window.setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    const wake = () => {
      // Hide potentially expired content immediately when a suspended tab wakes.
      if (!document.hidden) {
        // performance.now() can pause during OS sleep on some devices. Until the
        // server answers, never redisplay a cached roster after a tab resumes.
        setToday(previous => previous && { ...previous, entries: [] });
        setLoading(true);
        const current = clock.current;
        if (current) changeDay(taipeiDay(new Date(current.server + performance.now() - current.local)));
        void refresh();
      }
    };
    const storage = () => setOwners(readOwnership().filter(owner => owner.day === dayRef.current));
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('storage', storage);
    return () => {
      mounted.current = false; clearInterval(timer); clearInterval(poll);
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake); window.removeEventListener('storage', storage);
    };
  }, [refresh, changeDay]);

  const update = (values: Partial<typeof form>) => { setForm(old => ({ ...old, ...values })); setError(''); setDuplicate(false); setConfirmed(false); };
  const reset = () => { setEditing(null); setDraft(null); setForm(initialForm); setError(''); setDuplicate(false); setConfirmed(false); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !today) return;
    const parsed = validateInput(form);
    if ('error' in parsed) { setError(parsed.error); return; }
    if (duplicate && !confirmed) { setError('請先確認是否為同名隊員。'); return; }
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const management = editing ? owners.find(owner => owner.id === editing) : draft || newOwnership(dayRef.current);
      if (!management) throw new Error('本裝置的管理憑證不存在，無法修改。');
      // Persist before transmission: a lost network response must not lose ownership.
      try { remember([...readOwnership().filter(item => item.id !== management.id && item.day === dayRef.current), management]); }
      catch { throw new Error('無法保存本機管理憑證。請允許網站儲存資料後重試；尚未送出登記。'); }
      if (!editing) setDraft(management);
      const result = await saveEntry(management.id, management.token, parsed.value, Boolean(editing), duplicate && confirmed);
      ++readSequence.current; // Invalidate an older poll that may still be in flight.
      if (dayRef.current && result.day < dayRef.current) {
        reset(); setNotice('這筆請求在午夜前收到，已隨昨日登記到期。若今天仍需請假或遲到，請重新登記。');
        void refresh(); return;
      }
      changeDay(result.day);
      const updatedOwner = { ...management, day: result.day };
      try { remember([...readOwnership().filter(item => item.id !== management.id && item.day === result.day), updatedOwner]); }
      catch { setOwners(old => [...old.filter(item => item.id !== management.id), updatedOwner]); }
      setToday(old => ({ day: result.day, serverNow: result.serverNow, nextResetAt: result.nextResetAt, entries: [result.entry, ...(old?.day === result.day ? old.entries.filter(entry => entry.id !== result.entry.id) : [])] }));
      setNotice(editing ? '已更新你的登記，隊友的名單會自動同步。' : '登記成功！可在本裝置修改或撤回。');
      reset(); void refresh();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'DUPLICATE_NAME') { setDuplicate(true); setConfirmed(false); }
      setError(failure instanceof Error ? failure.message : '送出失敗，請重試。');
    } finally { busyRef.current = false; setBusy(false); }
  }

  function editEntry(entry: Entry) {
    if (busyRef.current || actionRef.current) return;
    setEditing(entry.id); setDraft(null); setForm({ name: entry.name, status: entry.status, reason: entry.reason, eta: entry.eta || '' });
    setError(''); setNotice(''); setDuplicate(false); setConfirmed(false); setWithdraw(null);
    formRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    formRef.current?.querySelector<HTMLInputElement>('#name')?.focus({ preventScroll: true });
  }
  async function deleteEntry(id: string) {
    if (actionRef.current || busyRef.current) return;
    const owner = owners.find(item => item.id === id);
    if (!owner) return;
    actionRef.current = true; setActionId(id); setActionError('');
    try {
      try { await removeEntry(id, owner.token); }
      catch (failure) { if (!(failure instanceof ApiError && failure.code === 'NOT_FOUND')) throw failure; }
      ++readSequence.current;
      setToday(old => old && { ...old, entries: old.entries.filter(entry => entry.id !== id) });
      try { remember(readOwnership().filter(item => item.id !== id)); } catch { setOwners(old => old.filter(item => item.id !== id)); }
      if (editing === id) reset();
      setWithdraw(null); setNotice('已撤回登記。若恢復正常出席，不需再填寫。'); void refresh();
    } catch (failure) { setActionError(failure instanceof Error ? failure.message : '撤回失敗，請重試。'); }
    finally { actionRef.current = false; setActionId(null); }
  }

  const entries = today?.entries || [];
  const leave = entries.filter(entry => entry.status === 'leave').length;
  const late = entries.length - leave;
  const visible = entries.filter(entry => filter === 'all' || entry.status === filter);

  return <div className="app-shell">
    <header className="page-header">
      <div className="brand"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 23c-6-6-3-16 4-18 8-3 16 5 13 13-2 5-7 8-12 6l-5 5-4-4z"/><path d="m8 23 5-5"/><circle cx="25" cy="26" r="3"/></svg></span><span>TABLE TENNIS<span className="brand-sub">TEAM CHECK-IN</span></span></div>
      <span className="day-pill"><span className="live-dot" />僅限今日</span>
    </header>
    <main>
      <section className="intro" aria-labelledby="title">
        <p className="eyebrow">STAY IN THE LOOP · 讓隊友知道</p>
        <div className="title-row"><h1 id="title">桌球隊出席登記<span className="title-dot">.</span></h1><span className="today-date">{today ? dateLabel(today.day) : '正在取得台灣日期…'}</span></div>
        <p className="intro-copy">請假或遲到才需填寫，<strong>正常出席不用登記。</strong></p>
        <p className="reset-note"><span aria-hidden="true">◷</span> 僅登記今日狀態，每日 00:00（台灣時間）清除。</p>
      </section>

      <div className="notice" role="status" aria-live="polite">{notice}</div>
      <div className="workspace">
        <section className="card form-card" aria-labelledby="form-title">
          <div className="section-heading"><span className="section-number">01</span><div><h2 id="form-title">{editing ? '修改我的登記' : '登記今日狀態'}</h2><p>{editing ? '調整行程，讓隊友掌握最新消息。' : '花一點時間，讓團隊好安排。'}</p></div><span className="required-hint">* 必填</span></div>
          <form onSubmit={submit} ref={formRef} noValidate>
            <fieldset disabled={busy || Boolean(actionId)} className="form-fields">
              <div className="field"><label htmlFor="name">姓名 <span className="required">*</span></label><input id="name" name="name" autoComplete="name" placeholder="請輸入你的姓名" value={form.name} onChange={event => update({ name: event.target.value })} aria-required="true" maxLength={NAME_MAX * 2} /><span className={'counter' + (charCount(form.name.trim()) > NAME_MAX ? ' over' : '')}>{charCount(form.name.trim())} / {NAME_MAX}</span></div>
              <fieldset className="status-field"><legend>今日狀態 <span className="required">*</span></legend><div className="status-options">
                <button type="button" className={'status-option leave-option' + (form.status === 'leave' ? ' selected' : '')} aria-pressed={form.status === 'leave'} onClick={() => update({ status: 'leave', eta: '' })}><span className="status-symbol" aria-hidden="true">−</span><span><b>請假</b><small>今天無法出席</small></span><span className="choice-dot" aria-hidden="true" /></button>
                <button type="button" className={'status-option late-option' + (form.status === 'late' ? ' selected' : '')} aria-pressed={form.status === 'late'} onClick={() => update({ status: 'late' })}><span className="status-symbol" aria-hidden="true">◷</span><span><b>遲到</b><small>會晚一點抵達</small></span><span className="choice-dot" aria-hidden="true" /></button>
              </div></fieldset>
              {form.status === 'late' && <div className="field eta-field"><label htmlFor="eta">預計抵達時間 <span className="optional">選填 · 台灣時間</span></label><input id="eta" name="eta" type="time" value={form.eta} onChange={event => update({ eta: event.target.value })} /></div>}
              <div className="field"><label htmlFor="reason">原因 <span className="required">*</span></label><textarea id="reason" name="reason" rows={4} placeholder="簡單說明原因，讓隊友了解你的狀況…" value={form.reason} onChange={event => update({ reason: event.target.value })} maxLength={REASON_MAX * 2} aria-required="true" /><span className={'counter' + (charCount(form.reason.trim()) > REASON_MAX ? ' over' : '')}>{charCount(form.reason.trim())} / {REASON_MAX}</span></div>
              <p className="privacy-note"><span aria-hidden="true">ⓘ</span> 姓名與原因將公開顯示，請勿填寫敏感個資。</p>
              {duplicate && <div className="duplicate-box"><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我是同名隊員，確認新增／更新自己的登記。</label><p>若先前是你本人填寫，請從名單使用「修改」。不同裝置無法管理原登記。</p></div>}
              {error && <p className="error-box" role="alert">{error}</p>}
              <div className="submit-row"><button className="primary-button" type="submit" disabled={busy || !today || Boolean(actionId)}>{busy ? <><span className="spinner" />處理中…</> : <>{error && !duplicate ? '重試送出' : editing ? '儲存修改' : '送出今日登記'}<span aria-hidden="true">↗</span></>}</button>{editing && <button type="button" className="secondary-button" onClick={reset}>取消修改</button>}</div>
            </fieldset>
          </form>
          <p className="device-note">可在本裝置修改或撤回；更換裝置後無法管理原登記。</p>
        </section>

        <section className="list-section" aria-labelledby="list-title">
          <div className="list-top"><div className="section-heading"><span className="section-number">02</span><div><h2 id="list-title">今日公開名單</h2><p>只顯示請假與遲到登記</p></div></div><span className={'sync-state' + (syncError ? ' disconnected' : '')}><span className="live-dot" />{syncError ? '連線中斷' : loading ? '連線中' : '自動同步'}</span></div>
          <div className="summary" aria-label="今日登記人數"><div><span className="summary-marker leave-marker" /><span>請假</span><strong>{leave}</strong><span>人</span></div><div><span className="summary-marker late-marker" /><span>遲到</span><strong>{late}</strong><span>人</span></div></div>
          <div className="list-toolbar"><div className="filters" aria-label="篩選名單">{(['all', 'leave', 'late'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : value === 'leave' ? '請假' : '遲到'}</button>)}</div><span className="list-count">{visible.length} 筆登記</span></div>
          {syncError && <div className="error-box sync-error" role="alert">{syncError} 名單可能尚未更新。<button type="button" onClick={() => void refresh()}>重新連線</button></div>}
          {loading && <div className="card empty-state" role="status"><span className="spinner dark" /><p>正在讀取今日登記…</p></div>}
          {!loading && !today && <div className="card empty-state"><p>暫時無法取得今日名單。</p><small>請確認連線後重試；尚未送出任何資料。</small><button className="secondary-button" onClick={() => void refresh()}>重試讀取</button></div>}
          {!loading && today && visible.length === 0 && <div className="card empty-state"><span className="empty-icon" aria-hidden="true">◎</span><h3>{entries.length === 0 ? '今天還沒有人登記請假或遲到。' : `今天還沒有${filter === 'leave' ? '請假' : '遲到'}登記。`}</h3><p>正常出席不用填寫。</p><span className="empty-rule" /><small>一起準時上場，好好練球。</small></div>}
          <div className="entry-list" aria-live="polite" aria-relevant="additions removals">{visible.map(entry => {
            const own = owners.some(owner => owner.id === entry.id && owner.day === entry.day);
            return <article className={'card entry-card ' + entry.status} key={entry.id}>
              <div className="entry-top"><div className="entry-person"><span className={'avatar ' + entry.status} aria-hidden="true">{Array.from(entry.name)[0]}</span><div><h3>{entry.name}</h3>{own && <span className="own-label">我的登記</span>}</div></div><span className={'badge ' + entry.status}>{entry.status === 'leave' ? '請假' : '遲到'}</span></div>
              <p className="entry-reason">{entry.reason}</p>
              {entry.eta && <p className="entry-eta"><span aria-hidden="true">◷</span> 預計 {entry.eta} 抵達</p>}
              <div className="entry-footer"><time dateTime={entry.createdAt}>{timeLabel(entry.createdAt)} 登記{entry.updatedAt !== entry.createdAt ? ' · 已修改' : ''}</time>{own && <div className="entry-actions"><button type="button" disabled={busy || Boolean(actionId)} onClick={() => editEntry(entry)}>修改</button><button type="button" disabled={busy || Boolean(actionId)} onClick={() => { setWithdraw(entry.id); setActionError(''); }}>撤回</button></div>}</div>
              {withdraw === entry.id && <div className="withdraw-box"><p>確定撤回這筆登記？</p><div><button className="danger-button" disabled={Boolean(actionId)} onClick={() => void deleteEntry(entry.id)}>{actionId === entry.id ? '撤回中…' : '確認撤回'}</button><button className="secondary-button" disabled={Boolean(actionId)} onClick={() => setWithdraw(null)}>保留登記</button></div>{actionError && <p role="alert" className="action-error">{actionError}</p>}</div>}
            </article>;
          })}</div>
          <p className="list-footnote">每 10 秒同步 · 登記時間皆為台灣時間</p>
        </section>
      </div>
    </main>
    <footer className="page-footer"><span>ONE TEAM. SAME TABLE.</span><p>今日的安排，讓彼此都知道。</p></footer>
  </div>;
}
