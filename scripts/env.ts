// One secrets file for edge functions and Node scripts: supabase/functions/.env (git-ignored).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './local.ts';

export function loadSecrets(): void {
  const path = join(root, 'supabase', 'functions', '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
