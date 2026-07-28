'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { passwordProblem } from './passwordRules';

export type Role = 'rider' | 'operator';

export interface Profile {
  id: string;
  name: string;
  role: Role;
  phone: string | null;
  avatar_url: string | null;
  locale: 'en' | 'ar';
  marketing_opt_in: boolean;
  ride_receipts: boolean;
  /** null until the rider has finished the intro. */
  onboarded_at: string | null;
}

export interface AuthState {
  user: User | null;
  profile: Profile | null;
  /** True until the first auth check settles — render nothing decisive before this. */
  loading: boolean;
  isOperator: boolean;
  /** Best display name available, without waiting on the profile row. */
  displayName: string;
  /**
   * Whether the Google provider is actually configured on this Supabase
   * project. null while unknown.
   *
   * signInWithOAuth does not fail in-page — it navigates the browser straight
   * to Supabase, so a provider with no client ID dumps the rider on a raw
   * `{"code":400,...,"Unsupported provider"}` JSON page with no way back. The
   * only way to prevent that is to know before offering the button.
   */
  googleEnabled: boolean | null;
  /**
   * True when the user arrived from a password-reset link. Supabase signs them
   * in with a short-lived recovery session, so the app must show "set a new
   * password" rather than dropping them into the map already signed in.
   */
  recovering: boolean;
  /**
   * True once the profile row for the current user has been fetched (or has
   * been confirmed absent). `loading` only covers the auth session — the ROLE
   * lands later, so anything that branches on rider-vs-operator must wait for
   * this or it will briefly take the rider branch for an operator.
   */
  profileLoaded: boolean;
  /** Has this account completed the rider intro? Account-scoped, not device. */
  onboarded: boolean;
}

export interface AuthResult {
  ok: boolean;
  message?: string;
  /** Signup succeeded but Supabase is holding the account for email confirmation. */
  needsConfirmation?: boolean;
}

// One definition, shared with the signup API route so the browser and the
// server cannot drift apart on what counts as an acceptable password.
export { passwordProblem, passwordScore } from './passwordRules';

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'Rider';
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  return cleaned ? cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Rider';
}

/** Supabase surfaces raw API strings; these are the ones riders actually hit. */
function humanise(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'That email and password do not match an account.';
  if (m.includes('email not confirmed')) return 'Confirm your email address first — check your inbox.';
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'That email already has an account. Sign in instead.';
  }
  if (m.includes('password should be')) return 'Choose a password of at least 6 characters.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a moment and try again.';
  // Configuration, not a user mistake: the Google provider has no client
  // ID/secret set in Supabase yet. Say so plainly instead of surfacing
  // "Unsupported provider", which reads like the rider did something wrong.
  if (m.includes('provider is not enabled') || m.includes('unsupported provider')) {
    return 'Google sign-in is not set up yet. Use email and password for now.';
  }
  if (m.includes('redirect') && m.includes('not allowed')) {
    return 'This sign-in link is not on the allow-list yet. Use email and password for now.';
  }
  return message;
}

