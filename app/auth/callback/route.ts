import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

/**
 * OAuth / email-confirmation landing point.
 *
 * Google sends the browser back here with a one-time code; this exchanges it
 * for a session and writes the session cookies, which is what makes the
 * middleware gate and the RLS-authenticated reads work on the next request.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  // Email links (confirmation, recovery) can arrive as a one-time token_hash
  // rather than a PKCE code, depending on the project's email templates.
  // Handling both means a link works whichever form Supabase sent.
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (oauthError) {
    return NextResponse.redirect(new URL(`/?authError=${encodeURIComponent(oauthError)}`, url.origin));
  }
  if (!code && !tokenHash) {
    return NextResponse.redirect(new URL('/', url.origin));
  }

  const store = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => store.set(name, value, options));
      },
    },
  });

  const { error } = tokenHash
    ? await supabase.auth.verifyOtp({
        type: (type as 'signup' | 'recovery' | 'email_change' | 'invite') || 'signup',
        token_hash: tokenHash,
      })
    : await supabase.auth.exchangeCodeForSession(code as string);

  if (error) {
    return NextResponse.redirect(new URL(`/?authError=${encodeURIComponent(error.message)}`, url.origin));
  }

  // A recovery link must land on "set a new password", never on the map — the
  // session it creates is real, so without this the user would simply be
  // signed in and never asked for the password they came to change.
  if (type === 'recovery') {
    return NextResponse.redirect(new URL('/?recovery=1', url.origin));
  }

  // Operators land straight in the console; everyone else in the rider app.
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile?.role === 'operator') {
      return NextResponse.redirect(new URL('/ops', url.origin));
    }
  }

  return NextResponse.redirect(new URL('/', url.origin));
}
