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
  VIEW_H,
  VIEW_PRESETS,
  VIEW_W,
  ViewPreset,
  YAW_SENS,
  cameraVelocityFromGesture,
  clamp,
  decayCameraVelocity,
  lerpYaw,
  normalizeCamera,
  zoomAroundFocal,
} from '../utils/trajectoryProjection';

const PRESET_TRANSITION_MS = 420;

interface Options {
  onGestureActiveChange?: (active: boolean) => void;
  initialCamera?: Camera;
  enabled?: boolean;
}

export function useTrajectoryCamera({ onGestureActiveChange, initialCamera, enabled = true }: Options = {}) {
  const initialCameraRef = useRef(normalizeCamera(initialCamera ?? DEFAULT_CAMERA));
  const [camera, setCamera] = useState<Camera>(initialCameraRef.current);
  const [gesturing, setGesturing] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(initialCamera ? null : VIEW_PRESETS[0].id);

  const cameraRef = useRef(camera);
  const cameraRafRef = useRef<number | null>(null);
  const pendingCameraRef = useRef<Camera | null>(null);
  const liveRafRef = useRef<number | null>(null);
  const livePendingRef = useRef<Camera | null>(null);
  const inertiaRafRef = useRef<number | null>(null);
  const inertiaVelRef = useRef({ yaw: 0, pitch: 0 });
  const gestureStartRef = useRef<Camera>(initialCameraRef.current);
  const pinchStartZoomRef = useRef(initialCameraRef.current.zoom);
  const viewportRef = useRef({ width: VIEW_W, height: VIEW_H });
  const gesturingRef = useRef(false);
  const transitionRafRef = useRef<number | null>(null);
  const gestureModeRef = useRef<'none' | 'pan' | 'pinch'>('none');

  cameraRef.current = camera;

  const publishCamera = useCallback((next: Camera) => {
    const normalized = normalizeCamera(next);
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
    const normalized = normalizeCamera(next);
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
      const normalized = normalizeCamera(next);
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
    (velocityX: number, velocityY: number) => {
      const initial = cameraVelocityFromGesture(velocityX, velocityY);
      if (Math.abs(initial.yaw) < 0.03 && Math.abs(initial.pitch) < 0.03) return;
      inertiaVelRef.current = initial;
      let previous = performance.now();
      const tick = (now: number) => {
        const elapsedMs = clamp(now - previous, 1, 34);
        previous = now;
        const vel = inertiaVelRef.current;
        if (Math.abs(vel.yaw * elapsedMs) < 0.02 && Math.abs(vel.pitch * elapsedMs) < 0.02) {
          inertiaRafRef.current = null;
          return;
        }
        const current = cameraRef.current;
        commitCamera({
          ...current,
          yaw: current.yaw + vel.yaw * elapsedMs,
          pitch: current.pitch + vel.pitch * elapsedMs,
        });
        vel.yaw = decayCameraVelocity(vel.yaw, elapsedMs);
        vel.pitch = decayCameraVelocity(vel.pitch, elapsedMs);
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
          zoom: from.zoom + (1 - from.zoom) * ease,
          panX: from.panX * (1 - ease),
          panY: from.panY * (1 - ease),
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
    publishCamera(initialCameraRef.current);
    setActivePreset(initialCamera ? null : VIEW_PRESETS[0].id);
  }, [flushLiveCamera, initialCamera, publishCamera, stopInertia, stopTransition]);

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
      startInertia(vx, vy);
      endGesture();
    },
    [endGesture, startInertia],
  );

  const onPanFinalize = useCallback(() => {
    if (gestureModeRef.current === 'pan') endGesture();
  }, [endGesture]);

  const onPinchBegin = useCallback(
    (focalX: number, focalY: number) => {
      beginGesture('pinch');
      gestureStartRef.current = cameraRef.current;
      pinchStartZoomRef.current = cameraRef.current.zoom;
    },
    [beginGesture],
  );

  const onPinchUpdate = useCallback(
    (scale: number, focalX: number, focalY: number) => {
      if (gestureModeRef.current !== 'pinch') return;
      const start = gestureStartRef.current;
      const nextZoom = pinchStartZoomRef.current * Math.pow(scale, 1.02);
      const viewport = viewportRef.current;
      const viewFocalX = focalX * VIEW_W / Math.max(1, viewport.width);
      const viewFocalY = focalY * VIEW_H / Math.max(1, viewport.height);
      const partial = zoomAroundFocal(start, nextZoom, viewFocalX, viewFocalY);
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
      .enabled(enabled)
      .numberOfTaps(2)
      .maxDuration(280)
      .onEnd(() => {
        runOnJS(onDoubleTap)();
      });

    const pan = Gesture.Pan()
      .enabled(enabled)
      .maxPointers(1)
      .minDistance(4)
      .activeOffsetX([-8, 8])
      .activeOffsetY([-8, 8])
      .onStart(() => {
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
      .enabled(enabled)
      .onStart((e) => {
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
    return Gesture.Simultaneous(pan, pinch, doubleTap);
  }, [
    enabled,
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
    setViewportSize: (width: number, height: number) => {
      viewportRef.current = { width: Math.max(1, width), height: Math.max(1, height) };
    },
  };
};
