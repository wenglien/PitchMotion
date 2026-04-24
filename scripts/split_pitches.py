from __future__ import annotations

import argparse
import dataclasses
import logging
import math
import os
import subprocess
from pathlib import Path
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np
from ultralytics import YOLO

from src.SORT_tracker.sort import Sort
from src.release_point_detector import ReleasePointDetector
from src.get_pitch_frames_yolov8 import (
    _get_video_rotation,
    _get_raw_video_dims_ffprobe,
    _infer_ball_class_ids,
    _filter_candidate_dets,
    _find_flight_end_frame,
    _detect_catch_from_audio,
)

log = logging.getLogger("split_pitches")

mp_pose = mp.solutions.pose


@dataclasses.dataclass
class RawFrameMeta:
    frame_id: int
    dets_list: list[np.ndarray]
    has_pose: bool
    pose_landmarks: object | None
    pose_world_landmarks: object | None


@dataclasses.dataclass
class TrackCandidate:
    track_id: int
    start_frame: int
    end_frame: int
    score: float
    items: list[dict]


@dataclasses.dataclass
class ClipWindow:
    pitch_index: int
    start_frame: int
    release_frame: Optional[int]
    first_ball_frame: int
    catch_frame: int
    end_frame: int


def _run(cmd: list[str]) -> None:
    log.debug("RUN: %s", " ".join(cmd))
    subprocess.run(cmd, check=True)


