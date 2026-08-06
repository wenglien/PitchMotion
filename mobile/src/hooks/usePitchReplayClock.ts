import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export type ReplayRate = 0.5 | 1;

export function usePitchReplayClock(durationS: number, active = true) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rate, setRate] = useState<ReplayRate>(0.5);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const elapsedRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    elapsedRef.current = 0;
    setProgress(0);
    setPlaying(reduceMotion === false);
  }, [durationS, reduceMotion]);

  useEffect(() => {
    if (!playing || !active) return;
    let frame = 0;
    let previous = Date.now();
    const durationMs = Math.max(1, durationS * 1000);
    const tick = () => {
      const now = Date.now();
      elapsedRef.current += (now - previous) * rate;
      previous = now;
      const next = Math.min(1, elapsedRef.current / durationMs);
      setProgress(next);
      if (next < 1) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, durationS, playing, rate]);

  const replay = useCallback(() => {
    elapsedRef.current = 0;
    setProgress(0);
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => {
    if (progress >= 1) replay();
    else setPlaying((value) => !value);
  }, [progress, replay]);

  return { playing, progress, rate, setRate, replay, toggle, reduceMotion };
}
