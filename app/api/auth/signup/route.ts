import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { passwordProblem } from '../../../../lib/passwordRules';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

/**
 * Require a clicked email link before the account can sign in.
 *
 * OFF by default, and that is deliberate: Supabase's built-in mailer is capped
 * at a few messages an hour, so with confirmation on and no SMTP configured a
 * rider signs up, never receives the mail, retries, and gets rate-limited out
 * of their own account — which is exactly the failure this route replaces.
 * Set AUTH_REQUIRE_EMAIL_CONFIRMATION=true once real SMTP is configured under
 * Project Settings → Auth → SMTP.
 */
const REQUIRE_CONFIRMATION = process.env.AUTH_REQUIRE_EMAIL_CONFIRMATION === 'true';

const admin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Small in-process throttle so this endpoint cannot be used to mass-create
// accounts. Per-instance rather than distributed — a backstop, not a wall;
// Supabase's own limits still apply underneath.
const ATTEMPTS = new Map<string, number[]>();
const WINDOW_MS = 15 * 60_000;
const MAX_PER_WINDOW = 5;

function throttled(ip: string): boolean {
  const now = Date.now();
  const recent = (ATTEMPTS.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    ATTEMPTS.set(ip, recent);
    return true;
  }
  recent.push(now);
  ATTEMPTS.set(ip, recent);
  if (ATTEMPTS.size > 5000) ATTEMPTS.clear(); // crude cap; this is a backstop
  return false;
}

export async function POST(request: Request) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';

    if (throttled(ip)) {
      return NextResponse.json(
        { error: 'Too many sign-up attempts from this network. Try again in a few minutes.' },
        { status: 429 }
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { email?: unknown; password?: unknown; name?: unknown }
      | null;

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    // Enforced here, not only in the browser: client-side rules are guidance,
    // and this endpoint is reachable without the UI.
    const problem = passwordProblem(password, email);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }
    if (name.length > 60) {
      return NextResponse.json({ error: 'Keep your name under 60 characters.' }, { status: 400 });
    }

    // Answer honestly when the account already exists. The stock signup
    // endpoint returns a decoy 200 and quietly re-sends a confirmation, which
    // is what produced "Too many attempts" for a rider who simply already had
    // an account and could never be told so.
    const { data: existing } = await admin.rpc('email_is_registered', { p_email: email });
    if (existing === true) {
      return NextResponse.json(
        { error: 'That email already has an account. Sign in instead, or use "Forgot your password?".', code: 'exists' },
        { status: 409 }
      );
    }

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: !REQUIRE_CONFIRMATION,
      user_metadata: { full_name: name || email.split('@')[0] },
    });

    if (error) {
      // Race: someone registered the same address between the check and here.
      if (/already|registered|exists/i.test(error.message)) {
        return NextResponse.json(
          { error: 'That email already has an account. Sign in instead.', code: 'exists' },
          { status: 409 }
        );
      }
      console.error('Signup failed:', error);
      return NextResponse.json({ error: 'Could not create the account. Try again.' }, { status: 500 });
    }

    // The profile row (role 'rider', always) is created by the
    // on_auth_user_created trigger — never by anything the client can reach.
    if (REQUIRE_CONFIRMATION) {
      await admin.auth.admin.generateLink({ type: 'signup', email, password });
      return NextResponse.json({ ok: true, needsConfirmation: true });
    }

    return NextResponse.json({ ok: true, needsConfirmation: false, userId: data.user?.id });
  } catch (err) {
    console.error('Signup error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
