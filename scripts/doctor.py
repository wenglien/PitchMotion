from __future__ import annotations

import importlib
import platform
import sys
from pathlib import Path


def _try_import(name: str):
    try:
        mod = importlib.import_module(name)
        return mod, None
    except Exception as e:  # noqa: BLE001
        return None, e


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    print("== speedgun-mobile doctor ==")
    print(f"python:     {sys.version.replace(chr(10), ' ')}")
    print(f"executable: {sys.executable}")
    print(f"platform:   {platform.system()} {platform.release()} ({platform.machine()})")
    print(f"cwd:        {Path.cwd()}")
    print(f"repo_root:  {repo_root}")

    # ── Shadowing check ──────────────────────────────────────────────────────
    shadow_candidates = [
        repo_root / "mediapipe.py",
        repo_root / "mediapipe",
        repo_root / "ultralytics.py",
        repo_root / "ultralytics",
    ]
    shadow_hits = [p for p in shadow_candidates if p.exists()]
    if shadow_hits:
        print("\nWARN 可能的同名覆蓋（會導致 import 載入錯誤）：")
        for p in shadow_hits:
            print(f"  - {p}")

    # ── Dependency imports ───────────────────────────────────────────────────
    ok_all = True
    print("\n== dependencies ==")
    for name in ["numpy", "cv2", "mediapipe", "ultralytics"]:
        mod, err = _try_import(name)
        if err is not None:
            ok_all = False
            print(f"  FAIL {name}: {err}")
            continue
        ver  = getattr(mod, "__version__", "?")
        path = getattr(mod, "__file__", "?")
        print(f"  OK   {name}: version={ver}  file={path}")
        if name == "mediapipe":
            print(f"       mediapipe.has_solutions: {hasattr(mod, 'solutions')}")

    # ── Project imports ──────────────────────────────────────────────────────
    print("\n== project modules ==")
    project_modules = [
        "research.vision.get_pitch_frames_yolov8",
        "research.vision.pipelines.yolov8_pipeline",
        "research.pitch_classifier",
    ]
    for name in project_modules:
        mod, err = _try_import(name)
        if err is not None:
            ok_all = False
            print(f"  FAIL {name}: {err}")
        else:
            print(f"  OK   {name}")

    # ── Result ───────────────────────────────────────────────────────────────
    print()
    if ok_all:
        print("PASS")
        return 0
    print("FAIL（請先修正上述問題）")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
