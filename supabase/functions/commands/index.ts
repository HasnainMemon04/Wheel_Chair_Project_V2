import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id, x-device-signature',
}

type JsonRecord = Record<string, unknown>

function jsonResponse(
  body: JsonRecord | unknown[],
  status: number,
  timing?: { rpcMs?: number; totalMs?: number }
) {
  const serverTiming = timing
    ? [
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

async function verifySignature(messageText: string, key: string, signatureHex: string): Promise<boolean> {
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
      encoder.encode(messageText)
    )
  } catch (error) {
    console.error('Signature verification error:', error)
    return false
  }
}

serve(async (req) => {
  const requestStartedAt = performance.now()

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const deviceId = req.headers.get('x-device-id')
    const signatureHex = req.headers.get('x-device-signature')
    if (!deviceId || !signatureHex) {
      return jsonResponse({ error: 'Missing authentication headers' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: wheelchair, error: keyError } = await supabase
      .from('wheelchairs')
      .select('device_key')
      .eq('id', deviceId)
      .single()

    if (keyError || !wheelchair?.device_key) {
      console.error(`Device ${deviceId} not found or has no key.`, keyError)
      return jsonResponse({ error: 'Device not registered' }, 401)
    }

    const url = new URL(req.url)
    if (req.method === 'GET') {
      const queryString = url.search.slice(1)
      const signatureValid = await verifySignature(
        queryString,
        wheelchair.device_key,
        signatureHex
      )
      if (!signatureValid) {
        return jsonResponse({ error: 'Invalid HMAC signature on query parameters' }, 401)
      }

      const { data: pendingCommands, error: commandError } = await supabase
        .from('commands')
        .select('id, cmd, req_id, args')
        .eq('wheelchair_id', deviceId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })

      if (commandError) throw commandError
      return jsonResponse(pendingCommands || [], 200)
    }

    if (req.method === 'POST') {
      const bodyText = await req.text()
      const signatureValid = await verifySignature(
        bodyText,
        wheelchair.device_key,
        signatureHex
      )
      if (!signatureValid) {
        return jsonResponse({ error: 'Invalid HMAC signature on body' }, 401)
      }

      const body = JSON.parse(bodyText) as JsonRecord
      if (!body.id || !body.req_id) {
        return jsonResponse({ error: 'Missing mandatory ack fields' }, 400)
      }

      const rpcStartedAt = performance.now()
      const { data: rpcResult, error: ackError } = await supabase.rpc(
        'ack_device_command_tx',
        {
          p_device_id: deviceId,
          p_ack: body,
        }
      )
      if (ackError) throw ackError

      const rpcMs = Math.max(0, Math.round(performance.now() - rpcStartedAt))
      const totalMs = Math.max(0, Math.round(performance.now() - requestStartedAt))
      const result = rpcResult && typeof rpcResult === 'object'
        ? rpcResult as JsonRecord
        : { ok: true }

      return jsonResponse(
        { ...result, server: { rpc_ms: rpcMs, total_ms: totalMs } },
        200,
        { rpcMs, totalMs }
      )
    }

    return jsonResponse({ error: 'Method not allowed' }, 405)
  } catch (error: unknown) {
    console.error('Commands error:', error)
    const message = error instanceof Error ? error.message : 'Internal Server Error'
    return jsonResponse({ error: message }, 500)
  }
})
