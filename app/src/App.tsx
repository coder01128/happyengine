import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type ReactNode } from 'react';
import { ThemeButton } from './components/ui.tsx';
import { RunReview } from './pages/RunReview.tsx';
import { Runs } from './pages/Runs.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { isLocal, supabase, type Role } from './supabase.ts';

export interface Membership {
  orgId: string;
  orgName: string;
  role: Role;
}

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const run = hash.match(/^#\/run\/([0-9a-f-]{36})$/i)?.[1];
  return run ? ({ page: 'run', runId: run } as const) : ({ page: 'runs' } as const);
}

export const go = (hash: string) => {
  window.location.hash = hash;
};

function Shell({ crumb, onSignOut, children }: { crumb?: string; onSignOut?: () => void; children: ReactNode }) {
  return (
    <>
      <header className="top">
        {isLocal && <div className="banner">Local development · sample organisation and test users only</div>}
        <div className="bar">
          <div className="wrap">
            <a className="wordmark" href="#/">
              happyai
            </a>
            {crumb && <span className="crumb">{crumb}</span>}
            <div className="bar-end">
              <ThemeButton />
              {onSignOut && (
                <button type="button" className="btn btn-sm btn-quiet" onClick={onSignOut}>
                  Sign out
                </button>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className="wrap">{children}</main>
    </>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined);
  const route = useHashRoute();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) {
      setMembership(undefined);
      return;
    }
    supabase
      .from('memberships')
      .select('org_id, role, orgs(name)')
      .eq('user_id', userId)
      .then(({ data, error }) => {
        const first = !error && data?.[0];
        setMembership(
          first ? { orgId: first.org_id, role: first.role as Role, orgName: (first.orgs as unknown as { name: string }).name } : null,
        );
      });
  }, [userId]);

  if (session === undefined) return null;
  if (!session) {
    return (
      <Shell>
        <SignIn />
      </Shell>
    );
  }
  const signOut = () => supabase.auth.signOut();
  if (membership === undefined) return <Shell onSignOut={signOut}>{null}</Shell>;
  if (membership === null) {
    return (
      <Shell onSignOut={signOut}>
        <div className="center">
          <div className="card">
            <h2>No organisation yet</h2>
            <p className="muted sec-gap">This account isn’t linked to an organisation. happyai sets this up during onboarding.</p>
          </div>
        </div>
      </Shell>
    );
  }
  return (
    <Shell crumb={`Month-End · ${membership.orgName}`} onSignOut={signOut}>
      {route.page === 'run' ? (
        <RunReview runId={route.runId} membership={membership} userId={session.user.id} />
      ) : (
        <Runs membership={membership} />
      )}
    </Shell>
  );
}
