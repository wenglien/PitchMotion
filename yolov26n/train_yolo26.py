from __future__ import annotations

from pathlib import Path
import os

import torch
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
DATA_CONFIG = ROOT / "yolov26n" / "data_baseball.yaml"


def get_device() -> str:
    # 環境變數 DEVICE 可強制指定（例如 cpu 避免 MPS 卡住）
    env_device = _env_str("DEVICE", "")
    if env_device:
        return env_device
    # 在 Apple Silicon 上優先使用 mps；其次 cuda；最後 cpu
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "0"
    return "cpu"


def _env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if not v:
        return default
    try:
        return int(v)
    except Exception:
        return default


def _env_str(name: str, default: str) -> str:
    v = os.getenv(name)
    return v.strip() if v and v.strip() else default


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off", ""):
        return False
    return default


def main() -> None:
    device = get_device()
    print(f"Using device: {device}")

    # 預設使用 YOLO26n（nano）：最快，對棒球這種小物體效果最佳
    model_name = _env_str("YOLO_MODEL", "yolo26n.pt")
    # CPU 時預設較少 epoch、較小尺寸以縮短訓練時間
    epochs_default = 40 if device == "cpu" else 80
    imgsz_default = 480 if device == "cpu" else 640
    epochs = _env_int("EPOCHS", epochs_default)
    imgsz = _env_int("IMGSZ", imgsz_default)
    # CPU 時預設較小 batch，減少卡住與記憶體壓力
    batch_default = 4 if device == "cpu" else 8
    batch = _env_int("BATCH", batch_default)
    exist_ok = _env_bool("EXIST_OK", default=False)
    resume = _env_bool("RESUME", default=False)
    # CPU 時關閉 AMP，避免某些環境下卡住
    amp = _env_bool("AMP", default=(device != "cpu"))
    # CPU 時可關閉驗證，避免卡在每個 epoch 後的 Validating
    do_val = _env_bool("VAL", default=(device != "cpu"))
    if not do_val:
        print("Validation disabled (VAL=0) — 跳過驗證以減少卡住。")

    # 以 YOLO26 預訓練權重為基礎做微調（自動下載 yolo26n.pt）
    model = YOLO(model_name)

    run_name_default = f"baseball_{Path(model_name).stem}"
    run_name = _env_str("RUN_NAME", run_name_default)
    # workers=0 避免 macOS / MPS 下 dataloader 卡住
    workers = _env_int("WORKERS", 0)
    model.train(
        data=str(DATA_CONFIG),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project=str(ROOT / "yolov8" / "runs" / "detect"),
        name=run_name,
        patience=10,
        exist_ok=exist_ok,
        resume=resume,
        workers=workers,
        amp=amp,
        val=do_val,
    )

    print(
        "\n訓練完成後，最佳權重會在：\n"
        f"  yolov8/runs/detect/{run_name}/weights/best.pt\n"
        "之後可用於推論與整合現有的軌跡/overlay pipeline。"
    )


if __name__ == "__main__":
    main()
