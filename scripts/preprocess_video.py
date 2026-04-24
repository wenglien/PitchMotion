"""Preprocess video(s) to 120 FPS and 1080p using ffmpeg.

This script calls ffmpeg. It supports frame interpolation (smooth) or
simple duplication to reach 120 FPS, and scales/pads to 1920x1080 while
preserving aspect ratio.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def check_ffmpeg():
    if shutil.which("ffmpeg") is None:
        print("ffmpeg not found. Install ffmpeg and ensure it's in PATH.", file=sys.stderr)
        sys.exit(1)


def build_filter(method: str, resolution: str) -> str:
    # Choose target dimensions based on resolution
    if resolution == "4k":
        target_w, target_h = 3840, 2160
    else:
        target_w, target_h = 1920, 1080

    # Use minterpolate for interpolation; otherwise simple fps duplication.
    # 使用 force_original_aspect_ratio=decrease，確保先把畫面縮放到
    # 不超出目標解析度，再置中填滿，避免「Padded dimensions cannot be smaller」
    # 這類錯誤（例如直式 4K 影片帶有旋轉矩陣的情況）。
    scale_pad = (
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2"
    )
    if method == "interpolate":
        return (
            "minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1," + scale_pad
        )
    return "fps=120," + scale_pad


def process_file(infile: str, outfile: str, method: str, crf: int, preset: str, resolution: str) -> None:
    vf = build_filter(method, resolution)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        infile,
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-c:a",
        "copy",
        outfile,
    ]
    print("Running:", " ".join(cmd))
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if proc.returncode != 0:
        print(proc.stdout, file=sys.stderr)
        raise SystemExit(proc.returncode)


def main():
    parser = argparse.ArgumentParser(
        description="Increase FPS to 120 and scale to 1080p using ffmpeg."
    )
    parser.add_argument("input", help="input file or directory")
    parser.add_argument("-o", "--output", help="output file or directory")
    parser.add_argument(
        "--method",
        choices=["interpolate", "duplicate"],
        default="interpolate",
        help="use frame interpolation (smooth) or duplicate frames",
    )
    parser.add_argument(
        "--resolution",
        choices=["1080p", "4k"],
        default="1080p",
        help="target resolution: 1080p or 4k",
    )
    parser.add_argument("--crf", type=int, default=18, help="CRF for x264 (lower = better quality)")
    parser.add_argument("--preset", default="medium", help="x264 preset (e.g. fast, medium, slow)")
    args = parser.parse_args()

    check_ffmpeg()

    p = Path(args.input)
    if p.is_dir():
        suffix = "_120fps_4k" if args.resolution == "4k" else "_120fps_1080p"
        outdir = Path(args.output) if args.output else p / f"processed{suffix}"
        outdir.mkdir(parents=True, exist_ok=True)
        for f in p.iterdir():
            if f.suffix.lower() in (".mp4", ".mov", ".mkv", ".avi", ".webm"):
                out_file = outdir / (f.stem + suffix + ".mp4")
                process_file(str(f), str(out_file), args.method, args.crf, args.preset, args.resolution)
    else:
        suffix = "_120fps_4k" if args.resolution == "4k" else "_120fps_1080p"
        out_file = args.output if args.output else str(p.with_name(p.stem + suffix + ".mp4"))
        process_file(str(p), out_file, args.method, args.crf, args.preset, args.resolution)


if __name__ == "__main__":
    main()

