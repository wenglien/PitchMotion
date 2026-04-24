from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import cv2
import numpy as np
from typing import Optional
from image_registration import cross_correlation_shifts
from src.utils import draw_ball_curve, fill_lost_tracking, kmh_to_mph
from src.utils import FrameInfo

log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────────────────────
# Colour palette — ALL values are RGB triplets.
#
# The overlay loop works on an RGB-ordered numpy frame (see the _bgr[..., ::-1]
# flip in the read path).  Earlier code mixed BGR and RGB conventions, which
# caused "red BALL" to render as blue.  New rule: every draw function in this
# file takes RGB (R, G, B).  The only place we convert to BGR is the final
# cvtColor before writing to the encoder.
# ────────────────────────────────────────────────────────────────────────────
RGB_WHITE    = (255, 255, 255)
RGB_BLACK    = (0, 0, 0)
RGB_TEXT     = (235, 240, 245)
RGB_MUTED    = (170, 180, 195)
RGB_ZONE     = (255, 216, 75)    # warm yellow — K-Zone box
RGB_ZONE_DIM = (180, 152, 50)    # dashed grid inside the zone
RGB_STRIKE   = (74, 222, 128)    # green
RGB_BALL     = (248, 113, 113)   # red/coral — out of zone
RGB_SPEED    = (125, 211, 252)   # sky blue — primary speed
RGB_PITCH    = (196, 181, 253)   # lavender — pitch type
RGB_SPIN     = (110, 231, 183)   # mint — spin RPM
RGB_MAX      = (253, 224, 71)    # amber — max speed
RGB_PANEL_BG = (15, 18, 26)      # near-black panel background
RGB_RELEASE  = (125, 211, 252)   # sky blue
RGB_CATCH    = (253, 186, 116)   # soft orange


def _put_text(img, text, org, *, font_scale, color, thickness, outline=True):
    """Text with an outline so it stays legible over busy video frames."""
    if outline:
        cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                    RGB_BLACK, thickness + max(3, int(thickness * 1.6)), cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                color, thickness, cv2.LINE_AA)


def _blend_panel(frame, x1, y1, x2, y2, *, alpha=0.62, border_color=None, border_thick=0):
    """Dark rounded-looking rectangle (cv2 has no true rounded rect)."""
    overlay = frame.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), RGB_PANEL_BG, -1)
    frame = cv2.addWeighted(overlay, alpha, frame, 1.0 - alpha, 0)
    if border_color is not None and border_thick > 0:
        cv2.rectangle(frame, (x1, y1), (x2, y2), border_color, border_thick, cv2.LINE_AA)
    return frame


