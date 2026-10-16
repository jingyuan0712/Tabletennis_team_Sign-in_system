import type { Entry, EntryInput, Today } from '../shared/model.js';
import type { AdminSession } from '../shared/admin-auth.js';
// Public URL only. Never place a Cloudflare API token or management key here.
const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(apiBase + path, { ...init, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12_000) }); }
  catch { throw new ApiError('NETWORK', '連線失敗，輸入內容已保留。請確認網路後重試。'); }
  if (response.status === 204) return undefined as T;
  let data: any;
  try { data = await response.json(); } catch { throw new ApiError('SERVER', '服務暫時無法使用，請稍後重試。'); }
  if (!response.ok) throw new ApiError(data.code || 'SERVER', data.message || '操作失敗，請重試。');
  return data as T;
}
export const getToday = () => request<Today>('/api/today');
export const saveEntry = (id: string, token: string, value: EntryInput, editing: boolean, confirmSameName: boolean) => request<{ entry: Entry; day: string; serverNow: string; nextResetAt: string }>(editing ? `/api/entries/${id}` : '/api/entries', {
  method: editing ? 'PUT' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ ...value, id, confirmSameName }),
});
export const removeEntry = (id: string, token: string) => request<void>(`/api/entries/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });

export type AdminLogin = AdminSession & { token: string };
const adminHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
export const adminLogin = (username: string, password: string) => request<AdminLogin>('/api/admin/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
});
export const adminStatus = (token: string) => request<AdminSession>('/api/admin/session', { headers: adminHeaders(token) });
export const adminLogout = (token: string) => request<void>('/api/admin/session', { method: 'DELETE', headers: adminHeaders(token) });
export const adminSaveEntry = (id: string, token: string, value: EntryInput, confirmSameName: boolean) => request<{ entry: Entry; day: string; serverNow: string; nextResetAt: string }>(`/api/admin/entries/${id}`, {
  method: 'PUT', headers: { ...adminHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, confirmSameName }),
});
export const adminRemoveEntry = (id: string, token: string) => request<void>(`/api/admin/entries/${id}`, { method: 'DELETE', headers: adminHeaders(token) });
