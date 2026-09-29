import { useState, type FormEvent } from 'react';
import { isLocal, supabase } from '../supabase.ts';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message);
  };

  return (
    <div className="center">
      <form className="card" style={{ width: 'min(420px, 100%)' }} onSubmit={submit} noValidate>
        <div className="eyebrow">Happy Month-End</div>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Sign in</h1>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !email || !password} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        {isLocal && <p className="small muted sec-gap">Local test users are listed in .local/dev-users.json (created by npm run seed).</p>}
      </form>
    </div>
  );
}
