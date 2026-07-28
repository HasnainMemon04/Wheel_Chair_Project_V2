import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Initialize privileged service-role client to bypass RLS during webhook handling
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { provider, rental_id, amount, provider_ref } = body;

    // 1. Env-gate check: Reject mock payments if not explicitly configured in dev mode
    const configuredProvider = process.env.PAYMENT_PROVIDER || 'mock'; // Default to mock in scaffolding
    
    if (provider === 'mock' && configuredProvider !== 'mock') {
      return NextResponse.json({ error: 'Mock payments are disabled in production' }, { status: 403 });
    }

    if (!rental_id || !provider_ref) {
      return NextResponse.json({ error: 'Missing mandatory fields' }, { status: 400 });
    }

    // 2. Atomic payment → activation → command enqueue via a single Postgres
    // transaction (activate_rental_tx in cloud/schema.sql). Either the payment
    // insert, rental activation, AND the UNLOCK/SET_SPEED_LIMIT/SET_GEOFENCE
    // enqueue ALL commit, or none do — a crash mid-webhook can no longer strand
    // a paid rider on a locked chair. The function's idempotency guard also
    // repairs rentals that are 'active' but missing their UNLOCK command.
    const { data: txResult, error: txError } = await supabase.rpc('activate_rental_tx', {
      p_rental_id: rental_id,
      p_amount: amount,
      p_provider: provider,
      p_provider_ref: provider_ref
    });

    if (txError) throw txError;

    if (!txResult?.ok) {
      const status = txResult?.error === 'rental_not_found' ? 404 : 409;
      console.error(`Rental activation rejected for ${rental_id}:`, txResult);
      return NextResponse.json({ error: txResult?.error || 'Activation failed' }, { status });
    }

    console.log(`Rental ${rental_id} activated atomically (${txResult.message || 'unlocked'}).`);
    return NextResponse.json({ ok: true, unlocked: true, message: txResult.message });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
