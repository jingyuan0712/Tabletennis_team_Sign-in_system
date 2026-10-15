export type Ownership = { id: string; token: string; day: string };
const KEY = 'table-tennis:management:v1';
export function readOwnership(): Ownership[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((v): v is Ownership => v && typeof v.id === 'string' && typeof v.day === 'string' && typeof v.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.token)) : [];
  } catch { return []; }
}
export function writeOwnership(value: Ownership[]) {
  localStorage.setItem(KEY, JSON.stringify(value));
}
export function newOwnership(day: string): Ownership {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return { id: crypto.randomUUID(), token, day };
}
