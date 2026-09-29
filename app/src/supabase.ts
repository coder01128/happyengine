import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in app/.env.local — run "npm run seed" first.');
}

export const supabase = createClient(url, anonKey);
export const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

export type Role = 'uploader' | 'reviewer' | 'admin';

/** Calls an edge function as the signed-in user. Returns the JSON body, or throws its error message. */
export async function callFunction<T = unknown>(name: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Signed out — sign in again.');
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${name} failed (${res.status})`);
  return json as T;
}

/** Throws the PostgREST error message, so callers can show it. */
export function orThrow<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}
