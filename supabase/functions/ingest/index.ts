import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id, x-device-signature',
}

type JsonRecord = Record<string, unknown>

function jsonResponse(
  body: JsonRecord,
  status: number,
  timing?: { authMs?: number; rpcMs?: number; totalMs?: number }
) {
  const serverTiming = timing
    ? [
        timing.authMs === undefined ? null : `auth;dur=${timing.authMs}`,
        timing.rpcMs === undefined ? null : `rpc;dur=${timing.rpcMs}`,
        timing.totalMs === undefined ? null : `total;dur=${timing.totalMs}`,
      ].filter(Boolean).join(', ')
    : ''

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(serverTiming ? { 'Server-Timing': serverTiming } : {}),
    },
  })
}

async function verifySignature(bodyText: string, key: string, signatureHex: string): Promise<boolean> {
  try {
    if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return false

    const encoder = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const sigBytes = new Uint8Array(
      signatureHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))
    )

    return await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      sigBytes,
      encoder.encode(bodyText)
    )
  } catch (error) {
    console.error('Signature verification error:', error)
    return false
  }
}

function payloadTimestamp(payload: JsonRecord) {
  const capturedAtMs = payload.captured_at_ms
  if (
    typeof capturedAtMs === 'number'
    && Number.isFinite(capturedAtMs)
    && capturedAtMs > 1672531200000
  ) {
    return new Date(capturedAtMs).toISOString()
  }

  const epochSeconds = payload.ts
  if (
    typeof epochSeconds === 'number'
    && Number.isFinite(epochSeconds)
    && epochSeconds > 1672531200
  ) {
    return new Date(epochSeconds * 1000).toISOString()
  }

  return new Date().toISOString()
}

serve(async (req) => {
  const requestStartedAt = performance.now()

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    const deviceId = req.headers.get('x-device-id')
    const signatureHex = req.headers.get('x-device-signature')
    if (!deviceId || !signatureHex) {
      return jsonResponse({ error: 'Missing authentication headers' }, 401)
    }

    const bodyText = await req.text()
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Authentication deliberately remains outside the transaction. The
    // service-role RPC is only reachable after the device's HMAC is valid.
    const { data: wheelchair, error: keyError } = await supabase
      .from('wheelchairs')
      .select('device_key')
      .eq('id', deviceId)
      .single()

    if (keyError || !wheelchair?.device_key) {
      console.error(`Rejected unregistered device ${deviceId}.`, keyError)
      return jsonResponse({ error: 'Device not registered' }, 401)
    }

    const signatureValid = await verifySignature(bodyText, wheelchair.device_key, signatureHex)
    if (!signatureValid) {
      return jsonResponse({ error: 'Invalid HMAC signature' }, 401)
    }
    const authMs = Math.max(0, Math.round(performance.now() - requestStartedAt))

    const payload = JSON.parse(bodyText) as JsonRecord
    const ts = payloadTimestamp(payload)

    if (payload.kind === 'telemetry') {
      const rpcStartedAt = performance.now()
      const { data: rpcResult, error: ingestError } = await supabase.rpc(
        'ingest_telemetry_tx',
        {
          p_device_id: deviceId,
          p_ts: ts,
          p_payload: payload,
          p_auth_ms: authMs,
        }
      )
      const rpcMs = Math.max(0, Math.round(performance.now() - rpcStartedAt))

      if (ingestError) {
        throw new Error(`Telemetry transaction error: ${ingestError.message}`)
      }

      const result = rpcResult && typeof rpcResult === 'object'
        ? rpcResult as JsonRecord
        : { ok: true, commands: [] }
      const rpcServer = result.server && typeof result.server === 'object'
        ? result.server as JsonRecord
        : {}
      const totalMs = Math.max(0, Math.round(performance.now() - requestStartedAt))

      return jsonResponse(
        {
          ...result,
          server: {
            ...rpcServer,
            edge_rpc_ms: rpcMs,
            total_ms: totalMs,
          },
        },
        200,
        { authMs, rpcMs, totalMs }
      )
    }

    if (payload.kind === 'event') {
      let detail = payload.detail
      if (detail === null || detail === undefined) {
        detail = {}
      } else if (typeof detail !== 'object' || Array.isArray(detail)) {
        detail = { raw: String(detail) }
      }
      detail = {
        ...(detail as JsonRecord),
        pipeline: {
          seq: payload.seq ?? null,
          captured_at_ms: payload.captured_at_ms ?? null,
          queue_ms: payload.queue_ms ?? null,
          serialize_ms: payload.serialize_ms ?? null,
          payload_bytes: payload.payload_bytes ?? bodyText.length,
          server_auth_ms: authMs,
        },
      }

      const { error: eventError } = await supabase
        .from('events')
        .insert({
          wheelchair_id: deviceId,
          type: payload.event,
          detail,
          lat: payload.lat,
          lng: payload.lng,
          ts,
        })

      if (eventError) {
        throw new Error(`Event insert error: ${eventError.message}`)
      }

      const totalMs = Math.max(0, Math.round(performance.now() - requestStartedAt))
      return jsonResponse(
        { ok: true, commands: [], server: { auth_ms: authMs, total_ms: totalMs } },
        200,
        { authMs, totalMs }
      )
    }

    return jsonResponse({ error: 'Unknown payload kind' }, 400)
  } catch (error: unknown) {
    console.error('Ingest error:', error)
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    return jsonResponse({ error: message }, 500)
  }
})
