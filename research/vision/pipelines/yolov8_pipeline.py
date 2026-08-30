import os
import logging
from typing import Optional

from ultralytics import YOLO

from research.vision.get_pitch_frames_yolov8 import get_pitch_frames_yolov8, _get_video_fps_ffprobe
from research.vision.generate_overlay import generate_overlay
from research.vision.ball_speed_calculator import BallSpeedCalculator
from research.vision.utils import MLB_MOUND_DISTANCE_M
from research.pitch_classifier import PitchFeatureExtractor, RuleBasedClassifier


def run_yolov8_pipeline(
    video_paths: list[str],
    weights_path: str,
    *,
    conf: float = 0.05,
    output_path: str,
    show_preview: bool = False,
    enable_speed_calculation: bool = True,
    enable_field_calibration: bool = True,
    manual_distance_meters: Optional[float] = None,
    output_scale: float = 0.5,   # overlay 輸出縮放比例（0.5 = 半解析度，大幅加快編碼）
    stride_correction: Optional[float] = None,
    debug: bool = False,
    logger: Optional[logging.Logger] = None,
    pitch_classifier=None,      # 若傳入 ML 分類器則優先使用，否則自動用規則分類器
    enable_pitch_classification: bool = True,  # 設為 False 可完全關閉球種判定
    batter_height_m: Optional[float] = None,  # MLB ABS: top 53.5%, bottom 27% of measured batter height
    strike_zone: Optional[dict] = None,  # 覆寫 STRIKE_ZONE_* 預設值；dict with x_min/x_max/y_min/y_max (0-1)
) -> list[dict]:
    """
    Ultralytics YOLO26 推論 + Mediapipe Pose + overlay pipeline。

    這是 GUI 與 CLI 共用的主要入口（避免重複邏輯分散在多個腳本）。
    使用 YOLO26n：比 YOLOv8n 快 43%，具備 STAL 小物體優化。

    球種判定：
    - 預設自動啟用 RuleBasedClassifier（不需訓練資料）
    - 傳入 pitch_classifier 時優先使用（自訂分類器）
    - enable_pitch_classification=False 可完全關閉
    """
    log = logger if logger is not None else logging.getLogger(__name__)
    if not video_paths:
        raise ValueError("video_paths 不可為空，至少需要一支投球影片。")

    # ── 球種分類器初始化 ────────────────────────────────────────────────────
    # 若外部未傳入 ML 分類器，自動建立規則分類器（零設定即可用）
    _classifier = None
    if enable_pitch_classification:
        if pitch_classifier is not None:
            _classifier = pitch_classifier
            log.info("球種判定：使用外部傳入分類器（%s）", type(pitch_classifier).__name__)
        else:
            _classifier = RuleBasedClassifier()
            log.info("球種判定：使用內建規則分類器（RuleBasedClassifier）")

    if not os.path.isfile(weights_path):
        raise FileNotFoundError(
            f"找不到 Ultralytics YOLO 權重檔案：{weights_path}\n"
            "請先依照 research/yolo/train_yolo26.py 完成訓練（YOLO26n，比 YOLOv8 快 43%）。"
        )

    log.info("Loading Ultralytics YOLO model from: %s", weights_path)
    yolo_model = YOLO(weights_path)

    speed_calculator = None
    if enable_speed_calculation:
        import cv2

        cap = cv2.VideoCapture(video_paths[0])
        try:
            if cap.isOpened():
                video_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                video_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                video_fps = int(cap.get(cv2.CAP_PROP_FPS))

                # ── 與 get_pitch_frames_yolov8 統一 FPS 來源 ──────────────
                # cv2.CAP_PROP_FPS 回傳 r_frame_rate（編碼最大幀率），
                # 對 VFR iPhone 影片可能回傳 30 而非真正的 60。
                # 改用 ffprobe avg_frame_rate 確保一致。
                _ffprobe_fps = _get_video_fps_ffprobe(video_paths[0])
                if _ffprobe_fps is not None and _ffprobe_fps > 0:
                    video_fps = round(_ffprobe_fps)
                    log.info(
                        "BallSpeedCalculator fps: ffprobe avg_frame_rate → %d "
                        "(cv2 was %d)",
                        video_fps, int(cap.get(cv2.CAP_PROP_FPS)),
                    )

                ret, _ = cap.read()

                if ret:
                    pitch_distance_m = (
                        manual_distance_meters if manual_distance_meters is not None
                        else MLB_MOUND_DISTANCE_M
                    )
                    speed_calculator = BallSpeedCalculator(
                        fps=video_fps,
                        video_width=video_width,
                        video_height=video_height,
                        theoretical_distance=pitch_distance_m,
                        stride_correction=stride_correction,
                    )
                    log.info(
                        "球速計算：投手丘距離=%.2fm, 跨步修正=%.2fm, 有效飛行距離=%.2fm",
                        pitch_distance_m,
                        speed_calculator.stride_correction,
                        speed_calculator.effective_distance,
                    )
        finally:
            cap.release()

    pitch_frames = []
    width = height = fps = None
    all_speed_info = []

    for idx, video_path in enumerate(video_paths):
        log.info("Processing Video %d: %s", idx + 1, video_path)
        if not os.path.isfile(video_path):
            log.warning("video file not found, skip: %s", video_path)
            continue

        try:
            ball_frames, width, height, fps, speed_info = get_pitch_frames_yolov8(
                video_path,
                yolo_model,
                conf_threshold=conf,
                show_preview=show_preview,
                speed_calculator=speed_calculator,
                batter_height_m=batter_height_m,
                strike_zone=strike_zone,
            )
            if ball_frames:
                pitch_frames.append(ball_frames)
                if speed_info:
                    # ── 球種分類 ────────────────────────────────────────────
                    if _classifier is not None:
                        try:
                            trajectory = [
                                f.ball for f in ball_frames if f.ball_in_frame
                            ]
                            extractor = PitchFeatureExtractor(
                                width or 3840, height or 2160, fps or 120
                            )
                            features = extractor.extract(
                                trajectory, speed_info,
                                os.path.splitext(os.path.basename(video_path))[0]
                            )
                            if features is not None:
                                pitch_type, confidence, scores = _classifier.classify(features)
                                speed_info["pitch_type"] = pitch_type
                                speed_info["pitch_confidence"] = confidence
                                speed_info["pitch_scores"] = scores
                                log.info(
                                    "球種判定：%s（信心=%.0f%%）速度=%.1f km/h",
                                    pitch_type, confidence * 100,
                                    features.speed_kmh,
                                )
                            else:
                                log.info("球種判定：軌跡點不足，跳過")
                        except Exception as _ce:
                            log.warning("球種分類失敗：%s", _ce)
                    all_speed_info.append(speed_info)
            else:
                log.warning(
                    "視訊 %s 中沒有偵測到足夠的球軌跡，將略過此影片的 overlay。",
                    os.path.basename(video_path),
                )
        except Exception as e:
            # 批次處理：不中斷整個流程，但在 debug 模式印出 traceback
            if debug:
                log.exception(
                    "無法取得足夠棒球偵測，略過影片：%s", os.path.basename(video_path)
                )
            else:
                log.error(
                    "無法取得足夠棒球偵測，略過影片：%s（%s）",
                    os.path.basename(video_path),
                    str(e),
                )
            continue

    valid_pitch_frames = [pf for pf in pitch_frames if pf]

    if valid_pitch_frames and width is not None and height is not None and fps is not None:
        speed_info_for_overlay = all_speed_info[0] if all_speed_info else None

        generate_overlay(
            valid_pitch_frames,
            width,
            height,
            fps,
            output_path,
            show_preview=show_preview,
            speed_info=speed_info_for_overlay,
            output_scale=output_scale,
        )
        log.info("Overlay 影片已輸出到：%s", output_path)
    else:
        log.warning(
            "沒有任何影片偵測到足夠的球軌跡，因此不會產生 Overlay 影片，避免輸出損壞或空白檔案。"
        )

    return all_speed_info
