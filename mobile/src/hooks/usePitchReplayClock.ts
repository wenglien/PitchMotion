import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export type ReplayRate = 0.25 | 0.5 | 1;

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
    let previous = performance.now();
    const durationMs = Math.max(1, durationS * 1000);
    const tick = () => {
      const now = performance.now();
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

  const seek = useCallback((nextProgress: number) => {
    const next = Math.min(1, Math.max(0, nextProgress));
    elapsedRef.current = next * Math.max(1, durationS * 1000);
    setProgress(next);
    setPlaying(false);
  }, [durationS]);

  return { playing, progress, rate, setRate, replay, toggle, seek, reduceMotion };
}
