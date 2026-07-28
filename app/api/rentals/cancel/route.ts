import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Releases a 'reserved' rental after a failed payment. Runs with the service
// role because the live rentals table is (correctly) read-only for browser
// clients — the anon key cannot update rows.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(request: Request) {
  try {
    const { rental_id } = await request.json();

    if (typeof rental_id !== 'string' || !rental_id.trim()) {
      return NextResponse.json({ error: 'A valid rental id is required.' }, { status: 400 });
    }

    // Guarded: only a still-'reserved' rental can be cancelled this way. An
    // activated rental must go through /api/rentals/end (device-confirmed).
    const { data, error } = await supabase
      .from('rentals')
      .update({ state: 'cancelled' })
      .eq('id', rental_id)
      .eq('state', 'reserved')
      .select('id');

    if (error) {
      console.error('Rental cancel failed:', error);
      return NextResponse.json({ error: 'Unable to cancel the reservation.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, cancelled: (data?.length ?? 0) > 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error('Cancel rental API error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
