import { useEffect, useRef, useState } from "react";

/**
 * Animate a number toward its latest value.
 *
 * Telemetry arrives in steps, one per scrape, and a figure that jumps from 48
 * to 52 reads as a glitch. Easing between readings makes the change legible as
 * a change. The animation always starts from the value currently on screen, so
 * a reading that lands mid-tween redirects smoothly instead of restarting.
 *
 * Honours `prefers-reduced-motion` by snapping straight to the target.
 */
export function useTween(target: number | null, durationMs = 700): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const shownRef = useRef<number | null>(target);
  const frame = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    const from = shownRef.current;
    const reduce =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (target === null || from === null || reduce || !Number.isFinite(from) || from === target) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const v = from + (target - from) * eased;
      shownRef.current = v;
      setShown(v);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [target, durationMs]);

  return shown;
}
