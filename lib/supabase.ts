import { createBrowserClient } from '@supabase/ssr';

// Same Supabase project as the original Wheel_Chair_Project — same tables,
// same Edge Functions, same live device_state written by the ESP32 firmware.
//
// createBrowserClient (rather than plain createClient) stores the session in
// cookies instead of localStorage. That is what lets proxy.ts read the session
// on the server and refuse /ops before any operator markup is sent — route
// protection you cannot click past, rather than a hidden button.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);

// NOTE: there is deliberately no service-role client in this file.
//
// Every module here is imported by 'use client' components, so anything
// exported becomes part of the browser bundle. A service-role key bypasses RLS
// completely — one `NEXT_PUBLIC_` prefix, or one import of this module from a
// server file that later gets marked client, and the entire database is
// readable and writable by anyone who opens devtools.
//
// Server-side privileged work belongs in route handlers under app/api/, which
// never ship to the browser. See app/api/account/* and app/api/rentals/*.
