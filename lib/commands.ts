'use client';

import { supabase } from './supabase';

// The web app is a viewer and a request-issuer (HANDOFF.md). It NEVER decides
// safety: it inserts a command and waits for the DEVICE's ack. A command with
// no ack inside the timeout renders as FAILED — never as success.

export interface CommandResult {
  ok: boolean;
  status: 'acked' | 'failed' | 'timeout' | 'error';
  message?: string;
}

const ACK_TIMEOUT_MS = 3500;

export async function sendCommand(
  wheelchairId: string,
  cmd: string,
  args: Record<string, unknown> = {},
  opts: { reqId?: string; waitForAck?: boolean } = {}
): Promise<CommandResult> {
  const reqId = opts.reqId || `v2-${cmd.toLowerCase()}-${Date.now()}`;
  const waitForAck = opts.waitForAck !== false;

  const { data, error } = await supabase
    .from('commands')
    .insert({ wheelchair_id: wheelchairId, cmd, args, status: 'pending', req_id: reqId })
    .select('id')
    .single();

  if (error) return { ok: false, status: 'error', message: error.message };
  if (!waitForAck) return { ok: true, status: 'acked' };

  const id = (data as { id: string }).id;
  const deadline = Date.now() + ACK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const { data: row } = await supabase
      .from('commands')
      .select('status, ack')
      .eq('id', id)
      .maybeSingle();
    const status = (row as { status?: string } | null)?.status;
    if (status === 'acked') return { ok: true, status: 'acked' };
    if (status === 'failed') {
      return { ok: false, status: 'failed', message: 'The chair refused the command — a safety check is active.' };
    }
  }
  return { ok: false, status: 'timeout', message: 'No response from the chair. Nothing was changed.' };
}
