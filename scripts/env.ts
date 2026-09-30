// One secrets file for edge functions and Node scripts: supabase/functions/.env (git-ignored).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './local.ts';

/** The parser versions pinned in the default Contracts preset, for scripts that call LlamaParse directly. */
export function pinnedVersions(): Record<string, string> | undefined {
  return JSON.parse(readFileSync(join(root, 'presets', 'contracts.default.json'), 'utf8')).parser?.versions;
}

export function loadSecrets(): void {
  const path = join(root, 'supabase', 'functions', '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
