import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createRouteClient } from '../../../../lib/supabaseServer';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

// Service role client runs with elevated bypass privileges on backend
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(request: Request) {
  try {
    // Who is actually asking? The rental has to carry a real owner: it is the
    // billing record, the rider's trip history, and — after the RLS lockdown —
    // the thing that authorises LOCK/END_SESSION on this chair. Guessing it
    // would hand one account somebody else's ride.
    const auth = await createRouteClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Sign in before renting a wheelchair.' }, { status: 401 });
    }

    const { wheelchair_id, duration_s } = await request.json();

    if (
      typeof wheelchair_id !== 'string'
      || !wheelchair_id.trim()
      || !Number.isInteger(duration_s)
      || duration_s <= 0
    ) {
      return NextResponse.json({ error: 'Invalid wheelchair or rental duration.' }, { status: 400 });
    }

    const { data: chair, error: chairError } = await supabase
      .from('device_state')
      .select('wheelchair_id, ts, online, power, locked, session_state')
      .eq('wheelchair_id', wheelchair_id)
      .maybeSingle();

    if (chairError) {
      console.error('Wheelchair availability query failed:', chairError);
      return NextResponse.json({ error: 'Unable to verify wheelchair availability.' }, { status: 500 });
    }

    const telemetryAgeMs = chair?.ts ? Date.now() - Date.parse(chair.ts) : Number.POSITIVE_INFINITY;
    const telemetryIsFresh = telemetryAgeMs >= 0 && telemetryAgeMs < 30_000;
    const sessionIsReady = !chair?.session_state
      || chair.session_state === 'LOCKED'
      || chair.session_state === 'AVAILABLE';
    const chairIsAvailable = Boolean(
      chair
      && telemetryIsFresh
      && chair.online !== false
      && chair.power
      && chair.locked
      && sessionIsReady
    );

    if (!chairIsAvailable) {
      return NextResponse.json(
        { error: 'This wheelchair is offline, in use, or not safely locked. Refresh and choose an available chair.' },
        { status: 409 }
      );
    }

    const { data: openRentals, error: openRentalsError } = await supabase
      .from('rentals')
      .select('state, end_at, created_at')
      .eq('wheelchair_id', wheelchair_id)
      .in('state', ['reserved', 'active', 'expiring', 'ending']);

    if (openRentalsError) {
      console.error('Rental conflict query failed:', openRentalsError);
      return NextResponse.json({ error: 'Unable to verify rental availability.' }, { status: 500 });
    }

    const now = Date.now();
    const hasLiveRental = (openRentals || []).some((rental) => {
      if (rental.state === 'reserved') {
        return Boolean(rental.created_at && now - Date.parse(rental.created_at) < 10 * 60_000);
      }

      return !rental.end_at || Date.parse(rental.end_at) > now;
    });

    if (hasLiveRental) {
      return NextResponse.json(
        { error: 'This wheelchair already has an active or pending rental.' },
        { status: 409 }
      );
    }

    const { data: rental, error } = await supabase
      .from('rentals')
      .insert({
        wheelchair_id,
        user_id: user.id,
        state: 'reserved',
        duration_s,
        speed_limit: 6
      })
      .select()
      .single();

    if (error) {
      console.error("Database insert error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, rental });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error("Create rental API error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
