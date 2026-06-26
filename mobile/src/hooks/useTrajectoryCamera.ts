import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import {
  Camera,
  CENTER_X,
  CENTER_Y,
  DEFAULT_CAMERA,
  MAX_ZOOM,
  MIN_ZOOM,
  PITCH_SENS,
  VIEW_PRESETS,
  ViewPreset,
  YAW_SENS,
  clamp,
  lerpYaw,
  normalizeYaw,
  zoomAroundFocal,
} from '../utils/trajectoryProjection';

const PRESET_TRANSITION_MS = 300;

interface Options {
  onGestureActiveChange?: (active: boolean) => void;
}

export function useTrajectoryCamera({ onGestureActiveChange }: Options = {}) {
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [gesturing, setGesturing] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(VIEW_PRESETS[0].id);

  const cameraRef = useRef(camera);
  const cameraRafRef = useRef<number | null>(null);
  const pendingCameraRef = useRef<Camera | null>(null);
  const liveRafRef = useRef<number | null>(null);
  const livePendingRef = useRef<Camera | null>(null);
  const inertiaRafRef = useRef<number | null>(null);
  const inertiaVelRef = useRef({ yaw: 0, pitch: 0 });
  const gestureStartRef = useRef<Camera>(DEFAULT_CAMERA);
  const pinchStartZoomRef = useRef(1);
  const pinchFocalRef = useRef({ x: CENTER_X, y: CENTER_Y });
  const gesturingRef = useRef(false);
  const transitionRafRef = useRef<number | null>(null);
  const gestureModeRef = useRef<'none' | 'pan' | 'pinch'>('none');

  cameraRef.current = camera;

  const publishCamera = useCallback((next: Camera) => {
    const normalized: Camera = { ...next, yaw: normalizeYaw(next.yaw) };
    cameraRef.current = normalized;
    setCamera(normalized);
  }, []);

  const flushLiveCamera = useCallback(() => {
    if (liveRafRef.current != null) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    const pending = livePendingRef.current;
    livePendingRef.current = null;
    if (pending) publishCamera(pending);
  }, [publishCamera]);

  // Batched updates for inertia / preset transitions (not finger tracking).
  const commitCamera = useCallback((next: Camera) => {
    const normalized: Camera = { ...next, yaw: normalizeYaw(next.yaw) };
    cameraRef.current = normalized;
    pendingCameraRef.current = normalized;
    if (cameraRafRef.current != null) return;
    cameraRafRef.current = requestAnimationFrame(() => {
      cameraRafRef.current = null;
      const pending = pendingCameraRef.current;
      pendingCameraRef.current = null;
      if (pending) setCamera(pending);
    });
  }, []);

  // Coalesce high-frequency touch events to one React update per display frame.
  const applyCameraLive = useCallback(
    (next: Camera) => {
      const normalized: Camera = { ...next, yaw: normalizeYaw(next.yaw) };
      cameraRef.current = normalized;
      livePendingRef.current = normalized;
      if (liveRafRef.current != null) return;
      liveRafRef.current = requestAnimationFrame(() => {
        liveRafRef.current = null;
        const pending = livePendingRef.current;
        livePendingRef.current = null;
        if (pending) setCamera(pending);
      });
    },
    [],
  );

  const stopInertia = useCallback(() => {
    if (inertiaRafRef.current != null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
    inertiaVelRef.current = { yaw: 0, pitch: 0 };
  }, []);

  const stopTransition = useCallback(() => {
    if (transitionRafRef.current != null) {
      cancelAnimationFrame(transitionRafRef.current);
      transitionRafRef.current = null;
    }
  }, []);

  const setGestureActive = useCallback(
    (active: boolean) => {
      if (gesturingRef.current === active) return;
      gesturingRef.current = active;
      setGesturing(active);
      onGestureActiveChange?.(active);
    },
    [onGestureActiveChange],
  );

  const beginGesture = useCallback(
    (mode: 'pan' | 'pinch') => {
      stopInertia();
      stopTransition();
      flushLiveCamera();
      gestureModeRef.current = mode;
      gestureStartRef.current = cameraRef.current;
      setGestureActive(true);
      setActivePreset(null);
    },
    [flushLiveCamera, setGestureActive, stopInertia, stopTransition],
  );

  const endGesture = useCallback(() => {
    flushLiveCamera();
    gestureModeRef.current = 'none';
    setGestureActive(false);
  }, [flushLiveCamera, setGestureActive]);

  const startInertia = useCallback(
    (vyaw: number, vpitch: number) => {
      if (Math.abs(vyaw) < 0.35 && Math.abs(vpitch) < 0.35) return;
      inertiaVelRef.current = { yaw: vyaw, pitch: vpitch };
      const tick = () => {
        const vel = inertiaVelRef.current;
        vel.yaw *= 0.88;
        vel.pitch *= 0.88;
        if (Math.abs(vel.yaw) < 0.08 && Math.abs(vel.pitch) < 0.08) {
          inertiaRafRef.current = null;
          return;
        }
        const current = cameraRef.current;
        commitCamera({
          ...current,
          yaw: current.yaw + vel.yaw,
          pitch: clamp(current.pitch + vel.pitch, -8, 88),
        });
        inertiaRafRef.current = requestAnimationFrame(tick);
      };
      inertiaRafRef.current = requestAnimationFrame(tick);
    },
    [commitCamera],
  );

  const applyPreset = useCallback(
    (preset: ViewPreset) => {
      stopInertia();
      stopTransition();
      flushLiveCamera();
      const from = cameraRef.current;
      const targetYaw = preset.yaw;
      const targetPitch = preset.pitch;
      const started = performance.now();
      const tick = (now: number) => {
        const t = clamp((now - started) / PRESET_TRANSITION_MS, 0, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        commitCamera({
          ...from,
          yaw: lerpYaw(from.yaw, targetYaw, ease),
          pitch: from.pitch + (targetPitch - from.pitch) * ease,
        });
        if (t < 1) {
          transitionRafRef.current = requestAnimationFrame(tick);
        } else {
          transitionRafRef.current = null;
          setActivePreset(preset.id);
        }
      };
      transitionRafRef.current = requestAnimationFrame(tick);
      setActivePreset(preset.id);
    },
    [commitCamera, flushLiveCamera, stopInertia, stopTransition],
  );

  const adjustZoom = useCallback(
    (delta: number) => {
      stopInertia();
      stopTransition();
      flushLiveCamera();
      const current = cameraRef.current;
      publishCamera({
        ...current,
        ...zoomAroundFocal(current, current.zoom + delta, CENTER_X, CENTER_Y),
      });
      setActivePreset(null);
    },
    [flushLiveCamera, publishCamera, stopInertia, stopTransition],
  );

  const resetView = useCallback(() => {
    stopInertia();
    stopTransition();
    flushLiveCamera();
    publishCamera({ ...DEFAULT_CAMERA });
    setActivePreset(VIEW_PRESETS[0].id);
  }, [flushLiveCamera, publishCamera, stopInertia, stopTransition]);

  const onPanBegin = useCallback(() => {
    if (gestureModeRef.current === 'pinch') return;
    beginGesture('pan');
  }, [beginGesture]);

  const onPanUpdate = useCallback(
    (dx: number, dy: number) => {
      if (gestureModeRef.current !== 'pan') return;
      const start = gestureStartRef.current;
      applyCameraLive({
        ...start,
        yaw: start.yaw + dx * YAW_SENS,
        pitch: clamp(start.pitch - dy * PITCH_SENS, -8, 88),
      });
    },
    [applyCameraLive],
  );

  const onPanEnd = useCallback(
    (vx: number, vy: number) => {
      if (gestureModeRef.current !== 'pan') return;
      startInertia(vx * 8, -vy * 6.5);
      endGesture();
    },
    [endGesture, startInertia],
  );

  const onPanFinalize = useCallback(() => {
    if (gestureModeRef.current === 'pan') endGesture();
  }, [endGesture]);

  const onPinchBegin = useCallback(
    (focalX: number, focalY: number) => {
      if (gestureModeRef.current === 'pan') return;
      beginGesture('pinch');
      gestureStartRef.current = cameraRef.current;
      pinchStartZoomRef.current = cameraRef.current.zoom;
      pinchFocalRef.current = { x: focalX, y: focalY };
    },
    [beginGesture],
  );

  const onPinchUpdate = useCallback(
    (scale: number, focalX: number, focalY: number) => {
      if (gestureModeRef.current !== 'pinch') return;
      const start = gestureStartRef.current;
      const nextZoom = pinchStartZoomRef.current * Math.pow(scale, 1.02);
      const partial = zoomAroundFocal(start, nextZoom, focalX, focalY);
      applyCameraLive({ ...start, ...partial });
    },
    [applyCameraLive],
  );

  const onPinchEnd = useCallback(() => {
    if (gestureModeRef.current !== 'pinch') return;
    endGesture();
  }, [endGesture]);

  const onPinchFinalize = useCallback(() => {
    if (gestureModeRef.current === 'pinch') endGesture();
  }, [endGesture]);

  const onDoubleTap = useCallback(() => {
    resetView();
  }, [resetView]);

  const gesture = useMemo(() => {
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(280)
      .onEnd(() => {
        runOnJS(onDoubleTap)();
      });

    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(4)
      .activeOffsetX([-8, 8])
      .activeOffsetY([-8, 8])
      .onBegin(() => {
        runOnJS(onPanBegin)();
      })
      .onUpdate((e) => {
        runOnJS(onPanUpdate)(e.translationX, e.translationY);
      })
      .onEnd((e) => {
        runOnJS(onPanEnd)(e.velocityX, e.velocityY);
      })
      .onFinalize(() => {
        runOnJS(onPanFinalize)();
      });

    const pinch = Gesture.Pinch()
      .onBegin((e) => {
        runOnJS(onPinchBegin)(e.focalX, e.focalY);
      })
      .onUpdate((e) => {
        runOnJS(onPinchUpdate)(e.scale, e.focalX, e.focalY);
      })
      .onEnd(() => {
        runOnJS(onPinchEnd)();
      })
      .onFinalize(() => {
        runOnJS(onPinchFinalize)();
      });

    // Double-tap runs in parallel so it doesn't block single-finger pan recognition.
    return Gesture.Simultaneous(Gesture.Exclusive(pan, pinch), doubleTap);
  }, [
    onDoubleTap,
    onPanBegin,
    onPanEnd,
    onPanFinalize,
    onPanUpdate,
    onPinchBegin,
    onPinchEnd,
    onPinchFinalize,
    onPinchUpdate,
  ]);

  useEffect(
    () => () => {
      if (cameraRafRef.current != null) cancelAnimationFrame(cameraRafRef.current);
      if (liveRafRef.current != null) cancelAnimationFrame(liveRafRef.current);
      stopInertia();
      stopTransition();
    },
    [stopInertia, stopTransition],
  );

  return {
    camera,
    gesturing,
    activePreset,
    gesture,
    applyPreset,
    adjustZoom,
    resetView,
    stopInertia,
  };
};