def _video_meta(video_path: str) -> tuple[int, int, float, int]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    dims = _get_raw_video_dims_ffprobe(video_path)
    if dims is None:
        cap2 = cv2.VideoCapture(video_path)
        w = int(cap2.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap2.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap2.release()
    else:
        w, h = dims

    if fps <= 0:
        fps = 30.0

    return w, h, float(fps), frame_count


def _rotate_frame_if_needed(frame_bgr: np.ndarray, rotate_code: Optional[int]) -> np.ndarray:
    if rotate_code is not None:
        return cv2.rotate(frame_bgr, rotate_code)
    return frame_bgr


def _build_tracks(
    raw_detections: list[RawFrameMeta],
) -> tuple[dict[int, list[dict]], dict[int, dict[int, tuple[int, int]]]]:
    sort_tracker = Sort(max_age=10, min_hits=1, iou_threshold=0.1)
    tracks_by_id: dict[int, list[dict]] = {}
    tracks_by_frame: dict[int, dict[int, tuple[int, int]]] = {}

    for rd in raw_detections:
        fid = rd.frame_id
        if rd.dets_list:
            dets_np = np.array([d[:5] for d in rd.dets_list], dtype=float)
            trackings = sort_tracker.update(dets_np)
        else:
            trackings = sort_tracker.update()

        if trackings is None or len(trackings) == 0:
            continue

        for t in trackings:
            x1, y1, x2, y2, tid = t.tolist()
            tid = int(tid)
            cx = int((x1 + x2) / 2)
            cy = int((y1 + y2) / 2)
            area = float(max(0.0, (x2 - x1)) * max(0.0, (y2 - y1)))

            tracks_by_id.setdefault(tid, []).append(
                {"frame_id": fid, "cx": cx, "cy": cy, "area": area}
            )
            tracks_by_frame.setdefault(fid, {})[tid] = (cx, cy)

    return tracks_by_id, tracks_by_frame


def _merge_tracks(
    tracks_by_id: dict[int, list[dict]],
    tracks_by_frame: dict[int, dict[int, tuple[int, int]]],
) -> None:
    merge_frame_gap = 8
    merge_overlap = 10
    merge_endpoint_tol = 250
    merge_min_speed = 10.0

    def avg_speed(items_sorted: list[dict]) -> float:
        if len(items_sorted) < 2:
            return 0.0
        speeds = []
        for i in range(1, len(items_sorted)):
            df = max(1, items_sorted[i]["frame_id"] - items_sorted[i - 1]["frame_id"])
            dx = items_sorted[i]["cx"] - items_sorted[i - 1]["cx"]
            dy = items_sorted[i]["cy"] - items_sorted[i - 1]["cy"]
            speeds.append(float(np.hypot(dx, dy)) / df)
        return float(np.mean(speeds)) if speeds else 0.0

    changed = True
    while changed:
        changed = False
        track_list = sorted(
            tracks_by_id.items(),
            key=lambda kv: min(x["frame_id"] for x in kv[1]),
        )
        merged_into: dict[int, int] = {}

        for ai, (tid_a, items_a) in enumerate(track_list):
            if tid_a in merged_into:
                continue

            a_sorted = sorted(items_a, key=lambda x: x["frame_id"])
            a_end_fid = a_sorted[-1]["frame_id"]
            ax_end = float(a_sorted[-1]["cx"])
            ay_end = float(a_sorted[-1]["cy"])
            a_speed = avg_speed(a_sorted)

            for tid_b, items_b in track_list[ai + 1:]:
                if tid_b in merged_into:
                    continue

                b_sorted = sorted(items_b, key=lambda x: x["frame_id"])
                b_start_fid = b_sorted[0]["frame_id"]
                gap_or_overlap = b_start_fid - a_end_fid

                if gap_or_overlap < -merge_overlap or gap_or_overlap > merge_frame_gap:
                    continue

                b_speed = avg_speed(b_sorted)
                if max(a_speed, b_speed) < merge_min_speed:
                    continue

                bx_start = float(b_sorted[0]["cx"])
                by_start = float(b_sorted[0]["cy"])
                dist = float(np.hypot(ax_end - bx_start, ay_end - by_start))
                if dist > merge_endpoint_tol:
                    continue

                b_new_pts = [pt for pt in items_b if pt["frame_id"] > a_end_fid]
                tracks_by_id[tid_a].extend(b_new_pts)
                for pt in b_new_pts:
                    fid = pt["frame_id"]
                    if fid in tracks_by_frame and tid_b in tracks_by_frame[fid]:
                        tracks_by_frame[fid][tid_a] = tracks_by_frame[fid].pop(tid_b)

                del tracks_by_id[tid_b]
                tracks_by_id[tid_a] = sorted(
                    tracks_by_id[tid_a], key=lambda x: x["frame_id"]
                )
                merged_into[tid_b] = tid_a
                changed = True
                break


def _score_track(items: list[dict], width: int, height: int) -> tuple[bool, float]:
    if len(items) < 4:
        return False, -1.0

    pts = sorted(items, key=lambda x: x["frame_id"])
    diag = float(np.hypot(width, height))
    min_displacement = diag * 0.005

    speeds = []
    for i in range(1, len(pts)):
        x0, y0, f0 = pts[i - 1]["cx"], pts[i - 1]["cy"], pts[i - 1]["frame_id"]
        x1, y1, f1 = pts[i]["cx"], pts[i]["cy"], pts[i]["frame_id"]
        df = max(1, int(f1 - f0))
        speeds.append(float(np.hypot(x1 - x0, y1 - y0)) / df)

    avg_speed = float(np.mean(speeds)) if speeds else 0.0
    displacement = float(np.hypot(
        pts[-1]["cx"] - pts[0]["cx"],
        pts[-1]["cy"] - pts[0]["cy"],
    ))

    areas = [float(p.get("area", 0.0)) for p in pts]
    avg_area = float(np.mean(areas)) if areas else 1.0
    growing_pairs = sum(1 for i in range(1, len(areas)) if areas[i] > areas[i - 1])
    growth_ratio = growing_pairs / max(1, len(areas) - 1)

    x_start_norm = pts[0]["cx"] / width
    y_start_norm = pts[0]["cy"] / height
    y_end_norm = pts[-1]["cy"] / height

    if displacement < min_displacement:
        return False, -1.0
    if avg_speed < 2.0:
        return False, -1.0
    if y_start_norm < 0.20:
        return False, -1.0
    if y_end_norm < y_start_norm - 0.05:
        return False, -1.0

    score = (displacement ** 2.0) * (avg_speed + 1.0) * math.sqrt(len(pts)) / ((avg_area + 1.0) ** 0.25)

    if growth_ratio >= 0.6:
        score *= 3.0 * growth_ratio

    cx_start_deviation = abs(x_start_norm - 0.5)
    if cx_start_deviation < 0.25:
        centre_bonus = 1.0 + (0.25 - cx_start_deviation) * 2.0
        score *= centre_bonus

    return True, float(score)


def _cluster_candidates(cands: list[TrackCandidate], fps: float) -> list[TrackCandidate]:
    if not cands:
        return []

    cands = sorted(cands, key=lambda c: c.start_frame)
    clustered: list[list[TrackCandidate]] = []
    gap = int(round(0.40 * fps))

    cur = [cands[0]]
    cur_end = cands[0].end_frame

    for cand in cands[1:]:
        if cand.start_frame <= cur_end + gap:
            cur.append(cand)
            cur_end = max(cur_end, cand.end_frame)
        else:
            clustered.append(cur)
            cur = [cand]
            cur_end = cand.end_frame

    clustered.append(cur)

    chosen: list[TrackCandidate] = []
    for group in clustered:
        chosen.append(max(group, key=lambda c: c.score))

    return chosen


def _read_pose_window(
    video_path: str,
    start_frame: int,
    end_frame: int,
    rotate_code: Optional[int],
    width: int,
    height: int,
) -> list[dict]:
    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
    )
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        pose.close()
        raise RuntimeError(f"Cannot open video for pose window: {video_path}")

    cap.set(cv2.CAP_PROP_POS_FRAMES, float(start_frame))
    out: list[dict] = []
    fid = start_frame

    try:
        while fid <= end_frame:
            ret, frame_bgr = cap.read()
            if not ret:
                break
            frame_bgr = _rotate_frame_if_needed(frame_bgr, rotate_code)
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            results = pose.process(frame_rgb)

            out.append(
                {
                    "frame_id": fid,
                    "has_pose": results.pose_landmarks is not None,
                    "pose_landmarks": results.pose_landmarks,
                    "pose_world_landmarks": results.pose_world_landmarks,
                }
            )
            fid += 1
    finally:
        cap.release()
        pose.close()

    return out


