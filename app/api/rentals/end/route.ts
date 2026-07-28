import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(request: Request) {
  try {
    const { wheelchair_id, reason = 'operator_cancel' } = await request.json();

    if (typeof wheelchair_id !== 'string' || !wheelchair_id.trim()) {
      return NextResponse.json({ error: 'A valid wheelchair is required.' }, { status: 400 });
    }

    const { data: chair, error: chairError } = await supabase
      .from('device_state')
      .select('ts, online, locked, session_state')
      .eq('wheelchair_id', wheelchair_id)
      .maybeSingle();

    if (chairError) {
      console.error('Session-end availability query failed:', chairError);
      return NextResponse.json({ error: 'Unable to verify the wheelchair state.' }, { status: 500 });
    }

    const telemetryAgeMs = chair?.ts ? Date.now() - Date.parse(chair.ts) : Number.POSITIVE_INFINITY;
    const chairIsOnline = Boolean(
      chair
      && telemetryAgeMs >= 0
      && telemetryAgeMs < 30_000
      && chair.online !== false
    );

    if (!chair || !chairIsOnline) {
      return NextResponse.json(
        { error: 'The wheelchair is offline. The session-end command was not queued.' },
        { status: 409 }
      );
    }

    if (chair.locked && ['LOCKED', 'AVAILABLE'].includes(chair.session_state || 'LOCKED')) {
      return NextResponse.json({ ok: true, message: 'already_available' });
    }

    const safeReason = reason === 'rider_cancel' ? 'rider_cancel' : 'operator_cancel';
    const { data: result, error: rpcError } = await supabase.rpc('request_session_end_tx', {
      p_wheelchair_id: wheelchair_id,
      p_reason: safeReason
    });

    if (rpcError) {
      console.error('Session-end transaction failed:', rpcError);
      return NextResponse.json({ error: 'Unable to queue the session-end command.' }, { status: 500 });
    }

    if (!result?.ok) {
      return NextResponse.json(
        { error: result?.error || 'The session could not be ended.' },
        { status: 409 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('End rental API error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
