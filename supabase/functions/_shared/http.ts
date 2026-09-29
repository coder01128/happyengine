import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

/** Wraps a handler: CORS preflight, POST only, HttpError → JSON error response. */
export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Unexpected error' });
    }
  };
}

function env(name: string) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** The signed-in caller, plus a service-role client for server-side reads and writes. */
export async function requireUser(req: Request): Promise<{ user: User; admin: SupabaseClient }> {
  const authorization = req.headers.get('Authorization');
  if (!authorization) throw new HttpError(401, 'Sign in required');
  const url = env('SUPABASE_URL');
  const userClient = createClient(url, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'Sign in required');
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  return { user: data.user, admin };
}

/** Non-members get 404 (a run or agreement in another organisation doesn't exist for them); wrong role gets 403. */
export async function requireRole(admin: SupabaseClient, orgId: string, userId: string, roles: string[], subject = 'Run') {
  const { data, error } = await admin
    .from('memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, `${subject} not found`);
  if (!roles.includes(data.role)) throw new HttpError(403, `Needs one of: ${roles.join(', ')}`);
}

export async function readRunId(req: Request): Promise<string> {
  const body = await req.json().catch(() => null);
  const runId = body?.runId;
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) throw new HttpError(400, 'runId (uuid) required');
  return runId;
}

/** The request's JSON body, and its `field` as a uuid. */
export async function readIdField(req: Request, field: string): Promise<{ id: string; body: Record<string, unknown> }> {
  const body = await req.json().catch(() => null);
  const id = body?.[field];
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, `${field} (uuid) required`);
  return { id, body };
}

export async function loadAgreement(admin: SupabaseClient, agreementId: string) {
  const { data, error } = await admin.from('agreements').select('*').eq('id', agreementId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Agreement not found');
  return data;
}

export async function loadRun(admin: SupabaseClient, runId: string) {
  const { data, error } = await admin.from('runs').select('*').eq('id', runId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Run not found');
  return data;
}
