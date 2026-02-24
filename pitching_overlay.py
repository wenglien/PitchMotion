import argparse
import logging
import os
import sys
import warnings
from typing import Optional

from src.pipelines.yolov8_pipeline import run_yolov8_pipeline as _run_yolov8_pipeline
from src.logging_utils import configure_logging, get_logger

if not sys.warnoptions:
    warnings.filterwarnings("ignore", category=FutureWarning)


def run_yolov8_overlay(
    video_paths: list[str],
    output_path: str,
    *,
    weights_path: str = os.path.join(
        "yolov8", "best_baseball.pt"
    ),
    conf: float = 0.05,
    show_preview: bool = False,
    manual_distance_meters: Optional[float] = None,
    stride_correction: Optional[float] = None,
    enable_speed_calculation: bool = True,
    debug: bool = False,
    logger: Optional[logging.Logger] = None,
) -> None:
    """
    以 Ultralytics YOLO 產生 overlay（YOLO11 / YOLOv8 均可）。
    """
    _run_yolov8_pipeline(
        video_paths,
        weights_path=weights_path,
        conf=conf,
        output_path=output_path,
        show_preview=show_preview,
        enable_speed_calculation=enable_speed_calculation,
        enable_field_calibration=False,
        manual_distance_meters=manual_distance_meters,
        stride_correction=stride_correction,
        debug=debug,
        logger=logger,
    )


def _parse_cli_args() -> argparse.Namespace:
    """CLI 模式下使用的參數解析。"""
    parser = argparse.ArgumentParser(
        description="以 Ultralytics YOLO（YOLO11/YOLOv8）分析投球影片並產生 Overlay 影片。"
    )
    parser.add_argument(
        "-f", "--videos-folder",
        dest="rootDir",
        default=os.path.join("videos", "videos1"),
        help="包含投球影片的資料夾（預設：videos/videos1）",
    )
    parser.add_argument(
        "-v", "--video-file",
        dest="videoFile",
        default=None,
        help="單一影片檔案（會覆蓋 --videos-folder）",
    )
    parser.add_argument(
        "-w", "--weights",
        default=os.path.join("yolov8", "best_baseball.pt"),
        help="Ultralytics YOLO 權重檔路徑（.pt）",
    )
    parser.add_argument(
        "-c", "--conf",
        type=float,
        default=0.05,
        help="YOLO 偵測置信度閾值（預設：0.05）",
    )
    parser.add_argument(
        "-d", "--distance",
        type=float,
        default=None,
        help="投手丘到本壘板距離（公尺），例如：18.44（MLB）或 14.02（少棒）",
    )
    parser.add_argument(
        "--stride-correction",
        type=float,
        default=None,
        help="跨步修正值（公尺），預設 1.7。實際飛行距離 = 投手丘距離 - 跨步修正",
    )
    parser.add_argument(
        "--no-speed",
        action="store_true",
        default=False,
        help="停用球速計算功能",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        default=False,
        help="顯示完整 traceback（除錯用）",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        default=False,
        help="只輸出錯誤訊息（ERROR）",
    )
    parser.add_argument(
        "-V", "--verbose",
        action="count",
        default=0,
        help="輸出更多除錯資訊（可重複，例如 -VV）",
    )
    return parser.parse_args()


def cli_main() -> None:
    """單一 CLI 入口。"""
    args = _parse_cli_args()
    configure_logging(verbose=args.verbose, quiet=args.quiet)
    log = get_logger("pitching_overlay")

    video_paths: list[str] = []
    if args.videoFile:
        video_file = args.videoFile
        if not os.path.isfile(video_file):
            log.error("video file not found: %s", video_file)
            sys.exit(1)
        video_paths = [video_file]
        output_path = os.path.join(os.path.dirname(video_file) or ".", "Overlay.mp4")
    else:
        rootDir = args.rootDir
        if not os.path.isdir(rootDir):
            log.error("videos folder not found: %s", rootDir)
            sys.exit(1)
        output_path = os.path.join(rootDir, "Overlay.mp4")
        for path in os.listdir(rootDir):
            if path.lower().endswith((".mp4", ".avi", ".mov", ".mkv")):
                video_paths.append(os.path.join(rootDir, path))

    if not video_paths:
        log.warning("No video files found to process.")
        sys.exit(0)

    try:
        run_yolov8_overlay(
            video_paths,
            output_path,
            weights_path=args.weights,
            conf=args.conf,
            show_preview=True,
            manual_distance_meters=args.distance,
            stride_correction=args.stride_correction,
            enable_speed_calculation=not args.no_speed,
            debug=args.debug,
            logger=log,
        )
    except Exception as e:
        if args.debug:
            log.exception("YOLO 處理失敗")
        else:
            log.error("YOLO 處理失敗：%s", str(e))
        sys.exit(1)


if __name__ == "__main__":
    cli_main()
