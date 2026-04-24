"""
把訓練好的 best.pt 轉成 CoreML (.mlpackage → .mlmodelc)
然後複製到 iOS 專案。

用法：
  python yolov8/export_coreml.py
  python yolov8/export_coreml.py --weights path/to/best.pt
"""

import argparse
import shutil
import subprocess
from pathlib import Path

from ultralytics import YOLO

_REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WEIGHTS = _REPO_ROOT / "train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt"
IOS_BUNDLE_DIR = _REPO_ROOT / "mobile/ios/SpeedGun/Models"

def export(weights: str):
    weights = Path(weights)
    if not weights.exists():
        print(f"❌ 找不到模型：{weights}")
        return

    print(f"📦 載入模型：{weights}")
    model = YOLO(str(weights))

    print("🔄 匯出 CoreML (.mlpackage)...")
    model.export(
        format="coreml",
        imgsz=640,
        nms=True,          # 在模型內建 NMS（iOS 端不需要自己做）
        half=False,        # FP32（iPhone Neural Engine 支援 FP16 但 FP32 更穩）
    )

    # 匯出後的 .mlpackage 在同目錄
    mlpackage = weights.parent / f"{weights.stem}.mlpackage"
    if not mlpackage.exists():
        # ultralytics 有時放在 weights 同層
        mlpackage = weights.parent.parent / f"{weights.stem}.mlpackage"

    if not mlpackage.exists():
        print(f"❌ 找不到 .mlpackage，請手動找：{weights.parent}")
        return

    print(f"✅ 匯出完成：{mlpackage}")

    # 編譯成 .mlmodelc（Xcode 直接使用）
    mlmodelc = mlpackage.with_suffix(".mlmodelc")
    print(f"🔨 編譯 CoreML model...")
    result = subprocess.run(
        ["xcrun", "coremlcompiler", "compile", str(mlpackage), str(mlpackage.parent)],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"⚠️  編譯失敗（可用 .mlpackage 直接放入 Xcode 讓它自動編譯）：")
        print(result.stderr)
    else:
        print(f"✅ 編譯完成：{mlmodelc}")

    # 複製到 iOS 專案
    ios_dir = Path(IOS_BUNDLE_DIR)
    ios_dir.mkdir(parents=True, exist_ok=True)

    target_name = "best_baseball.mlmodelc"
    target_path = ios_dir / target_name

    src = mlmodelc if mlmodelc.exists() else mlpackage
    if target_path.exists():
        shutil.rmtree(target_path) if target_path.is_dir() else target_path.unlink()

    shutil.copytree(src, target_path) if src.is_dir() else shutil.copy2(src, target_path)
    print(f"\n✅ 已複製到 iOS 專案：{target_path}")
    print("👉 下一步：重新 build app 到手機")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS))
    args = parser.parse_args()
    export(args.weights)
