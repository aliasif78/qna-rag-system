// app/auth/page.tsx

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

// All rules are now a hard gate, not just the length check. Note this is
// STILL only client-side UX — it prevents the submit button from being
// clicked, nothing more. A request sent directly to Supabase's REST API
// bypasses this file entirely. The actual enforcement boundary is Supabase
// Auth's server-side "Password Requirements" setting (Dashboard >
// Authentication > Policies). If that's not set to require digits + symbols,
// none of this is enforced anywhere — verify it before claiming it's
// enforced.
function isPasswordEligible(password: string): boolean {
  return STRENGTH_RULES.every((rule) => rule.test(password));
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

  // Set only when signUp succeeds but returns no session — i.e. Supabase's
  // "Confirm email" setting is on and the account is pending verification.
  // This is NOT an error: authError is null in this case. It must be tracked
  // separately, because it changes the entire screen (no form, no redirect).
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const isSignUp = mode === 'signup';
  // Only enforce the eligibility gate in signup mode. Sign-in accepts whatever
  // the user types and lets the server return the error.
  const passwordEligible = !isSignUp || isPasswordEligible(password);
  const submitDisabled = loading || !email || !password || !passwordEligible;

  async function handleSubmit() {
    setError(null);
    setLoading(true);

    const supabase = createSupabaseBrowserClient();

    if (mode === 'signin') {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

      setLoading(false);

      if (authError) {
        setError(authError.message);
        return;
      }

      router.push('/');
      router.refresh();
      return;
    }

    // --- signup ---
    const { data, error: authError } = await supabase.auth.signUp({ email, password });

    setLoading(false);

    if (authError) {
      // If Supabase's server-side password policy is configured (Dashboard >
      // Authentication > Policies) and rejects a weak password, it surfaces
      // here as authError even if the client gate above somehow passed it
      // (e.g. gate logic drifts from server policy in the future). Don't
      // assume client-side pass == server-side pass.
      setError(authError.message);
      return;
    }

    // Supabase does NOT return an error when email confirmation is required.
    // It returns data.user populated and data.session: null. Redirecting here
    // unconditionally is the bug: proxy.ts's getUser() finds no session on
    // the next request and bounces the new user straight back to /auth with
    // no explanation. A null session on signUp is the actual signal to check.
    if (!data.session) {
      setPendingConfirmationEmail(email);
      return;
    }

    // Confirmation is disabled on this project (or the user was auto-confirmed
    // some other way) — a real session came back, so proceed as before.
    router.push('/');
    router.refresh();
  }

  async function handleResend() {
    if (!pendingConfirmationEmail) return;

    setResendState('sending');
    const supabase = createSupabaseBrowserClient();

    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: pendingConfirmationEmail,
    });

    setResendState(resendError ? 'error' : 'sent');
  }

  function handleModeToggle() {
    setMode(mode === 'signin' ? 'signup' : 'signin');
    setError(null);
    setShowPassword(false);
    setPendingConfirmationEmail(null);
    setResendState('idle');
  }

  function handleBackToSignIn() {
    setPendingConfirmationEmail(null);
    setResendState('idle');
    setMode('signin');
    setEmail('');
    setPassword('');
    setError(null);
  }

  // ---------------------------------------------------------------------
  // Confirmation-pending screen — replaces the form entirely. Showing the
  // form again alongside a message invites the user to just resubmit,
  // which re-triggers signUp against an existing unconfirmed account.
  // ---------------------------------------------------------------------
  if (pendingConfirmationEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black px-4">
        <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-white/10 bg-white/5 p-8 backdrop-blur-sm">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
              Check your email
            </h1>
            <p className="text-sm text-white/40" style={{ fontFamily: 'var(--font-mono)' }}>
              We sent a confirmation link to <span className="text-white/70">{pendingConfirmationEmail}</span>. Click it to activate your account, then sign in.
            </p>
          </div>

          {resendState === 'sent' && (
            <p className="text-sm text-sky-400" style={{ fontFamily: 'var(--font-mono)' }}>
              Confirmation email resent.
            </p>
          )}
          {resendState === 'error' && (
            <p className="text-sm text-orange-400" style={{ fontFamily: 'var(--font-mono)' }}>
              Could not resend. Try again shortly.
            </p>
          )}

          <button onClick={handleResend} disabled={resendState === 'sending'} className="w-full cursor-pointer rounded-lg border border-sky-400/30 bg-sky-400/10 px-5 py-2.5 text-sm text-sky-300 transition-colors hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-40" style={{ fontFamily: 'var(--font-mono)' }}>
            {resendState === 'sending' ? 'Sending…' : 'Resend confirmation email'}
          </button>

          <button onClick={handleBackToSignIn} className="text-center text-xs text-sky-400 transition-colors hover:text-sky-300" style={{ fontFamily: 'var(--font-mono)' }}>
            Back to sign in
          </button>
        </div>
      </div>
    );
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
