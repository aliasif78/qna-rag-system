'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setError(null);
    setLoading(true);

    const supabase = createSupabaseBrowserClient();

    const { error: authError } = mode === 'signin' ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });

    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <div className={`flex min-h-screen items-center justify-center bg-black px-4`}>
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-white/10 bg-white/5 p-8 backdrop-blur-sm">
        {/* Header */}
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </h1>
          <p className="text-sm text-white/40" style={{ fontFamily: 'var(--font-mono)' }}>
            {mode === 'signin' ? 'Access the research assistant.' : 'Get started with the research assistant.'}
          </p>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-sky-400/50" style={{ fontFamily: 'var(--font-sans)' }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-sky-400/50" style={{ fontFamily: 'var(--font-sans)' }} />
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-orange-400" style={{ fontFamily: 'var(--font-mono)' }}>
            {error}
          </p>
        )}

        {/* Submit */}
        <button onClick={handleSubmit} disabled={loading || !email || !password} className="w-full cursor-pointer rounded-lg border border-sky-400/30 bg-sky-400/10 px-5 py-2.5 text-sm text-sky-300 transition-colors hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-40" style={{ fontFamily: 'var(--font-mono)' }}>
          {loading ? (mode === 'signin' ? 'Signing in…' : 'Creating account…') : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        {/* Mode toggle */}
        <p className="text-center text-xs text-white/30" style={{ fontFamily: 'var(--font-mono)' }}>
          {mode === 'signin' ? 'No account?' : 'Already have an account?'}{' '}
          <button
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError(null);
            }}
            className="cursor-pointer text-sky-400 transition-colors hover:text-sky-300">
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
