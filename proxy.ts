import { NextResponse, type NextRequest } from 'next/server';
import { createMiddlewareClient } from './lib/supabaseServer';

/**
 * Server-side gate for the operator console.
 *
 * Hiding the button is not access control: /ops is a URL, and anyone may type
 * it. This runs before the route renders, so a rider who navigates there is
 * turned away without ever receiving operator markup. The rider app itself
 * stays public at the shell level — page.tsx decides what to show once it
 * knows whether anyone is signed in — but every table it reads is now
 * RLS-restricted to authenticated roles, so an unauthenticated shell renders
 * no fleet data regardless.
 */
export async function proxy(request: NextRequest) {
  const { supabase, response } = createMiddlewareClient(request);

  // getUser() revalidates the JWT against Supabase — unlike getSession(), it
  // cannot be spoofed by a forged cookie.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (path.startsWith('/ops')) {
    if (!user) {
      const to = request.nextUrl.clone();
      to.pathname = '/';
      to.search = '?signin=ops';
      return NextResponse.redirect(to);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (profile?.role !== 'operator') {
      const to = request.nextUrl.clone();
      to.pathname = '/';
      to.search = '?denied=ops';
      return NextResponse.redirect(to);
    }
  }

  applySecurityHeaders(response.headers);
  return response;
}

function applySecurityHeaders(headers: Headers) {
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

export const config = {
  matcher: [
    // Everything except static assets and image files.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|gif|ico)$).*)',
  ],
};