def _detect_release_for_track(
    video_path: str,
    track: TrackCandidate,
    fps: float,
    rotate_code: Optional[int],
    width: int,
    height: int,
) -> tuple[Optional[int], Optional[tuple[int, int]]]:
    lookback = int(round(1.2 * fps))
    lookahead = int(round(0.2 * fps))
    win_start = max(0, track.start_frame - lookback)
    win_end = track.start_frame + lookahead

    pose_frames = _read_pose_window(
        video_path=video_path,
        start_frame=win_start,
        end_frame=win_end,
        rotate_code=rotate_code,
        width=width,
        height=height,
    )

    detector = ReleasePointDetector(fps=int(round(fps)))
    release_pose = None

    for pf in pose_frames:
        if pf["has_pose"]:
            detector.add_frame(pf["pose_landmarks"], width, height)
        else:
            detector.add_frame(None, width, height)

    if detector.frame_count < 10:
        return None, None

    rel = detector.detect_release_point(first_ball_frame=track.start_frame - win_start)
    if not rel or rel["confidence"] <= 0.25:
        return None, None

    release_local_idx = rel["frame_idx"]
    release_frame = win_start + release_local_idx

    pose_idx = release_local_idx
    if 0 <= pose_idx < len(pose_frames) and pose_frames[pose_idx]["has_pose"]:
        pose_lm = pose_frames[pose_idx]["pose_landmarks"]
        throwing = detector.infer_throwing_hand()
        if throwing is not None:
            try:
                finger = pose_lm.landmark[int(throwing["index_finger"])]
                rx = int(finger.x * width)
                ry = int(finger.y * height)
                release_pose = (rx, ry)
            except Exception:
                release_pose = None

    return release_frame, release_pose


