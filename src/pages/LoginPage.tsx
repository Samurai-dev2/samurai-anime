// src/pages/LoginPage.tsx
import { useSignIn } from '@clerk/clerk-react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';

type Step = 'credentials' | 'second_factor' | 'email_code';

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn, isLoaded: signInLoaded, setActive } = useSignIn();

  const [step,           setStep]           = useState<Step>('credentials');
  const [email,          setEmail]          = useState('');
  const [password,       setPassword]       = useState('');
  const [showPassword,   setShowPassword]   = useState(false);
  const [code,           setCode]           = useState('');
  const [submitting,     setSubmitting]     = useState(false);
  const [error,          setError]          = useState('');
  const [fieldErrors,    setFieldErrors]    = useState<Record<string, string>>({});
  const [mounted,        setMounted]        = useState(false);
  const [codeResent,     setCodeResent]     = useState(false);

  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => setMounted(true), 50);
  }, []);

  // Focus code input when step changes
  useEffect(() => {
    if (step !== 'credentials') {
      setTimeout(() => codeInputRef.current?.focus(), 100);
    }
  }, [step]);

  // ── Validation ─────────────────────────────────────────────
  const validate = () => {
    const errs: Record<string, string> = {};
    if (!email.trim())                    errs.email    = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(email)) errs.email    = 'Enter a valid email';
    if (!password)                         errs.password = 'Password is required';
    return errs;
  };

  // ── Complete the sign-in once we have a session ─────────────
  async function finishSignIn(sessionId: string) {
    await setActive({ session: sessionId });
    navigate('/');
  }

  // ── Step 1: Email + Password ────────────────────────────────
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

      if (result.status === 'needs_second_factor') {
        // User has TOTP / authenticator app 2FA enabled
        setStep('second_factor');
        return;
      }

      if (result.status === 'needs_first_factor') {
        // Email OTP verification needed
        const emailFactor = result.supportedFirstFactors?.find(
          (f: any) => f.strategy === 'email_code'
        ) as any;

        if (emailFactor?.emailAddressId) {
          await signIn.prepareFirstFactor({
            strategy:       'email_code',
            emailAddressId: emailFactor.emailAddressId,
          });
          setStep('email_code');
        } else {
          setError('Email verification required but no email found on this account.');
        }
        return;
      }

      setError(`Unexpected sign-in status: ${result.status}`);
    } catch (err: any) {
      const clerkError = err?.errors?.[0];
      setError(clerkError?.longMessage || clerkError?.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 2a: TOTP / Authenticator 2FA ──────────────────────
  const handleSecondFactor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signInLoaded || !code.trim()) return;

    setError('');
    setSubmitting(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: 'totp',
        code:     code.trim(),
      });

      if (result.status === 'complete') {
        await finishSignIn(result.createdSessionId!);
      } else {
        setError(`Unexpected status after 2FA: ${result.status}`);
      }
    } catch (err: any) {
      const clerkError = err?.errors?.[0];

      // If TOTP failed, try backup code automatically
      if (clerkError?.code === 'form_code_incorrect') {
        setError('Incorrect code. If you lost your authenticator, use a backup code.');
      } else {
        setError(clerkError?.longMessage || clerkError?.message || '2FA verification failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 2b: Backup code (fallback for lost authenticator) ──
  const handleBackupCode = async () => {
    if (!signInLoaded || !code.trim()) return;

    setError('');
    setSubmitting(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: 'backup_code',
        code:     code.trim(),
      });

      if (result.status === 'complete') {
        await finishSignIn(result.createdSessionId!);
      } else {
        setError(`Unexpected status: ${result.status}`);
      }
    } catch (err: any) {
      const clerkError = err?.errors?.[0];
      setError(clerkError?.longMessage || clerkError?.message || 'Backup code failed');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 2c: Email OTP ──────────────────────────────────────
  const handleEmailCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signInLoaded || !code.trim()) return;

    setError('');
    setSubmitting(true);

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'email_code',
        code:     code.trim(),
      });

      if (result.status === 'complete') {
        await finishSignIn(result.createdSessionId!);
      } else if (result.status === 'needs_second_factor') {
        setStep('second_factor');
      } else {
        setError(`Unexpected status: ${result.status}`);
      }
    } catch (err: any) {
      const clerkError = err?.errors?.[0];
      setError(clerkError?.longMessage || clerkError?.message || 'Invalid code');
    } finally {
      setSubmitting(false);
    }
  };

  // Resend email code
  const resendEmailCode = async () => {
    if (!signInLoaded) return;
    try {
      const emailFactor = signIn.supportedFirstFactors?.find(
        (f: any) => f.strategy === 'email_code'
      ) as any;
      if (emailFactor?.emailAddressId) {
        await signIn.prepareFirstFactor({
          strategy:       'email_code',
          emailAddressId: emailFactor.emailAddressId,
        });
        setCodeResent(true);
        setTimeout(() => setCodeResent(false), 4000);
      }
    } catch (err: any) {
      setError('Failed to resend code');
    }
  };

  // ── Shared UI pieces ────────────────────────────────────────
  const ErrorBanner = () => error ? (
    <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-3">
      <span className="text-red-400 text-lg leading-none mt-0.5">⚠</span>
      <p className="text-red-400 text-sm leading-relaxed">{error}</p>
    </div>
  ) : null;

  const CodeInput = ({
    label,
    hint,
    onSubmit,
  }: {
    label:    string;
    hint:     string;
    onSubmit: (e: React.FormEvent) => void;
  }) => (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-zinc-300">{label}</label>
        <p className="text-zinc-500 text-xs">{hint}</p>
        <input
          ref={codeInputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(''); }}
          placeholder="000000"
          maxLength={8}
          className="
            w-full px-4 py-3 rounded-xl bg-zinc-800/80 text-white text-center
            text-2xl tracking-[0.5em] font-mono placeholder-zinc-700
            border border-zinc-700/80 hover:border-zinc-600
            focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20
            outline-none transition-all duration-200
          "
        />
      </div>

      <button
        type="submit"
        disabled={submitting || !code.trim()}
        className="
          relative w-full py-3.5 rounded-xl font-semibold text-white
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
            Verifying...
          </span>
        ) : 'Verify'}
      </button>

      <button
        type="button"
        onClick={() => { setStep('credentials'); setCode(''); setError(''); }}
        className="w-full text-center text-zinc-600 hover:text-zinc-400 text-xs transition-colors"
      >
        ← Back to sign in
      </button>
    </form>
  );

  // ── Render ──────────────────────────────────────────────────
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

            {/* ── STEP: Credentials ── */}
            {step === 'credentials' && (
              <>
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
                        onChange={e => { setEmail(e.target.value); setFieldErrors(p => ({ ...p, email: '' })); setError(''); }}
                        placeholder="you@example.com"
                        className={`
                          w-full pl-10 pr-4 py-3 rounded-xl bg-zinc-800/80 text-white
                          placeholder-zinc-600 border transition-all duration-200 outline-none
                          focus:bg-zinc-800 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20
                          ${fieldErrors.email ? 'border-red-500/70 ring-2 ring-red-500/20' : 'border-zinc-700/80 hover:border-zinc-600'}
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
                        onChange={e => { setPassword(e.target.value); setFieldErrors(p => ({ ...p, password: '' })); setError(''); }}
                        placeholder="••••••••"
                        className={`
                          w-full pl-10 pr-12 py-3 rounded-xl bg-zinc-800/80 text-white
                          placeholder-zinc-600 border transition-all duration-200 outline-none
                          focus:bg-zinc-800 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20
                          ${fieldErrors.password ? 'border-red-500/70 ring-2 ring-red-500/20' : 'border-zinc-700/80 hover:border-zinc-600'}
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
              </>
            )}

            {/* ── STEP: Authenticator 2FA ── */}
            {step === 'second_factor' && (
              <>
                <div className="mb-8">
                  <div className="w-12 h-12 bg-red-500/10 rounded-xl flex items-center justify-center mb-4">
                    <span className="text-2xl">🔐</span>
                  </div>
                  <h2 className="text-2xl font-bold text-white">Two-factor auth</h2>
                  <p className="text-zinc-500 text-sm mt-1">
                    Enter the 6-digit code from your authenticator app
                  </p>
                </div>

                <ErrorBanner />

                <CodeInput
                  label="Authenticator code"
                  hint="Open your authenticator app and enter the current code"
                  onSubmit={handleSecondFactor}
                />

                {/* Backup code fallback */}
                <div className="mt-4 pt-4 border-t border-zinc-800">
                  <p className="text-zinc-600 text-xs text-center mb-2">
                    Lost access to your authenticator?
                  </p>
                  <button
                    type="button"
                    onClick={handleBackupCode}
                    disabled={!code.trim() || submitting}
                    className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg transition-colors disabled:opacity-30"
                  >
                    Use backup code instead
                  </button>
                </div>
              </>
            )}

            {/* ── STEP: Email OTP ── */}
            {step === 'email_code' && (
              <>
                <div className="mb-8">
                  <div className="w-12 h-12 bg-red-500/10 rounded-xl flex items-center justify-center mb-4">
                    <span className="text-2xl">📧</span>
                  </div>
                  <h2 className="text-2xl font-bold text-white">Check your email</h2>
                  <p className="text-zinc-500 text-sm mt-1">
                    We sent a verification code to <span className="text-zinc-300">{email}</span>
                  </p>
                </div>

                <ErrorBanner />

                {codeResent && (
                  <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-xl text-green-400 text-xs text-center">
                    ✓ New code sent — check your inbox
                  </div>
                )}

                <CodeInput
                  label="Verification code"
                  hint="Enter the 6-digit code from your email"
                  onSubmit={handleEmailCode}
                />

                <button
                  type="button"
                  onClick={resendEmailCode}
                  className="mt-3 w-full text-center text-zinc-600 hover:text-zinc-400 text-xs transition-colors"
                >
                  Didn't get it? Resend code
                </button>
              </>
            )}

          </div>
        </div>

        <p className="text-center text-zinc-700 text-xs mt-6">
          By continuing, you agree to our Terms of Service
        </p>
      </div>
    </div>
  );
}
