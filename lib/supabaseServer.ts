import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

/**
 * Builds a request-scoped Supabase client that reads the session from cookies
 * and writes refreshed tokens back onto the response.
 *
 * Returns the response alongside the client because Supabase may rotate the
 * refresh token during getUser(); if those Set-Cookie headers are dropped the
 * user is silently signed out on the next navigation.
 */
export function createMiddlewareClient(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  return { supabase, response };
}

/**
 * Read-only client for route handlers. Used to identify the caller from their
 * cookie session so a request can be attributed to a real user rather than
 * being guessed at.
 */
export async function createRouteClient() {
  const { cookies } = await import('next/headers');
  const store = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      // Route handlers here only read identity; token rotation is handled by
      // middleware, so writes are intentionally no-ops.
      setAll() {},
    },
  });
}
