import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createRouteClient } from '../../../../lib/supabaseServer';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

const admin = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Rider self-service account deletion.
 *
 * Deleting an auth user needs the service role, so it has to happen here —
 * but the TARGET is never taken from the request body. The caller's own
 * cookie session (validated against Supabase by getUser) decides whose
 * account dies, so this endpoint cannot be pointed at anyone else.
 *
 * profiles cascades away with the user; rentals are billing records and are
 * anonymised instead (FK ON DELETE SET NULL).
 */
export async function POST() {
  try {
    const auth = await createRouteClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'You are signed out.' }, { status: 401 });
    }

    // Operator accounts are provisioned by the fleet owner, and losing one
    // silently would lock the depot out — they are removed the same way they
    // were created: manually.
    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.role === 'operator') {
      return NextResponse.json(
        { error: 'Operator accounts are managed by the fleet owner and cannot self-delete.' },
        { status: 403 }
      );
    }

    // Never delete an account that is mid-ride: the rental would lose its
    // owner while a physical chair is unlocked in their hands.
    const { data: live } = await admin
      .from('rentals')
      .select('id')
      .eq('user_id', user.id)
      .in('state', ['reserved', 'active', 'expiring', 'ending'])
      .limit(1);
    if (live && live.length > 0) {
      return NextResponse.json(
        { error: 'End your current ride first, then delete the account.' },
        { status: 409 }
      );
    }

    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) {
      console.error('Account deletion failed:', error);
      return NextResponse.json({ error: 'Could not delete the account. Try again.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Account deletion error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