def _draw_dashed_line(img, p1, p2, color, thickness=1, dash=10, gap=6):
    """Draw a dashed line between p1 and p2 on img (in-place)."""
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    length = max(1.0, float(np.hypot(dx, dy)))
    step = dash + gap
    n = int(length // step) + 1
    ux, uy = dx / length, dy / length
    for i in range(n):
        s = i * step
        e = min(length, s + dash)
        sx, sy = int(x1 + ux * s), int(y1 + uy * s)
        ex, ey = int(x1 + ux * e), int(y1 + uy * e)
        cv2.line(img, (sx, sy), (ex, ey), color, thickness, cv2.LINE_AA)


def _zone_3d_corners(width, height, plate_zone):
    """Compute the 8 corners of the 3D K-Zone volume in image space.

    The stored plate_zone is the FRONT face (the catcher-side plane where
    the ball actually crosses).  The BACK face (pitcher-side) is projected
    with a simple oblique transform: offset toward a vanishing point that
    sits above-and-toward-centre (camera is behind/above the catcher).

    Returns (front, back) each as [(x, y), ...] in order TL, TR, BR, BL.
    """
    x1 = int(plate_zone['x_min'] * width)
    y1 = int(plate_zone['y_min'] * height)
    x2 = int(plate_zone['x_max'] * width)
    y2 = int(plate_zone['y_max'] * height)
    zw = x2 - x1
    zh = y2 - y1

    # Vanishing point: horizontally centred on the zone, vertically near
    # the upper third of the frame.  "Depth factor" controls how strongly
    # the back face is pulled toward the VP — larger = deeper box.
    vx = (x1 + x2) / 2
    vy = height * 0.28
    depth = 0.28                       # 0 = flat, 1 = collapses to VP

    def _toward_vp(px, py):
        return int(px + (vx - px) * depth), int(py + (vy - py) * depth)

    front = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    back = [_toward_vp(px, py) for (px, py) in front]

    # Enforce a minimum upward offset so the box reads as 3D even when
    # the zone is already high in the frame.
    min_lift = int(zh * 0.25)
    lift = max(0, min_lift - (front[0][1] - back[0][1]))
    if lift > 0:
        back = [(bx, by - lift) for (bx, by) in back]

    return front, back


def _draw_strike_zone_box(
    frame: np.ndarray,
    width: int,
    height: int,
    plate_zone: dict,
    *,
    alpha: float = 0.75,
    thickness: Optional[int] = None,
) -> np.ndarray:
    """Draw a flat 2D strike-zone plane on the analysed video."""
    fx1 = int(plate_zone['x_min'] * width)
    fy1 = int(plate_zone['y_min'] * height)
    fx2 = int(plate_zone['x_max'] * width)
    fy2 = int(plate_zone['y_max'] * height)
    zw = fx2 - fx1
    zh = fy2 - fy1
    if zw < 4 or zh < 4:
        return frame

    if thickness is None:
        thickness = max(3, int(min(width, height) / 420))
    thin = max(1, thickness - 1)

    overlay = frame.copy()

    # ── Flat strike-zone plane tint ─────────────────────────────────────
    tint = frame.copy()
    cv2.rectangle(tint, (fx1, fy1), (fx2, fy2), RGB_ZONE, -1)
    overlay = cv2.addWeighted(tint, 0.10, overlay, 0.90, 0)

    # ── Outer border + 3×3 grid ────────────────────────────────────────
    cv2.rectangle(overlay, (fx1, fy1), (fx2, fy2), RGB_ZONE, thickness, cv2.LINE_AA)
    for i in (1, 2):
        xv = fx1 + zw * i // 3
        yv = fy1 + zh * i // 3
        _draw_dashed_line(overlay, (xv, fy1), (xv, fy2), RGB_ZONE_DIM, thin, dash=10, gap=8)
        _draw_dashed_line(overlay, (fx1, yv), (fx2, yv), RGB_ZONE_DIM, thin, dash=10, gap=8)

    # ── Front-face corner L-brackets (white accent) ─────────────────────
    bracket_len = max(12, min(zw, zh) // 6)
    bracket_thick = thickness + 1
    for (cx, cy, sx, sy) in (
        (fx1, fy1,  1,  1),
        (fx2, fy1, -1,  1),
        (fx1, fy2,  1, -1),
        (fx2, fy2, -1, -1),
    ):
        cv2.line(overlay, (cx, cy), (cx + sx * bracket_len, cy), RGB_WHITE, bracket_thick, cv2.LINE_AA)
        cv2.line(overlay, (cx, cy), (cx, cy + sy * bracket_len), RGB_WHITE, bracket_thick, cv2.LINE_AA)

    return cv2.addWeighted(overlay, alpha, frame, 1.0 - alpha, 0)


def _compute_catch_geometry(width, height, plate_zone, plate_x_norm, plate_y_norm):
    """Return (bx, by, nx, ny, inside, dist_cm) for the catch location."""
    x1 = int(plate_zone['x_min'] * width)
    y1 = int(plate_zone['y_min'] * height)
    x2 = int(plate_zone['x_max'] * width)
    y2 = int(plate_zone['y_max'] * height)
    zw_px = max(1, x2 - x1)

    bx = int(plate_x_norm * width)
    by = int(plate_y_norm * height)
    nx = min(max(bx, x1), x2)
    ny = min(max(by, y1), y2)
    inside = (bx == nx) and (by == ny)

    cm_per_px = 43.2 / float(zw_px)   # MLB plate width
    dist_cm = float(np.hypot(bx - nx, by - ny)) * cm_per_px
    return bx, by, nx, ny, inside, dist_cm


def _draw_catch_and_distance(
    frame: np.ndarray,
    width: int,
    height: int,
    plate_zone: dict,
    plate_x_norm: float,
    plate_y_norm: float,
    *,
    alpha: float = 1.0,
    ui_scale: float = 1.0,
) -> np.ndarray:
    """Mark the catch point and, if outside the zone, draw a dashed line from
    the ball to the nearest zone edge with a cm label.
    """
    if alpha <= 0:
        return frame

    bx, by, nx, ny, inside, dist_cm = _compute_catch_geometry(
        width, height, plate_zone, plate_x_norm, plate_y_norm,
    )
    overlay = frame.copy()
    ring_color = RGB_STRIKE if inside else RGB_BALL
    dist_px = float(np.hypot(bx - nx, by - ny))

    # Connector line + distance label when the ball is outside the zone
    if not inside and dist_px > 2:
        _draw_dashed_line(overlay, (bx, by), (nx, ny), RGB_BALL,
                          max(2, int(2 * ui_scale)), dash=8, gap=6)
        # Edge-point tick
        cv2.circle(overlay, (nx, ny), max(4, int(5 * ui_scale)), RGB_BALL, -1, cv2.LINE_AA)
        cv2.circle(overlay, (nx, ny), max(4, int(5 * ui_scale)), RGB_WHITE,
                   max(1, int(1 * ui_scale)), cv2.LINE_AA)

        # Distance label, centred on the connector with an offset so it
        # doesn't overlap the line
        mx, my = (bx + nx) // 2, (by + ny) // 2
        txt = f"{dist_cm:.1f} cm"
        fs = 0.7 * ui_scale
        (tw, th), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
        ox = 14 if bx >= nx else -14 - tw
        oy = -12 if by >= ny else th + 14
        _put_text(overlay, txt, (mx + ox, my + oy),
                  font_scale=fs, color=RGB_BALL, thickness=max(2, int(2 * ui_scale)))

    # Ball marker — white fill with coloured ring
    r = max(7, int(10 * ui_scale))
    cv2.circle(overlay, (bx, by), r + 2, RGB_WHITE, -1, cv2.LINE_AA)
    cv2.circle(overlay, (bx, by), r + 2, ring_color, max(2, int(2 * ui_scale)), cv2.LINE_AA)
    cv2.circle(overlay, (bx, by), max(2, int(r * 0.35)), ring_color, -1, cv2.LINE_AA)

    return cv2.addWeighted(overlay, alpha, frame, 1.0 - alpha, 0)


def _draw_verdict_badge(
    frame: np.ndarray,
    width: int,
    height: int,
    is_strike: Optional[bool],
    dist_cm: Optional[float],
    *,
    alpha: float,
    ui_scale: float,
) -> np.ndarray:
    """Top-right badge: STRIKE (green) or BALL (red) + distance sub-line."""
    if alpha <= 0 or is_strike is None:
        return frame

    label = "STRIKE" if is_strike else "BALL"
    color = RGB_STRIKE if is_strike else RGB_BALL
    sub = (
        "In the zone" if is_strike
        else (f"{dist_cm:.1f} cm outside" if dist_cm is not None else "Outside zone")
    )

    pad = int(16 * ui_scale)
    label_fs = 1.6 * ui_scale
    sub_fs = 0.72 * ui_scale
    label_th = max(3, int(3 * ui_scale))
    sub_th = max(2, int(2 * ui_scale))

    (lw, lh), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, label_fs, label_th)
    (sw, sh), _ = cv2.getTextSize(sub,   cv2.FONT_HERSHEY_SIMPLEX, sub_fs, sub_th)
    box_w = max(lw, sw) + pad * 2
    box_h = lh + sh + int(18 * ui_scale) + pad * 2

    margin = int(20 * ui_scale)
    x2 = width - margin
    y1 = margin
    x1 = x2 - box_w
    y2 = y1 + box_h

    layer = _blend_panel(frame, x1, y1, x2, y2,
                         alpha=0.70, border_color=color,
                         border_thick=max(2, int(2 * ui_scale)))

    _put_text(layer, label, (x1 + pad, y1 + pad + lh),
              font_scale=label_fs, color=color, thickness=label_th)
    _put_text(layer, sub, (x1 + pad, y1 + pad + lh + int(14 * ui_scale) + sh),
              font_scale=sub_fs, color=RGB_MUTED, thickness=sub_th)

    return cv2.addWeighted(layer, alpha, frame, 1.0 - alpha, 0)


def _draw_speed_panel(
    frame: np.ndarray,
    width: int,
    height: int,
    speed_info: dict,
    *,
    alpha: float,
    ui_scale: float,
) -> np.ndarray:
    """Top-left primary info panel: speed (big) + secondary stats (small)."""
    if alpha <= 0:
        return frame

    primary_kmh = speed_info.get('release_speed_kmh') or speed_info.get('initial_speed_kmh')
    if not primary_kmh:
        return frame

    primary_mph = kmh_to_mph(primary_kmh)
    big_line = f"{primary_mph:.1f}"
    big_unit = "mph"
    sub_line = f"{primary_kmh:.1f} km/h"

    extras = []

    max_kmh = speed_info.get('max_speed_kmh')
    if max_kmh:
        extras.append(("Max", f"{kmh_to_mph(max_kmh):.1f} mph", RGB_MAX))

    pitch_type = speed_info.get('pitch_type')
    pitch_conf = speed_info.get('pitch_confidence')
    if pitch_type and pitch_type not in ('Unknown', ''):
        val = pitch_type + (f"  {pitch_conf:.0%}" if pitch_conf else "")
        extras.append(("Pitch", val, RGB_PITCH))

    spin_rpm = speed_info.get('spin_rpm')
    if spin_rpm is not None:
        prefix = "~" if speed_info.get('spin_rpm_estimated') else ""
        extras.append(("Spin", f"{prefix}{spin_rpm:.0f} rpm", RGB_SPIN))

    dist_m = speed_info.get('total_distance_m') or speed_info.get('effective_distance_m')
    if dist_m:
        extras.append(("Dist", f"{dist_m:.1f} m", RGB_MUTED))

    pad = int(18 * ui_scale)
    big_fs = 2.8 * ui_scale
    big_th = max(4, int(4 * ui_scale))
    unit_fs = 0.9 * ui_scale
    unit_th = max(2, int(2 * ui_scale))
    sub_fs = 0.68 * ui_scale
    sub_th = max(2, int(2 * ui_scale))
    row_fs = 0.7 * ui_scale
    row_th = max(2, int(2 * ui_scale))
    row_gap = int(36 * ui_scale)

    (bw, bh), _ = cv2.getTextSize(big_line, cv2.FONT_HERSHEY_SIMPLEX, big_fs, big_th)
    (uw, uh), _ = cv2.getTextSize(big_unit, cv2.FONT_HERSHEY_SIMPLEX, unit_fs, unit_th)
    (sw, sh), _ = cv2.getTextSize(sub_line, cv2.FONT_HERSHEY_SIMPLEX, sub_fs, sub_th)

    # Measure extras column widths
    extras_width = 0
    for lbl, val, _ in extras:
        (w1, _), _ = cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, row_fs, row_th)
        (w2, _), _ = cv2.getTextSize(val, cv2.FONT_HERSHEY_SIMPLEX, row_fs, row_th)
        extras_width = max(extras_width, w1 + int(16 * ui_scale) + w2)

    header_w = bw + int(8 * ui_scale) + uw
    content_w = max(header_w, sw, extras_width)
    box_w = content_w + pad * 2
    box_h = pad + bh + int(6 * ui_scale) + sh + (int(10 * ui_scale) + row_gap * len(extras)) + pad

    margin = int(20 * ui_scale)
    x1 = margin
    y1 = margin
    x2 = x1 + box_w
    y2 = y1 + box_h

    layer = _blend_panel(frame, x1, y1, x2, y2,
                         alpha=0.70, border_color=RGB_SPEED,
                         border_thick=max(2, int(2 * ui_scale)))

    # Big speed number + unit
    by = y1 + pad + bh
    _put_text(layer, big_line, (x1 + pad, by),
              font_scale=big_fs, color=RGB_SPEED, thickness=big_th)
    _put_text(layer, big_unit, (x1 + pad + bw + int(8 * ui_scale), by - int(4 * ui_scale)),
              font_scale=unit_fs, color=RGB_MUTED, thickness=unit_th)

    # km/h sub-line
    sy = by + int(6 * ui_scale) + sh
    _put_text(layer, sub_line, (x1 + pad, sy),
              font_scale=sub_fs, color=RGB_MUTED, thickness=sub_th)

    # Extras rows: "Label   Value"
    ry = sy + int(14 * ui_scale)
    for lbl, val, vcolor in extras:
        ry += row_gap
        _put_text(layer, lbl, (x1 + pad, ry),
                  font_scale=row_fs, color=RGB_MUTED, thickness=row_th)
        (lw1, _), _ = cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, row_fs, row_th)
        _put_text(layer, val, (x1 + pad + lw1 + int(16 * ui_scale), ry),
                  font_scale=row_fs, color=vcolor, thickness=row_th)

    return cv2.addWeighted(layer, alpha, frame, 1.0 - alpha, 0)


