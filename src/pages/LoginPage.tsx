// src/pages/LoginPage.tsx
import { useSignIn } from '@clerk/clerk-react';
import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';

// ✅ Removed 'second_factor' and 'email_code' steps
type Step = 'credentials';

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn, isLoaded: signInLoaded, setActive } = useSignIn();

  const [email,        setEmail]        = useState('');
  const [password,     setPassword]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting,   setSubmitting]   = useState(false);
  const [error,        setError]        = useState('');
  const [fieldErrors,  setFieldErrors]  = useState<Record<string, string>>({});
  const [mounted,      setMounted]      = useState(false);

  useEffect(() => {
    setTimeout(() => setMounted(true), 50);
  }, []);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!email.trim())                    errs.email    = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(email)) errs.email    = 'Enter a valid email';
    if (!password)                         errs.password = 'Password is required';
    return errs;
  };

  async function finishSignIn(sessionId: string) {
    await setActive({ session: sessionId });
    navigate('/');
  }

  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signInLoaded) return;

    const errs = validate();
    if (Object.keys(errs).length) { setFieldErrors(errs); return; }

    setFieldErrors({});
    setError('');
    setSubmitting(true);

    try {
      const result = await signIn.create({ identifier: email, password });

      console.log('[Login] Status:', result.status);

      if (result.status === 'complete') {
        await finishSignIn(result.createdSessionId!);
        return;
      }

      // ✅ Catch any unexpected status and show a clear message
      setError(
        `Sign-in returned unexpected status: "${result.status}". ` +
        `Please disable 2FA in your Clerk dashboard.`
      );

    } catch (err: any) {
      const clerkError = err?.errors?.[0];
      setError(clerkError?.longMessage || clerkError?.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Error Banner ────────────────────────────────────────────
  const ErrorBanner = () => error ? (
    <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-3">
      <span className="text-red-400 text-lg leading-none mt-0.5">⚠</span>
      <p className="text-red-400 text-sm leading-relaxed">{error}</p>
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-[#080808] flex items-center justify-center px-4 relative overflow-hidden">

      {/* Background glows */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-red-900/20 rounded-full blur-[120px]" />
        <div className="absolute top-0 left-0 w-96 h-96 bg-red-800/10 rounded-full blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-orange-900/10 rounded-full blur-[100px]" />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
          }}
        />
      </div>

      <div className={`
        relative w-full max-w-md transition-all duration-700 ease-out
        ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}
      `}>

        {/* Logo */}
        <div className="text-center mb-10">
          <Link to="/" className="inline-flex items-center gap-3">
            <div className="relative">
              <div className="w-12 h-12 bg-red-600 rounded-xl flex items-center justify-center shadow-lg shadow-red-900/50">
                <span className="text-2xl">⚔️</span>
              </div>
              <div className="absolute inset-0 rounded-xl bg-red-500/20 blur-md -z-10 scale-125" />
            </div>
            <div className="text-left">
              <h1 className="text-3xl font-black text-white tracking-wider leading-none">SAMURAI</h1>
              <p className="text-red-400 text-xs font-medium tracking-widest uppercase">Anime Universe</p>
            </div>
          </Link>
        </div>

        <div className="relative">
          <div className="absolute -inset-[1px] bg-gradient-to-b from-red-500/30 via-zinc-800/50 to-zinc-900/30 rounded-2xl blur-sm" />

          <div className="relative bg-zinc-900/90 backdrop-blur-xl border border-zinc-800/80 rounded-2xl p-8 shadow-2xl">
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-white">Welcome back</h2>
              <p className="text-zinc-500 text-sm mt-1">Sign in to continue your journey</p>
            </div>

            <ErrorBanner />

            <form onSubmit={handleCredentials} noValidate className="space-y-5">

              {/* Email */}
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-zinc-300">Email address</label>
                <div className="relative group">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-red-400 transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={e => {
                      setEmail(e.target.value);
                      setFieldErrors(p => ({ ...p, email: '' }));
                      setError('');
                    }}
                    placeholder="you@example.com"
                    className={`
                      w-full pl-10 pr-4 py-3 rounded-xl bg-zinc-800/80 text-white
                      placeholder-zinc-600 border transition-all duration-200 outline-none
                      focus:bg-zinc-800 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20
                      ${fieldErrors.email
                        ? 'border-red-500/70 ring-2 ring-red-500/20'
                        : 'border-zinc-700/80 hover:border-zinc-600'}
                    `}
                  />
                </div>
                {fieldErrors.email && (
                  <p className="text-xs text-red-400 flex items-center gap-1">
                    <span>•</span> {fieldErrors.email}
                  </p>
                )}
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-zinc-300">Password</label>
                  <button
                    type="button"
                    onClick={() => setError('Password reset coming soon — contact support')}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative group">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-red-400 transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => {
                      setPassword(e.target.value);
                      setFieldErrors(p => ({ ...p, password: '' }));
                      setError('');
                    }}
                    placeholder="••••••••"
                    className={`
                      w-full pl-10 pr-12 py-3 rounded-xl bg-zinc-800/80 text-white
                      placeholder-zinc-600 border transition-all duration-200 outline-none
                      focus:bg-zinc-800 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20
                      ${fieldErrors.password
                        ? 'border-red-500/70 ring-2 ring-red-500/20'
                        : 'border-zinc-700/80 hover:border-zinc-600'}
                    `}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(p => !p)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors p-0.5"
                  >
                    {showPassword ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
                {fieldErrors.password && (
                  <p className="text-xs text-red-400 flex items-center gap-1">
                    <span>•</span> {fieldErrors.password}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting || !signInLoaded}
                className="
                  relative w-full py-3.5 rounded-xl font-semibold text-white mt-2
                  bg-gradient-to-r from-red-700 to-red-500
                  hover:from-red-600 hover:to-red-400
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-200 shadow-lg shadow-red-900/30
                  hover:shadow-red-900/50 hover:-translate-y-0.5
                  active:translate-y-0 overflow-hidden group
                "
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Signing in...
                  </span>
                ) : 'Sign In'}
              </button>
            </form>

            <div className="my-6 flex items-center gap-4">
              <div className="flex-1 h-px bg-gradient-to-r from-transparent to-zinc-700" />
              <span className="text-zinc-600 text-xs font-medium">OR</span>
              <div className="flex-1 h-px bg-gradient-to-l from-transparent to-zinc-700" />
            </div>

            <p className="text-center text-zinc-500 text-sm">
              New to Samurai?{' '}
              <Link to="/signup" className="text-red-400 hover:text-red-300 font-semibold transition-colors hover:underline underline-offset-2">
                Create an account →
              </Link>
            </p>
          </div>
        </div>

        <p className="text-center text-zinc-700 text-xs mt-6">
          By continuing, you agree to our Terms of Service
        </p>
      </div>
    </div>
  );
}
