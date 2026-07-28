'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Hold-to-confirm, per HANDOFF.md:
//  * the gesture is tracked on a REF, never in state — a pointercancel that
//    lands in the same batch as the press would otherwise latch the button on
//    forever.
//  * release resets unconditionally.
//  * a cancel arriving within ~90ms of the press is ignored (browsers fire a
//    spurious pointercancel when the press starts a scroll/gesture probe).
export function useHold(durationMs: number, onComplete: () => void) {
  const [pct, setPct] = useState(0);
  const raf = useRef<number | null>(null);
  const startedAt = useRef(0);
  const holding = useRef(false);
  const doneRef = useRef(onComplete);

  // Assigned in an effect, not during render: mutating a ref while rendering
  // is impure and misbehaves under concurrent/StrictMode double-rendering.
  useEffect(() => {
    doneRef.current = onComplete;
  }, [onComplete]);

  const stop = useCallback(() => {
    holding.current = false;
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    setPct(0);
  }, []);

  const start = useCallback(() => {
    if (holding.current) return;
    holding.current = true;
    startedAt.current = performance.now();

    // The loop lives inside start() as a local, so it can schedule itself
    // without a hook having to depend on its own identity.
    const tick = () => {
      if (!holding.current) return;
      const p = Math.min(1, (performance.now() - startedAt.current) / durationMs);
      setPct(p);
      if (p >= 1) {
        holding.current = false;
        raf.current = null;
        setPct(0);
        doneRef.current();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
  }, [durationMs]);

  // Release: always reset. Cancel: ignore if it lands within 90ms of press.
  const end = useCallback(() => {
    stop();
  }, [stop]);

  const cancel = useCallback(() => {
    if (holding.current && performance.now() - startedAt.current < 90) return;
    stop();
  }, [stop]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  return {
    pct,
    pctLabel: `${Math.round(pct * 100)}%`,
    // Derived from reactive state, NOT from the ref. A ref read during render
    // is stale and never triggers a re-render, so consumers reading `holding`
    // were getting the previous frame's value. The ref still drives the
    // gesture itself, which is what HANDOFF requires.
    holding: pct > 0,
    handlers: {
      onPointerDown: start,
      onPointerUp: end,
      onPointerLeave: end,
      onPointerCancel: cancel,
    },
  };
}
