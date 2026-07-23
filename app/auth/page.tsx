"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setError(null);
    setLoading(true);

    const supabase = createSupabaseBrowserClient();

    const { error: authError } = mode === "signin" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });

    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className={`min-h-screen bg-black flex items-center justify-center px-4`}>
      <div className="w-full max-w-sm border border-white/10 bg-white/5 backdrop-blur-sm rounded-xl p-8 flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col gap-1">
          <h1 className="text-white text-lg font-semibold" style={{ fontFamily: "var(--font-mono)" }}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </h1>
          <p className="text-white/40 text-sm" style={{ fontFamily: "var(--font-mono)" }}>
            {mode === "signin" ? "Access the research assistant." : "Get started with the research assistant."}
          </p>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="border border-white/15 bg-white/5 rounded-lg px-4 py-2.5 text-white placeholder:text-white/30 focus:border-sky-400/50 outline-none text-sm w-full" style={{ fontFamily: "var(--font-sans)" }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} className="border border-white/15 bg-white/5 rounded-lg px-4 py-2.5 text-white placeholder:text-white/30 focus:border-sky-400/50 outline-none text-sm w-full" style={{ fontFamily: "var(--font-sans)" }} />
        </div>

        {/* Error */}
        {error && (
          <p className="text-orange-400 text-sm" style={{ fontFamily: "var(--font-mono)" }}>
            {error}
          </p>
        )}

        {/* Submit */}
        <button onClick={handleSubmit} disabled={loading || !email || !password} className="border border-sky-400/30 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20 rounded-lg px-5 py-2.5 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed w-full" style={{ fontFamily: "var(--font-mono)" }}>
          {loading ? (mode === "signin" ? "Signing in…" : "Creating account…") : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        {/* Mode toggle */}
        <p className="text-white/30 text-xs text-center" style={{ fontFamily: "var(--font-mono)" }}>
          {mode === "signin" ? "No account?" : "Already have an account?"}{" "}
          <button
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
            className="text-sky-400 hover:text-sky-300 transition-colors"
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
