// Connection details for the LOCAL Supabase stack. Refuses anything that isn't localhost,
// so scripts that create test users and delete data can never touch a hosted project.

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

export const root = join(import.meta.dirname, '..');

export function localKeys() {
  const status = JSON.parse(execSync('supabase status -o json', { cwd: root, encoding: 'utf8' }));
  const url: string = status.API_URL;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`Refusing to run against non-local ${url}`);
  return { url, anon: status.ANON_KEY as string, service: status.SERVICE_ROLE_KEY as string };
}

export const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

export function adminClient() {
  const { url, service } = localKeys();
  return createClient(url, service, noSession);
}
