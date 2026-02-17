import logging
import os
import sys
import warnings
from optparse import OptionParser

from typing import Optional

from src.pipelines.yolov8_pipeline import run_yolov8_pipeline as _run_yolov8_pipeline
from src.logging_utils import configure_logging, get_logger

# Ignore warnings
if not sys.warnoptions:
    warnings.simplefilter("ignore")


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


def _parse_cli_args():
    """CLI 模式下使用的參數解析。"""
    optparser = OptionParser()
    optparser.add_option(
        "-f",
        "--videos_folder",
        dest="rootDir",
        help="Root directory that contains your pitching videos",
        default=os.path.join("videos", "videos1"),
    )
    optparser.add_option(
        "-v",
        "--video_file",
        dest="videoFile",
        help="Single video file to analyze (overrides --videos_folder)",
        default=None,
    )
    optparser.add_option(
        "-w",
        "--weights",
        dest="weights",
        help="Path to Ultralytics YOLO weights (.pt) (YOLO11/YOLOv8)",
        default=os.path.join("yolov8", "best_baseball.pt"),
    )
    optparser.add_option(
        "-c",
        "--conf",
        dest="conf",
        type="float",
        help="YOLO confidence threshold (default: 0.05)",
        default=0.05,
    )
    optparser.add_option(
        "-d",
        "--distance",
        dest="distance",
        type="float",
        help="投手丘到本壘板距離（公尺），例如：18.44（MLB）或 14.02（少棒）",
        default=None,
    )
    optparser.add_option(
        "--stride-correction",
        dest="stride_correction",
        type="float",
        help="跨步修正值（公尺），預設 1.7。實際飛行距離 = 投手丘距離 - 跨步修正",
        default=None,
    )
    optparser.add_option(
        "--no-speed",
        dest="no_speed",
        action="store_true",
        help="停用球速計算功能（Ultralytics YOLO）",
        default=False,
    )

    optparser.add_option(
        "--debug",
        dest="debug",
        action="store_true",
        help="顯示完整 traceback（除錯用）",
        default=False,
    )
    optparser.add_option(
        "--quiet",
        dest="quiet",
        action="store_true",
        help="只輸出錯誤訊息（ERROR）",
        default=False,
    )
    optparser.add_option(
        "-V",
        "--verbose",
        dest="verbose",
        action="count",
        help="輸出更多除錯資訊（可重複，例如 -VV）",
        default=0,
    )
    return optparser.parse_args()


def cli_main() -> None:
    """單一 CLI 入口。"""
    options, args = _parse_cli_args()
    configure_logging(verbose=int(options.verbose or 0), quiet=bool(options.quiet))
    log = get_logger("pitching_overlay")

    video_paths: list[str] = []
    if options.videoFile:
        video_file = options.videoFile
        if not os.path.isfile(video_file):
            log.error("video file not found: %s", video_file)
            sys.exit(1)
        video_paths = [video_file]
        output_path = os.path.join(os.path.dirname(video_file), "Overlay.mp4")
    else:
        rootDir = options.rootDir
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
            weights_path=options.weights,
            conf=float(options.conf),
            show_preview=True,
            manual_distance_meters=options.distance,
            stride_correction=options.stride_correction,
            enable_speed_calculation=not options.no_speed,
            debug=bool(options.debug),
            logger=log,
        )
    except Exception as e:
        if options.debug:
            log.exception("YOLO 處理失敗")
        else:
            log.error("YOLO 處理失敗：%s", str(e))
        sys.exit(1)


if __name__ == "__main__":
    cli_main()