def _make_clip_windows(
    video_path: str,
    candidates: list[TrackCandidate],
    fps: float,
    frame_count: int,
    rotate_code: Optional[int],
    width: int,
    height: int,
) -> list[ClipWindow]:
    windows: list[ClipWindow] = []

    for i, cand in enumerate(candidates, start=1):
        release_frame, _ = _detect_release_for_track(
            video_path=video_path,
            track=cand,
            fps=fps,
            rotate_code=rotate_code,
            width=width,
            height=height,
        )

        visual_catch = _find_flight_end_frame(cand.items, int(round(fps)))
        if visual_catch is None:
            visual_catch = cand.end_frame

        audio_catch = _detect_catch_from_audio(
            video_path=video_path,
            fps=fps,
            first_ball_frame_idx=cand.start_frame,
            last_ball_frame_idx_visual=visual_catch,
            release_frame_idx=release_frame,
        )
        catch_frame = audio_catch if audio_catch is not None else visual_catch

        # 起點：盡量接近「抬腳開始」
        # 有 release → 往前抓 0.75 秒
        # 沒 release → 往 first_ball 前抓 0.9 秒
        if release_frame is not None:
            clip_start = max(0, release_frame - int(round(0.75 * fps)))
        else:
            clip_start = max(0, cand.start_frame - int(round(0.90 * fps)))

        # 終點：接球後補 0.20 秒
        clip_end = min(frame_count - 1, catch_frame + int(round(0.20 * fps)))

        windows.append(
            ClipWindow(
                pitch_index=i,
                start_frame=clip_start,
                release_frame=release_frame,
                first_ball_frame=cand.start_frame,
                catch_frame=catch_frame,
                end_frame=clip_end,
            )
        )

    return windows


def _trim_clip(
    input_video: str,
    output_video: str,
    fps: float,
    start_frame: int,
    end_frame: int,
) -> None:
    start_sec = max(0.0, start_frame / fps)
    dur_sec = max(0.05, (end_frame - start_frame + 1) / fps)

    cmd = [
        "ffmpeg",
        "-y",
        "-ss", f"{start_sec:.3f}",
        "-i", input_video,
        "-t", f"{dur_sec:.3f}",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "192k",
        output_video,
    ]
    _run(cmd)


