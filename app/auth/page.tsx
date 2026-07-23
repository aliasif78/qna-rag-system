'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

// ---------------------------------------------------------------------------
// Password strength
// ---------------------------------------------------------------------------

interface StrengthRule {
  label: string;
  test: (pw: string) => boolean;
}

const STRENGTH_RULES: StrengthRule[] = [
  { label: 'At least 8 characters', test: (pw) => pw.length >= 8 },
  { label: 'Uppercase letter', test: (pw) => /[A-Z]/.test(pw) },
  { label: 'Lowercase letter', test: (pw) => /[a-z]/.test(pw) },
  { label: 'Number', test: (pw) => /[0-9]/.test(pw) },
  { label: 'Special character', test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

// The only hard gate: minimum length. The rest are informational.
function isPasswordEligible(password: string): boolean {
  return password.length >= 8;
}

// ---------------------------------------------------------------------------
// Eye icons (inline SVG — no external icon package needed)
// ---------------------------------------------------------------------------

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignUp = mode === 'signup';
  // Only enforce the eligibility gate in signup mode. Sign-in accepts whatever
  // the user types and lets the server return the error.
  const passwordEligible = !isSignUp || isPasswordEligible(password);
  const submitDisabled = loading || !email || !password || !passwordEligible;

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

  function handleModeToggle() {
    setMode(mode === 'signin' ? 'signup' : 'signin');
    setError(null);
    setShowPassword(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-white/10 bg-white/5 p-8 backdrop-blur-sm">
        {/* Header */}
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
            {isSignUp ? 'Create account' : 'Sign in'}
          </h1>
          <p className="text-sm text-white/40" style={{ fontFamily: 'var(--font-mono)' }}>
            {isSignUp ? 'Get started with the research assistant.' : 'Access the research assistant.'}
          </p>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-sky-400/50" style={{ fontFamily: 'var(--font-sans)' }} />

          {/* Password field with show/hide toggle */}
          <div className="relative">
            <input type={showPassword ? 'text' : 'password'} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={isSignUp ? 'new-password' : 'current-password'} className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 pr-10 text-sm text-white outline-none placeholder:text-white/30 focus:border-sky-400/50" style={{ fontFamily: 'var(--font-sans)' }} />
            <button type="button" onClick={() => setShowPassword((prev) => !prev)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer text-white/40 transition-colors hover:text-white/70">
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          {/* Password strength indicators — signup mode only, only when typing */}
          {isSignUp && password.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
              {STRENGTH_RULES.map((rule) => {
                const passed = rule.test(password);
                return (
                  <div key={rule.label} className="flex items-center gap-2">
                    <span className={`text-xs transition-colors ${passed ? 'text-sky-400' : 'text-white/25'}`} aria-hidden="true">
                      {passed ? '✓' : '○'}
                    </span>
                    <span className={`text-xs transition-colors ${passed ? 'text-white/70' : 'text-white/25'}`} style={{ fontFamily: 'var(--font-mono)' }}>
                      {rule.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-orange-400" style={{ fontFamily: 'var(--font-mono)' }}>
            {error}
          </p>
        )}

        {/* Submit */}
        <button onClick={handleSubmit} disabled={submitDisabled} className="w-full cursor-pointer rounded-lg border border-sky-400/30 bg-sky-400/10 px-5 py-2.5 text-sm text-sky-300 transition-colors hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-40" style={{ fontFamily: 'var(--font-mono)' }}>
          {loading ? (isSignUp ? 'Creating account…' : 'Signing in…') : isSignUp ? 'Create account' : 'Sign in'}
        </button>

        {/* Mode toggle */}
        <p className="text-center text-xs text-white/30" style={{ fontFamily: 'var(--font-mono)' }}>
          {isSignUp ? 'Already have an account?' : 'No account?'}{' '}
          <button onClick={handleModeToggle} className="cursor-pointer text-sky-400 transition-colors hover:text-sky-300">
            {isSignUp ? 'Sign in' : 'Sign up'}
          </button>
        </p>
      </div>
    </div>
  );
}