def generate_overlay(
    video_frames: list[list[FrameInfo]],
    width: int,
    height: int,
    fps: int,
    outputPath: str,
    show_preview: bool = True,
    speed_info: Optional[dict] = None,
    output_scale: float = 0.5,   # 輸出解析度縮放比例：0.5 → 1080p（原始 4K→2K），大幅降低編碼時間
) -> None:
    import mediapipe as mp
    mp_pose    = mp.solutions.pose
    mp_drawing = mp.solutions.drawing_utils

    # ── 計算輸出尺寸 ────────────────────────────────────────────────────────
    # output_scale < 1.0 時縮小輸出，加快 VideoWriter 編碼速度
    # 保持偶數尺寸（H.264 編碼器要求）
    if output_scale != 1.0 and output_scale > 0.0:
        out_width  = max(2, int(width  * output_scale) // 2 * 2)
        out_height = max(2, int(height * output_scale) // 2 * 2)
        log.info(
            "Overlay output scale=%.2f: %dx%d → %dx%d",
            output_scale, width, height, out_width, out_height,
        )
    else:
        out_width, out_height = width, height

    log.info("Saving overlay result to %s", outputPath)

    # ── 檢查原始影片是否有音訊 ──────────────────────────────────────────
    _source_video_path = speed_info.get('_video_path') if speed_info else None
    _has_audio = False
    if _source_video_path:
        try:
            _probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "a",
                 "-show_entries", "stream=codec_type",
                 "-of", "default=noprint_wrappers=1:nokey=1",
                 _source_video_path],
                capture_output=True, text=True, timeout=10,
            )
            _has_audio = "audio" in _probe.stdout
        except Exception as e:
            log.debug("ffprobe audio check failed: %s", e)

    # ffmpeg pipe 模式：直接輸出到 outputPath，不需要暫存檔
    # fallback cv2.VideoWriter 模式：有音訊時需要暫存檔（mux 在後）
    _tmp_video_path = None
    _write_path = outputPath   # ffmpeg pipe 直接寫到最終路徑

    # ── 用 ffmpeg pipe 直接編碼（比 cv2.VideoWriter 快 3-5x，支援硬體加速） ──
    # 同時若有音訊，直接在同一個 ffmpeg 命令完成 mux，省掉額外步驟。
    _ffmpeg_cmd: list[str] = [
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{out_width}x{out_height}",
        "-r", str(fps),
        "-i", "pipe:0",          # stdin 接收原始 BGR 幀
    ]
    if _has_audio and _source_video_path:
        _ffmpeg_cmd += ["-i", _source_video_path,
                        "-map", "0:v:0",
                        "-map", "1:a:0",
                        "-c:a", "aac", "-b:a", "128k",
                        "-shortest"]
    _ffmpeg_cmd += [
        "-vcodec", "libx264",
        "-preset", "ultrafast",   # 最快編碼（檔案稍大，但速度提升 3-5x）
        "-crf", "23",             # 品質設定（0=無損, 51=最差；23 是平衡值）
        "-pix_fmt", "yuv420p",    # 確保瀏覽器/iOS 相容
        outputPath,
    ]

    try:
        out_proc = subprocess.Popen(
            _ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log.info("Using ffmpeg pipe encoder (preset=ultrafast, audio_mux=%s)", _has_audio)
    except Exception as _ffe:
        log.warning("ffmpeg pipe failed (%s), falling back to cv2.VideoWriter", _ffe)
        out_proc = None

    # fallback：cv2.VideoWriter（僅在 ffmpeg 不可用時使用）
    out = None
    if out_proc is None:
        # 有音訊時需要先寫到暫存檔，最後再 mux
        if _has_audio:
            _tmp_fd, _tmp_video_path = tempfile.mkstemp(suffix=".mp4")
            os.close(_tmp_fd)
            _write_path = _tmp_video_path
            log.info("Audio detected (fallback mode) – writing to temp: %s", _tmp_video_path)
        codecs_to_try = [
            ("avc1", cv2.VideoWriter_fourcc(*"avc1")),
            ("mp4v", cv2.VideoWriter_fourcc(*"mp4v")),
        ]
        for name, codec in codecs_to_try:
            try:
                out = cv2.VideoWriter(_write_path, codec, fps, (out_width, out_height))
                if out.isOpened():
                    log.info("Fallback codec: %s", name)
                    break
            except Exception:
                if out:
                    out.release()
                out = None
        if out is None or not out.isOpened():
            raise RuntimeError(f"無法建立輸出影片檔案：{outputPath}")

    # ── 從 speed_info 取回 video_path 與旋轉碼，直接讀原始幀 ──────────
    # （Phase 2 不再讀影片，FrameInfo.frame 為 None，這裡統一讀一次）
    _video_path       = speed_info.get('_video_path')      if speed_info else None
    _rotate_code      = speed_info.get('_rotate_code')     if speed_info else None
    # _cv2_pre_rotated=True 代表 Phase 1 的 cv2 已自動套用旋轉 metadata，
    # 此時 generate_overlay 新開的 VideoCapture 也需要檢查它是否也自動旋轉；
    # 若不是（幀尺寸仍為 raw 橫向），則要手動補旋轉。
    _cv2_pre_rotated  = speed_info.get('_cv2_pre_rotated', False) if speed_info else False
    _pose_by_frame: dict[int, object] = {}           # frame_id → pose_landmarks (or None)
    if speed_info and speed_info.get('_raw_detections_pose'):
        for _rd in speed_info['_raw_detections_pose']:
            _pose_by_frame[_rd['frame_id']] = _rd.get('pose_landmarks')

    # ── 用 ffmpeg pipe 高速解碼原始影片（比 cv2.VideoCapture 快 4-5x）────────
    # ffmpeg 同時處理：H.264 解碼、旋轉（依 metadata）、縮放到輸出解析度
    # 輸出格式：raw BGR24 pipe（直接送進 numpy array，無需 cvtColor）
    _overlay_cap = None   # fallback：若 ffmpeg 不可用，仍保留 cv2.VideoCapture
    _overlay_ffmpeg_proc = None
    _overlay_frame_size = out_width * out_height * 3   # BGR24 bytes per frame

    if _video_path:
        _abs_path = os.path.abspath(_video_path)
        if not os.path.isfile(_abs_path):
            log.warning("generate_overlay: source video not found %s", _abs_path)
        else:
            # 建立 ffmpeg 旋轉+縮放 filter
            # Phase 1 cv2 auto-rotate 行為：若 _cv2_pre_rotated=True，代表 Phase 1 讀到的幀
            # 已經是顯示方向（width × height）。ffmpeg 同樣會依 metadata 自動旋轉
            # （ffmpeg ≥5.0 預設 autorotate=1），所以直接 scale 到輸出尺寸即可。
            _vf_filters = f"scale={out_width}:{out_height}"
            _decode_cmd = [
                "ffmpeg", "-i", _abs_path,
                "-vf", _vf_filters,
                "-vcodec", "rawvideo",
                "-pix_fmt", "bgr24",
                "-f", "rawvideo",
                "pipe:1",
            ]
            try:
                _overlay_ffmpeg_proc = subprocess.Popen(
                    _decode_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    bufsize=_overlay_frame_size * 4,
                )
                log.info(
                    "generate_overlay: ffmpeg decode pipe opened (%dx%d BGR24, filter=%s)",
                    out_width, out_height, _vf_filters,
                )
            except Exception as _ffe2:
                log.warning("generate_overlay: ffmpeg decode pipe failed (%s), fallback to cv2", _ffe2)
                _overlay_ffmpeg_proc = None

        # fallback：ffmpeg 不可用時用 cv2.VideoCapture
        if _overlay_ffmpeg_proc is None and os.path.isfile(_abs_path):
            _overlay_needs_rotate: Optional[int] = None
            _overlay_cap = cv2.VideoCapture(_abs_path)
            if not _overlay_cap.isOpened():
                log.warning("generate_overlay: cannot open source video %s, frames will be black", _abs_path)
                _overlay_cap = None
            else:
                log.info("generate_overlay: opened source video %s (cv2 fallback)", _abs_path)
                if _rotate_code is not None:
                    _ov_ok, _ov_probe = _overlay_cap.read()
                    if _ov_ok:
                        _ov_h, _ov_w = _ov_probe.shape[:2]
                        if _ov_w != width or _ov_h != height:
                            _overlay_needs_rotate = _rotate_code
                        _overlay_cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    frame_lists = sorted(video_frames, key=len, reverse=True)
    balls_in_curves = [[] for i in range(len(frame_lists))]
    shifts = {}

    is_single_video = len(frame_lists) == 1

    # ── 淡入時序設定 ──────────────────────────────────────────────
    # 捕手接球後才淡入顯示 Strike Zone 圖、STRIKE/BALL 判決、速度資訊
    _total_frames = len(frame_lists[0]) if frame_lists else 0
    _raw_catch_idx: Optional[int] = (
        speed_info.get('catch_frame_idx') if speed_info else None
    )
    # clamp：若 catch_frame_idx 超出影片範圍，就壓到最後 10% 開始顯示，
    # 確保即使偵測誤差也一定能看到結果。
    if _raw_catch_idx is not None and _total_frames > 0:
        _max_allowed = max(0, _total_frames - 1)
        if _raw_catch_idx > _max_allowed:
            _clamped = int(_total_frames * 0.80)  # 至少從 80% 處開始顯示
            log.warning(
                "catch_frame_idx=%d exceeds total frames=%d, clamping to %d",
                _raw_catch_idx, _total_frames, _clamped,
            )
            _raw_catch_idx = _clamped
    _catch_frame_idx: Optional[int] = _raw_catch_idx

    # 淡入持續幀數：約 0.4s（依 fps 縮放，不超過 fps）
    _FADE_IN_FRAMES = max(8, min(fps, int(fps * 0.4)))

    log.info(
        "Overlay fade-in: catch_frame_idx=%s, total_frames=%d, fade_frames=%d",
        _catch_frame_idx, _total_frames, _FADE_IN_FRAMES,
    )

    # 強制顯示點：若影片超過此幀都還沒顯示，直接打開（保底防止結果永不出現）
    _force_show_idx: int = (
        int(_total_frames * 0.75) if _total_frames > 0 else 0
    )

    def _reveal_alpha(frame_idx: int) -> float:
        """0.0（接球前）→ 線性淡入 → 1.0（接球後 _FADE_IN_FRAMES 幀完全顯示）"""
        if _catch_frame_idx is None:
            return 1.0   # 沒有接球幀資訊 → 全程顯示（舊行為）
        # 強制保底：影片後 25% 一定顯示，避免 catch_frame_idx 誤判導致永不出現
        effective_catch = min(_catch_frame_idx, _force_show_idx)
        if frame_idx < effective_catch:
            return 0.0
        elapsed = frame_idx - effective_catch
        return float(min(1.0, elapsed / max(1, _FADE_IN_FRAMES)))

    # Take the longest frames as background
    _BLACK_FRAME = np.zeros((out_height, out_width, 3), dtype=np.uint8)
    # 座標縮放比例（FrameInfo 座標是 display 解析度，需縮放到輸出解析度）
    _coord_scale_x = out_width  / width
    _coord_scale_y = out_height / height
    for idx, base_frame in enumerate(frame_lists[0]):
        # ── 讀原始幀（優先 ffmpeg pipe，次選 cv2.VideoCapture，否則黑幀）────
        if _overlay_ffmpeg_proc is not None:
            # ffmpeg pipe：輸出已是 out_width×out_height BGR24（旋轉+縮放一步完成）
            _raw = _overlay_ffmpeg_proc.stdout.read(_overlay_frame_size)
            if len(_raw) == _overlay_frame_size:
                _bgr = np.frombuffer(_raw, dtype=np.uint8).reshape((out_height, out_width, 3)).copy()
                _rgb = _bgr[:, :, ::-1]  # BGR→RGB view（需 .copy() 後才可寫）
            else:
                _rgb = _BLACK_FRAME.copy()
        elif _overlay_cap is not None:
            ret_ov, _bgr = _overlay_cap.read()
            if ret_ov:
                if _overlay_needs_rotate is not None:
                    _bgr = cv2.rotate(_bgr, _overlay_needs_rotate)
                if out_width != _bgr.shape[1] or out_height != _bgr.shape[0]:
                    _bgr = cv2.resize(_bgr, (out_width, out_height), interpolation=cv2.INTER_AREA)
                _rgb = cv2.cvtColor(_bgr, cv2.COLOR_BGR2RGB)
            else:
                _rgb = _BLACK_FRAME.copy()
        else:
            _rgb = _BLACK_FRAME.copy()


        # Overlay frames
        if is_single_video:
            background_frame = _rgb
        else:
            background_frame = _rgb
            for list_idx, frameList in enumerate(frame_lists[1:]):
                if idx < len(frameList):
                    overlay_frame = frameList[idx]
                else:
                    overlay_frame = frameList[len(frameList) - 1]

                alpha = 1.0 / (list_idx + 2)
                beta = 1.0 - alpha
                corrected_frame = image_registration(
                    background_frame, overlay_frame, shifts, list_idx, width, height
                )
                background_frame = cv2.addWeighted(
                    corrected_frame, alpha, background_frame, beta, 0
                )

                # Prepare balls to draw (scale coordinates to output resolution)
                if overlay_frame.ball_in_frame:
                    balls_in_curves[list_idx + 1].append(
                        [
                            overlay_frame.ball[0] * _coord_scale_x,
                            overlay_frame.ball[1] * _coord_scale_y,
                            overlay_frame.ball_color,
                        ]
                    )

        if base_frame.ball_in_frame:
            balls_in_curves[0].append(
                [base_frame.ball[0] * _coord_scale_x, base_frame.ball[1] * _coord_scale_y, base_frame.ball_color]
            )

        if not is_single_video:
            # Emphasize base frame
            base_frame_weight = 0.55
            background_frame = cv2.addWeighted(
                _rgb,
                base_frame_weight,
                background_frame,
                1 - base_frame_weight,
                0,
            )

        # Draw transparent curve and non-transparent balls
        for trajectory in balls_in_curves:
            # Draw the last small tail, make the trajectory length and ball speed fit, so that the trajectory will not appear suddenly
            background_frame = draw_ball_curve(background_frame, trajectory, max_points=25)

        # 計算本幀的淡入 alpha（捕手接球前=0，之後線性淡入到1）
        _alpha = _reveal_alpha(idx)

        # UI scale: short-edge / 1080 → 1.0 on both 1080p orientations
        _ui_scale = min(out_width, out_height) / 1080.0
        _is_catcher_pov = bool(speed_info.get('is_catcher_pov', False)) if speed_info else False
        _plate_zone = speed_info.get('plate_zone') if speed_info else None

        # ── Release / Catch pin-point markers on the video itself ─────────
        # Drawn BELOW the K-Zone so the zone reads cleanly over them.
        def _pin(frame, x, y, color, label):
            sc = _ui_scale
            rr = max(5, int(6 * sc))
            cv2.circle(frame, (x, y), rr + 2, RGB_WHITE, -1, cv2.LINE_AA)
            cv2.circle(frame, (x, y), rr + 2, color, max(2, int(2 * sc)), cv2.LINE_AA)
            cv2.circle(frame, (x, y), max(2, int(rr * 0.4)), color, -1, cv2.LINE_AA)
            _put_text(frame, label, (x + int(12 * sc), y - int(10 * sc)),
                      font_scale=0.7 * sc, color=color,
                      thickness=max(2, int(2 * sc)))
            return frame

        if _alpha > 0 and speed_info and 'release_point' in speed_info and not _is_catcher_pov:
            rx = int(speed_info['release_point'][0] * _coord_scale_x)
            ry = int(speed_info['release_point'][1] * _coord_scale_y)
            if 0 <= rx < out_width and 0 <= ry < out_height:
                layer = background_frame.copy()
                _pin(layer, rx, ry, RGB_RELEASE, "Release")
                background_frame = cv2.addWeighted(layer, _alpha, background_frame, 1.0 - _alpha, 0)

        if _alpha > 0 and speed_info and 'catch_point' in speed_info:
            cpx = int(speed_info['catch_point'][0] * _coord_scale_x)
            cpy = int(speed_info['catch_point'][1] * _coord_scale_y)
            if 0 <= cpx < out_width and 0 <= cpy < out_height:
                layer = background_frame.copy()
                _pin(layer, cpx, cpy, RGB_CATCH, "Glove" if _is_catcher_pov else "Catch")
                background_frame = cv2.addWeighted(layer, _alpha, background_frame, 1.0 - _alpha, 0)

        # ── K-Zone box (always visible, brighter once the catch lands) ────
        if _plate_zone:
            _zone_alpha = 0.55 + 0.30 * _alpha
            background_frame = _draw_strike_zone_box(
                background_frame, out_width, out_height, _plate_zone,
                alpha=_zone_alpha,
            )

            # Catch marker + distance line (only after catch is detected)
            _px = speed_info.get('plate_x_norm') if speed_info else None
            _py = speed_info.get('plate_y_norm') if speed_info else None
            if _alpha > 0 and _px is not None and _py is not None:
                background_frame = _draw_catch_and_distance(
                    background_frame, out_width, out_height,
                    _plate_zone, _px, _py,
                    alpha=_alpha, ui_scale=_ui_scale,
                )

        # ── Top-left speed / stats panel ─────────────────────────────────
        if speed_info:
            background_frame = _draw_speed_panel(
                background_frame, out_width, out_height, speed_info,
                alpha=_alpha, ui_scale=_ui_scale,
            )

        # ── Top-right verdict badge ──────────────────────────────────────
        if speed_info and speed_info.get('is_strike') is not None:
            _vdist_cm = None
            if _plate_zone and speed_info.get('plate_x_norm') is not None \
                    and speed_info.get('plate_y_norm') is not None:
                *_rest, _vdist_cm = _compute_catch_geometry(
                    out_width, out_height, _plate_zone,
                    speed_info['plate_x_norm'], speed_info['plate_y_norm'],
                )
            background_frame = _draw_verdict_badge(
                background_frame, out_width, out_height,
                bool(speed_info.get('is_strike')),
                _vdist_cm,
                alpha=_alpha, ui_scale=_ui_scale,
            )

        result_frame = cv2.cvtColor(background_frame, cv2.COLOR_RGB2BGR)
        # 縮放已在讀幀後立即完成，此處 result_frame 已是 out_width×out_height，無需再縮放

        if show_preview:
            try:
                cv2.imshow("result_frame", result_frame)
                if cv2.waitKey(60) & 0xFF == ord("q"):
                    break
            except Exception as e:
                log.debug("Preview window unavailable: %s", e)

        # 寫幀：優先用 ffmpeg pipe，fallback 用 cv2.VideoWriter
        try:
            if out_proc is not None and out_proc.stdin:
                out_proc.stdin.write(result_frame.tobytes())
            elif out is not None:
                out.write(result_frame)
        except BrokenPipeError:
            # ffmpeg 用 -shortest 時，音訊結束後會關閉 stdin；之後的幀是靜音段，
            # 直接標記 pipe 已結束，不中斷迴圈（後續幀不再嘗試寫入）
            log.debug("ffmpeg pipe closed (audio ended with -shortest), stopping video write")
            out_proc = None
        except Exception as e:
            log.error("Error writing video frame: %s", e)
            break

    # ── 關閉資源 ──────────────────────────────────────────────────────
    if _overlay_ffmpeg_proc is not None:
        try:
            _overlay_ffmpeg_proc.stdout.close()
            _overlay_ffmpeg_proc.kill()
            _overlay_ffmpeg_proc.wait(timeout=5)
        except Exception:
            pass

    if _overlay_cap is not None:
        try:
            _overlay_cap.release()
        except Exception:
            pass

    if out_proc is not None:
        try:
            if out_proc.stdin:
                out_proc.stdin.close()
            out_proc.wait(timeout=60)
            log.info("ffmpeg pipe encoder finished (rc=%d)", out_proc.returncode)
        except Exception as e:
            log.warning("ffmpeg pipe close error: %s", e)
            try:
                out_proc.kill()
            except Exception:
                pass

    if out is not None:
        try:
            out.release()
        except Exception as e:
            log.warning("Error releasing video writer: %s", e)

    try:
        cv2.destroyAllWindows()
    except Exception:
        pass

    # ── ffmpeg pipe 模式已在命令中直接 mux 音訊，無需額外處理 ──────────────
    # fallback cv2.VideoWriter 模式：仍需舊的暫存檔 mux 流程
    if out_proc is None and _has_audio and _tmp_video_path and _source_video_path:
        try:
            log.info("Muxing audio from %s into %s", _source_video_path, outputPath)
            _mux_result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", _tmp_video_path,
                    "-i", _source_video_path,
                    "-map", "0:v:0",
                    "-map", "1:a:0",
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "128k",
                    "-shortest",
                    outputPath,
                ],
                capture_output=True, text=True, timeout=120,
            )
            if _mux_result.returncode == 0:
                log.info("Audio mux successful: %s", outputPath)
            else:
                log.warning("ffmpeg audio mux failed (rc=%d)", _mux_result.returncode)
                import shutil
                shutil.copy2(_tmp_video_path, outputPath)
        except Exception as e:
            log.warning("Audio mux exception: %s", e)
            import shutil
            try:
                shutil.copy2(_tmp_video_path, outputPath)
            except Exception:
                pass
        finally:
            try:
                os.remove(_tmp_video_path)
            except Exception:
                pass
    if out_proc is None and _tmp_video_path and os.path.exists(_tmp_video_path):
        if not os.path.exists(outputPath) or os.path.getsize(outputPath) == 0:
            import shutil
            shutil.copy2(_tmp_video_path, outputPath)
        try:
            os.remove(_tmp_video_path)
        except Exception:
            pass


def image_registration(
    ref_image: np.ndarray,
    offset_image: FrameInfo,
    shifts: dict,
    list_idx: int,
    width: int,
    height: int,
) -> np.ndarray:
    # The shift is calculated once for each video and stored
    if list_idx not in shifts:
        xoff, yoff = cross_correlation_shifts(
            ref_image[:, :, 0], offset_image.frame[:, :, 0]
        )
        shifts[list_idx] = (xoff, yoff)
    else:
        xoff, yoff = shifts[list_idx]

    offset_image.ball = tuple(
        [offset_image.ball[0] - int(xoff), offset_image.ball[1] - int(yoff)]
    )
    matrix = np.float32([[1, 0, -xoff], [0, 1, -yoff]])
    corrected_image = cv2.warpAffine(offset_image.frame, matrix, (width, height))

    return corrected_image
