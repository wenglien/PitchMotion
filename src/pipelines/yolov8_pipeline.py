import os
import logging
from typing import Optional

from ultralytics import YOLO

from src.get_pitch_frames_yolov8 import get_pitch_frames_yolov8
from src.generate_overlay import generate_overlay
from src.ball_speed_calculator import BallSpeedCalculator


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
    stride_correction: Optional[float] = None,
    debug: bool = False,
    logger: Optional[logging.Logger] = None,
) -> Optional[dict]:
    """
    Ultralytics YOLO（YOLO11/YOLOv8）推論 + Mediapipe Pose + overlay pipeline。

    這是 GUI 與 CLI 共用的主要入口（避免重複邏輯分散在多個腳本）。
    """
    log = logger if logger is not None else logging.getLogger(__name__)
    if not video_paths:
        raise ValueError("video_paths 不可為空，至少需要一支投球影片。")

    if not os.path.isfile(weights_path):
        raise FileNotFoundError(
            f"找不到 Ultralytics YOLO 權重檔案：{weights_path}\n"
            "請先依照 yolov8/train_yolo11.py（或 yolov8/train_yolov8.py）完成訓練。"
        )

    log.info("Loading Ultralytics YOLO model from: %s", weights_path)
    yolo_model = YOLO(weights_path)

    speed_calculator = None
    if enable_speed_calculation:
        import cv2

        cap = cv2.VideoCapture(video_paths[0])
        if cap.isOpened():
            video_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            video_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            video_fps = int(cap.get(cv2.CAP_PROP_FPS))

            ret, _ = cap.read()
            cap.release()

            if ret:
                pitch_distance_m = (
                    manual_distance_meters if manual_distance_meters is not None else 18.44
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
            )
            if ball_frames and len(ball_frames) > 0:
                pitch_frames.append(ball_frames)
                if speed_info:
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

    valid_pitch_frames = [pf for pf in pitch_frames if pf and len(pf) > 0]

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
        )
        log.info("Overlay 影片已輸出到：%s", output_path)
    else:
        log.warning(
            "沒有任何影片偵測到足夠的球軌跡，因此不會產生 Overlay 影片，避免輸出損壞或空白檔案。"
        )

    return all_speed_info