export function useAuth(): AuthState & {
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string, name: string) => Promise<AuthResult>;
  signInWithGoogle: () => Promise<AuthResult>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
  resendConfirmation: (email: string) => Promise<AuthResult>;
  updateProfile: (fields: {
    name?: string;
    phone?: string | null;
    locale?: 'en' | 'ar';
    marketing_opt_in?: boolean;
    ride_receipts?: boolean;
    avatar_url?: string | null;
  }) => Promise<AuthResult>;
  uploadAvatar: (file: File) => Promise<AuthResult>;
  markOnboarded: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null>(null);
  // Stored with the uid it was fetched for, so a profile can never outlive the
  // account it belongs to — switching users shows no profile rather than
  // briefly showing the previous rider's name and role.
  const [profileFor, setProfileFor] = useState<{ uid: string; profile: Profile } | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);
  const [recovering, setRecovering] = useState(false);
  // Tracks WHICH user the profile fetch has settled for, so a stale `true`
  // from the previous account can never be read as "role known" for this one.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const profile = user && profileFor?.uid === user.id ? profileFor.profile : null;
  const profileLoaded = !user ? true : loadedFor === user.id;

  // Ask the project which providers are actually configured. This endpoint is
  // public (anon key) and cheap, and it is the only way to avoid offering a
  // Google button that navigates away to an error page.
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    let alive = true;

    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { external?: Record<string, boolean> } | null) => {
        if (alive) setGoogleEnabled(j?.external?.google === true);
      })
      .catch(() => {
        // Fail closed: if we cannot confirm it works, do not offer it.
        if (alive) setGoogleEnabled(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  // One subscription for the lifetime of the app. onAuthStateChange fires
  // immediately with the restored session, so it doubles as the initial read
  // and there is no separate getSession() race to reconcile.
  useEffect(() => {
    let alive = true;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      setUser(session?.user ?? null);
      setLoading(false);
      // A recovery link signs the user in for real, so without this flag the
      // app would silently drop them into the map and never ask for the new
      // password they came here to set.
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (event === 'SIGNED_OUT') setRecovering(false);
    });

    // Cookie sessions are validated server-side; this catches the case where
    // the listener has nothing to replay (e.g. a cold load with no session).
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // The profile row carries the role, and the role is what gates /ops. It is
  // read separately because it lives in Postgres behind RLS, not in the JWT.
  useEffect(() => {
    if (!user) return; // nothing to fetch; `profile` derives to null already
    let alive = true;
    const uid = user.id;
    const email = user.email ?? '';

    supabase
      .from('profiles')
      .select('id, name, role, phone, avatar_url, locale, marketing_opt_in, ride_receipts, onboarded_at')
      .eq('id', uid)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        if (data) {
          setProfileFor({
            uid,
            profile: {
              id: data.id as string,
              name: (data.name as string) || nameFromEmail(email),
              role: (data.role as Role) ?? 'rider',
              phone: (data.phone as string | null) ?? null,
              avatar_url: (data.avatar_url as string | null) ?? null,
              locale: ((data.locale as string) === 'ar' ? 'ar' : 'en'),
              marketing_opt_in: data.marketing_opt_in === true,
              ride_receipts: data.ride_receipts !== false,
              onboarded_at: (data.onboarded_at as string | null) ?? null,
            },
          });
        }
        // Settled either way — a missing row is an answer, not a reason to
        // leave callers waiting forever on a screen decision.
        setLoadedFor(uid);
      });

    return () => {
      alive = false;
    };
  }, [user]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, message: humanise(error.message) };
    return { ok: true };
  }, []);

  /**
   * Create an account through our own API route rather than supabase.auth.signUp.
   *
   * The stock endpoint answers a repeat signup with a decoy 200 and quietly
   * re-sends a confirmation email — anti-enumeration by design, but it means a
   * rider who already has an account is told "check your inbox" forever, and
   * the resends eventually rate-limit them out of an account they already own
   * ("Too many attempts"). Detecting the empty `identities` array fixes the
   * message but not the cause: the send is attempted before the reply.
   *
   * The route checks first and says so plainly, applies the same password
   * rules server-side, and only involves email when confirmation is actually
   * configured — so nothing is sent on the common path and nothing is capped.
   */
  const signUp = useCallback(async (email: string, password: string, name: string): Promise<AuthResult> => {
    const clean = email.trim();
    const problem = passwordProblem(password, clean);
    if (problem) return { ok: false, message: problem };

    let res: Response;
    try {
      res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: clean, password, name: name.trim() }),
      });
    } catch {
      return { ok: false, message: 'No connection. Check your network and try again.' };
    }

    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; needsConfirmation?: boolean }
      | null;

    if (!res.ok) return { ok: false, message: body?.error || 'Could not create the account.' };
    if (body?.needsConfirmation) return { ok: true, needsConfirmation: true };

    // The account is live immediately, so sign in rather than making the rider
    // retype the password they just chose.
    const { error } = await supabase.auth.signInWithPassword({ email: clean, password });
    if (error) return { ok: false, message: humanise(error.message) };
    return { ok: true };
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<AuthResult> => {
    // Second line of defence — the button is hidden when this is false, but a
    // navigation away to a JSON error page is bad enough to guard twice.
    if (googleEnabled === false) {
      return { ok: false, message: 'Google sign-in is not set up yet. Use email and password for now.' };
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
      },
    });
    if (error) return { ok: false, message: humanise(error.message) };
    return { ok: true }; // the browser is navigating away to Google
  }, [googleEnabled]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfileFor(null);
    setLoadedFor(null);
    setRecovering(false);
  }, []);

  /**
   * Record that this account has finished the rider intro.
   *
   * Optimistic: the local profile flips immediately so the screen advances
   * without waiting on the round trip, and a failed write only means the intro
   * is offered again later — never that the rider is stuck on it.
   */
  const markOnboarded = useCallback(async () => {
    const { data: { user: current } } = await supabase.auth.getUser();
    if (!current) return;
    const stamp = new Date().toISOString();

    setProfileFor((prev) =>
      prev && prev.uid === current.id
        ? { uid: prev.uid, profile: { ...prev.profile, onboarded_at: stamp } }
        : prev,
    );
    await supabase.from('profiles').update({ onboarded_at: stamp }).eq('id', current.id);
  }, []);

  /** Revoke every session on every device — for a lost or shared phone. */
  const signOutEverywhere = useCallback(async () => {
    await supabase.auth.signOut({ scope: 'global' });
    setProfileFor(null);
    setRecovering(false);
  }, []);

  /**
   * Update the rider's own profile. RLS restricts the write to the caller's
   * row, and the role-guard trigger means nothing here can touch role — the
   * field is simply not reachable from this path. Auth metadata is kept in
   * step so the display name survives a fresh session before the profile row
   * loads.
   */
  const updateProfile = useCallback(
    async (fields: {
      name?: string;
      phone?: string | null;
      locale?: 'en' | 'ar';
      marketing_opt_in?: boolean;
      ride_receipts?: boolean;
      avatar_url?: string | null;
    }): Promise<AuthResult> => {
      const { data: { user: current } } = await supabase.auth.getUser();
      if (!current) return { ok: false, message: 'You are signed out.' };

      const patch: Record<string, string | null> = {};
      if (fields.name !== undefined) {
        const clean = fields.name.trim();
        if (!clean) return { ok: false, message: 'Your name cannot be empty.' };
        if (clean.length > 60) return { ok: false, message: 'Keep your name under 60 characters.' };
        patch.name = clean;
      }
      if (fields.phone !== undefined) {
        const clean = (fields.phone ?? '').trim();
        if (clean && !/^\+?[0-9 ()-]{7,20}$/.test(clean)) {
          return { ok: false, message: 'Enter a valid phone number, e.g. +966 5X XXX XXXX.' };
        }
        patch.phone = clean || null;
      }
      if (fields.locale !== undefined) patch.locale = fields.locale;
      if (fields.avatar_url !== undefined) patch.avatar_url = fields.avatar_url;
      if (!Object.keys(patch).length
          && fields.marketing_opt_in === undefined
          && fields.ride_receipts === undefined) {
        return { ok: true };
      }

      // Booleans are kept out of the string-typed patch above.
      const fullPatch: Record<string, string | null | boolean> = { ...patch };
      if (fields.marketing_opt_in !== undefined) fullPatch.marketing_opt_in = fields.marketing_opt_in;
      if (fields.ride_receipts !== undefined) fullPatch.ride_receipts = fields.ride_receipts;

      const { error } = await supabase.from('profiles').update(fullPatch).eq('id', current.id);
      if (error) return { ok: false, message: humanise(error.message) };

      if (patch.name) {
        await supabase.auth.updateUser({ data: { full_name: patch.name } });
      }

      setProfileFor((prev) =>
        prev && prev.uid === current.id
          ? {
              uid: prev.uid,
              profile: {
                ...prev.profile,
                ...(patch.name ? { name: patch.name as string } : null),
                ...(fields.phone !== undefined ? { phone: patch.phone as string | null } : null),
                ...(fields.locale !== undefined ? { locale: fields.locale } : null),
                ...(fields.avatar_url !== undefined ? { avatar_url: patch.avatar_url as string | null } : null),
                ...(fields.marketing_opt_in !== undefined ? { marketing_opt_in: fields.marketing_opt_in } : null),
                ...(fields.ride_receipts !== undefined ? { ride_receipts: fields.ride_receipts } : null),
              },
            }
          : prev,
      );
      return { ok: true, message: 'Saved.' };
    },
    [],
  );

  /**
   * Upload a profile photo to Supabase Storage.
   *
   * The object path is `${uid}/avatar.<ext>` and storage RLS requires the
   * first path segment to equal auth.uid() — so the folder name is not a
   * convention the client is trusted to honour, it is the check itself.
   */
  const uploadAvatar = useCallback(async (file: File): Promise<AuthResult> => {
    const { data: { user: current } } = await supabase.auth.getUser();
    if (!current) return { ok: false, message: 'You are signed out.' };

    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      return { ok: false, message: 'Choose a JPEG, PNG, WebP or GIF image.' };
    }
    if (file.size > 2 * 1024 * 1024) {
      return { ok: false, message: 'That image is over 2 MB. Choose a smaller one.' };
    }

    const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
    const path = `${current.id}/avatar.${ext}`;

    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
    if (upErr) return { ok: false, message: humanise(upErr.message) };

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
    // Cache-bust: the path is stable across replacements, so without this the
    // browser keeps showing the previous photo.
    const url = `${pub.publicUrl}?v=${Date.now()}`;

    const { error } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', current.id);
    if (error) return { ok: false, message: humanise(error.message) };

    await supabase.auth.updateUser({ data: { avatar_url: url } });
    setProfileFor((prev) =>
      prev && prev.uid === current.id
        ? { uid: prev.uid, profile: { ...prev.profile, avatar_url: url } }
        : prev,
    );
    return { ok: true, message: 'Photo updated.' };
  }, []);

  /**
   * Send a reset link.
   *
   * Always reports success, even for an address with no account. Saying "no
   * such user" would turn this form into a way to test which email addresses
   * are registered, and the set of people who rent mobility aids is not a list
   * worth leaking.
   */
  const requestPasswordReset = useCallback(async (email: string): Promise<AuthResult> => {
    const clean = email.trim();
    if (!/.+@.+\..+/.test(clean)) return { ok: false, message: 'Enter a valid email address.' };

    const { error } = await supabase.auth.resetPasswordForEmail(clean, {
      redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback?type=recovery` : undefined,
    });
    // Rate limiting is the one failure worth surfacing — it is actionable.
    if (error && /rate limit|too many/i.test(error.message)) {
      return { ok: false, message: humanise(error.message) };
    }
    return { ok: true, message: `If ${clean} has an account, a reset link is on its way.` };
  }, []);

  /** Set a new password for the currently signed-in (or recovering) user. */
  const updatePassword = useCallback(async (password: string): Promise<AuthResult> => {
    const problem = passwordProblem(password);
    if (problem) return { ok: false, message: problem };

    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { ok: false, message: humanise(error.message) };
    setRecovering(false);
    return { ok: true, message: 'Password updated.' };
  }, []);

  /** Re-send the signup confirmation for someone who lost the first email. */
  const resendConfirmation = useCallback(async (email: string): Promise<AuthResult> => {
    const clean = email.trim();
    if (!/.+@.+\..+/.test(clean)) return { ok: false, message: 'Enter a valid email address.' };

    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: clean,
      options: {
        emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
      },
    });
    if (error && /rate limit|too many/i.test(error.message)) {
      return { ok: false, message: humanise(error.message) };
    }
    // Same non-disclosure reasoning as the reset above.
    return { ok: true, message: `If ${clean} is waiting to be confirmed, another link is on its way.` };
  }, []);

  const displayName = useMemo(() => {
    if (profile?.name) return profile.name;
    const meta = user?.user_metadata as { full_name?: string; name?: string } | undefined;
    if (meta?.full_name) return meta.full_name;
    if (meta?.name) return meta.name;
    return user?.email ? nameFromEmail(user.email) : '';
  }, [profile, user]);

  return {
    user,
    profile,
    loading,
    isOperator: profile?.role === 'operator',
    displayName,
    googleEnabled,
    recovering,
    profileLoaded,
    onboarded: profile?.onboarded_at != null,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    requestPasswordReset,
    updatePassword,
    resendConfirmation,
    updateProfile,
    uploadAvatar,
    markOnboarded,
    signOutEverywhere,
  };
}
