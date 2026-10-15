export const TIME_ZONE = 'Asia/Taipei';
export const NAME_MAX = 20;
export const REASON_MAX = 200;
export type Status = 'leave' | 'late';
export type EntryInput = { name: string; status: Status; reason: string; eta: string | null };
export type Entry = EntryInput & { id: string; day: string; createdAt: string; updatedAt: string };
export type Today = { day: string; serverNow: string; nextResetAt: string; entries: Entry[] };

export function taipeiDay(now: Date): string {
  // Fixed UTC+8: Taiwan has no daylight saving. Never use the host/device local date.
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function nextReset(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + 86_400_000).toISOString();
}
export const charCount = (value: string) => Array.from(value).length;

export function validateInput(raw: unknown): { value: EntryInput } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: '請填寫完整資料。' };
  const data = raw as Record<string, unknown>;
  if (typeof data.name !== 'string' || typeof data.reason !== 'string') return { error: '請填寫姓名與原因。' };
  const name = data.name.trim().normalize('NFC');
  const reason = data.reason.trim().normalize('NFC');
  if (!name || charCount(name) > NAME_MAX || /[\u0000-\u001f\u007f]/u.test(name)) return { error: '姓名必填，最多 20 字，且不能包含換行或控制字元。' };
  if (!reason || charCount(reason) > REASON_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) return { error: '原因必填，最多 200 字，且不能包含控制字元。' };
  if (data.status !== 'leave' && data.status !== 'late') return { error: '請選擇請假或遲到。' };
  let eta: string | null = null;
  if (data.status === 'late' && data.eta !== null && data.eta !== undefined && data.eta !== '') {
    if (typeof data.eta !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.eta)) return { error: '預計抵達時間格式應為 HH:mm。' };
    eta = data.eta;
  }
  return { value: { name, status: data.status, reason, eta } };
}