def split_pitches(
    input_video: str,
    weights_path: str,
    output_dir: str,
    conf: float = 0.05,
    yolo_stride: int = 1,
    pose_stride: int = 3,
) -> list[ClipWindow]:
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    raw_w, raw_h, fps, frame_count = _video_meta(input_video)
    rotate_code = _get_video_rotation(input_video)

    if rotate_code in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
        width, height = raw_h, raw_w
    else:
        width, height = raw_w, raw_h

    log.info("Video meta: raw=%dx%d, disp=%dx%d, fps=%.3f, frames=%d",
             raw_w, raw_h, width, height, fps, frame_count)

    yolo_model = YOLO(weights_path)

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
    )

    cap = cv2.VideoCapture(input_video)
    if not cap.isOpened():
        pose.close()
        raise RuntimeError(f"Cannot open video: {input_video}")

    raw_detections: list[RawFrameMeta] = []
    ball_class_ids: Optional[set[int]] = None
    frame_id = 0
    first_result_done = False

    try:
        while True:
            ret, frame_bgr = cap.read()
            if not ret:
                break

            frame_bgr = _rotate_frame_if_needed(frame_bgr, rotate_code)

            pose_results = None
            if frame_id % pose_stride == 0:
                frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
                pose_results = pose.process(frame_rgb)

            dets_filtered: list[np.ndarray] = []
            if frame_id % yolo_stride == 0:
                results = yolo_model.predict(
                    source=frame_bgr,
                    conf=conf,
                    iou=0.3,
                    imgsz=640,
                    verbose=False,
                )
                result = results[0]

                if not first_result_done:
                    ball_class_ids = _infer_ball_class_ids(yolo_model, result)
                    first_result_done = True

                dets_with_cls: list[np.ndarray] = []
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    score = float(box.conf[0].item())
                    cls_id = -1
                    if hasattr(box, "cls") and box.cls is not None:
                        try:
                            cls_id = int(box.cls[0].item())
                        except Exception:
                            cls_id = -1
                    dets_with_cls.append(np.array([x1, y1, x2, y2, score, cls_id], dtype=float))

                dets_filtered = _filter_candidate_dets(
                    dets_with_cls=dets_with_cls,
                    width=width,
                    height=height,
                    ball_class_ids=ball_class_ids,
                    pose_landmarks=pose_results.pose_landmarks if (pose_results and pose_results.pose_landmarks) else None,
                )

            raw_detections.append(
                RawFrameMeta(
                    frame_id=frame_id,
                    dets_list=dets_filtered,
                    has_pose=bool(pose_results and pose_results.pose_landmarks is not None),
                    pose_landmarks=pose_results.pose_landmarks if pose_results else None,
                    pose_world_landmarks=pose_results.pose_world_landmarks if pose_results else None,
                )
            )
            frame_id += 1

    finally:
        cap.release()
        pose.close()

    log.info("Pass1 done: %d frames", len(raw_detections))

    tracks_by_id, tracks_by_frame = _build_tracks(raw_detections)
    _merge_tracks(tracks_by_id, tracks_by_frame)

    candidates: list[TrackCandidate] = []
    for tid, items in tracks_by_id.items():
        ok, score = _score_track(items, width, height)
        if not ok:
            continue
        items_sorted = sorted(items, key=lambda x: x["frame_id"])
        candidates.append(
            TrackCandidate(
                track_id=tid,
                start_frame=items_sorted[0]["frame_id"],
                end_frame=items_sorted[-1]["frame_id"],
                score=score,
                items=items_sorted,
            )
        )

    candidates = _cluster_candidates(candidates, fps)

    if not candidates:
        raise RuntimeError("No pitch candidates found.")

    log.info("Pitch candidates: %d", len(candidates))
    for c in candidates:
        log.info("  track=%d start=%d end=%d score=%.1f",
                 c.track_id, c.start_frame, c.end_frame, c.score)

    windows = _make_clip_windows(
        video_path=input_video,
        candidates=candidates,
        fps=fps,
        frame_count=frame_count,
        rotate_code=rotate_code,
        width=width,
        height=height,
    )

    stem = Path(input_video).stem
    for w in windows:
        out_path = os.path.join(output_dir, f"{stem}_pitch_{w.pitch_index:02d}.mp4")
        log.info(
            "Trim pitch %02d: start=%d release=%s first_ball=%d catch=%d end=%d -> %s",
            w.pitch_index,
            w.start_frame,
            str(w.release_frame),
            w.first_ball_frame,
            w.catch_frame,
            w.end_frame,
            out_path,
        )
        _trim_clip(
            input_video=input_video,
            output_video=out_path,
            fps=fps,
            start_frame=w.start_frame,
            end_frame=w.end_frame,
        )

    return windows


def main() -> None:
    parser = argparse.ArgumentParser(description="Split one long pitching video into one clip per pitch.")
    parser.add_argument("--input", required=True, help="Input video path")
    parser.add_argument("--weights", required=True, help="YOLO weights path")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--conf", type=float, default=0.05)
    parser.add_argument("--yolo-stride", type=int, default=1, help="Run YOLO every N frames")
    parser.add_argument("--pose-stride", type=int, default=3, help="Run pose every N frames")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    windows = split_pitches(
        input_video=args.input,
        weights_path=args.weights,
        output_dir=args.output_dir,
        conf=args.conf,
        yolo_stride=args.yolo_stride,
        pose_stride=args.pose_stride,
    )

    print("\n=== DONE ===")
    for w in windows:
        print(
            f"pitch {w.pitch_index:02d}: "
            f"start={w.start_frame}, release={w.release_frame}, "
            f"first_ball={w.first_ball_frame}, catch={w.catch_frame}, end={w.end_frame}"
        )


if __name__ == "__main__":
    main()