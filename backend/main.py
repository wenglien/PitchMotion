from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import uuid
import logging
import tempfile
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

# 確保專案根目錄在 sys.path，讓 `src.*` 模組可被找到
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("speedgun.backend")

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_repo_dotenv() -> None:
    """讀取 repo 根目錄 .env（不覆寫已在 shell / 啟動器設定的變數）。"""
    env_path = _REPO_ROOT / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except OSError:
        pass


_load_repo_dotenv()


def _resolve_yolo_weights() -> str:
    default_rel = "train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt"
    raw = os.getenv("YOLO_WEIGHTS", default_rel)
    p = Path(raw)
    if not p.is_absolute():
        p = _REPO_ROOT / p
    if p.is_file():
        return str(p)
    for fb in (
        _REPO_ROOT / "train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt",
        _REPO_ROOT / "train_tool/runs/detect/baseball_yolo26n_v4/weights/best.pt",
        _REPO_ROOT / "yolov26n/best_baseball.pt",
    ):
        if fb.is_file():
            log.warning(
                "YOLO_WEIGHTS 指向的檔案不存在（%s），改用 %s",
                raw,
                fb,
            )
            return str(fb)
    return str(p)


YOLO_WEIGHTS = _resolve_yolo_weights()
LOCAL_DATA_DIR  = Path(os.getenv("LOCAL_DATA_DIR", "/tmp/speedgun_dev"))
LOCAL_OVERLAYS  = LOCAL_DATA_DIR / "overlays"
LOCAL_ORIGINALS = LOCAL_DATA_DIR / "originals"
LOCAL_HISTORY   = LOCAL_DATA_DIR / "history.json"
API_BASE_URL   = os.getenv("API_BASE_URL", "http://localhost:8000").rstrip("/")

MAX_UPLOAD_MB    = 100
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

# ── HDR 偵測 & 轉換 ──────────────────────────────────────────────────────────

_HDR_TRANSFER_KEYWORDS = {"smpte2084", "arib-std-b67", "smpte-st-2084", "bt2020"}

def _is_hdr_video(video_path: str | Path) -> bool:
    """Use ffprobe to detect if a video uses HDR transfer characteristics."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
             "-show_entries", "stream=color_transfer,color_primaries,color_space,pix_fmt",
             "-of", "default=noprint_wrappers=1", str(video_path)],
            capture_output=True, text=True, timeout=10,
        )
        output = result.stdout.lower()
        # Check for HDR indicators in transfer characteristics
        for kw in _HDR_TRANSFER_KEYWORDS:
            if kw in output:
                log.info("HDR detected in %s (keyword: %s)", video_path, kw)
                return True
        # Also check pixel format for 10-bit (common in iPhone Dolby Vision)
        if "p010" in output or "yuv420p10" in output:
            log.info("HDR detected in %s (10-bit pixel format)", video_path)
            return True
    except Exception as exc:
        log.debug("ffprobe HDR check failed: %s", exc)
    return False


def _convert_hdr_to_sdr(input_path: Path, output_path: Path) -> bool:
    """Convert HDR video to SDR using ffmpeg tone mapping. Returns True on success."""
    # Try zscale (best quality) first, fall back to simpler tonemap filter.
    _zscale_vf = (
        "zscale=t=linear:npl=100,format=gbrpf32le,"
        "zscale=p=bt709,tonemap=tonemap=mobius:desat=0,"
        "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
    )
    _simple_vf = (
        "format=p010le,tonemap=mobius:desat=0,format=yuv420p"
    )
    # colorspace flags + h264_metadata BSF ensure the output is tagged as BT.709 SDR
    _color_flags = [
        "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709",
        "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    ]
    for vf in (_zscale_vf, _simple_vf):
        cmd = [
            "ffmpeg", "-y", "-i", str(input_path),
            "-vf", vf,
            *_color_flags,
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "copy",
            str(output_path),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0:
                log.info("HDR→SDR conversion succeeded (vf=%s): %s", vf[:20], output_path)
                return True
            log.debug("HDR→SDR attempt failed (vf=%s, rc=%d)", vf[:20], proc.returncode)
        except subprocess.TimeoutExpired:
            log.warning("HDR→SDR conversion timed out (300s)")
        except Exception as exc:
            log.debug("HDR→SDR attempt error (vf=%s): %s", vf[:20], exc)
    log.warning("HDR→SDR conversion failed with all methods")
    return False

_jobs: dict[str, dict] = {}
_job_log_queues: dict[str, list[queue.Queue]] = {}
_job_log_history: dict[str, list[dict]] = {}      # persisted log entries per job
_jobs_lock = threading.Lock()

def _job_create(job_id: str):
    with _jobs_lock:
        _jobs[job_id] = {"status": "pending", "result": None, "error": None}
        _job_log_queues[job_id] = []
        _job_log_history[job_id] = []

def _job_set_status(job_id: str, status: str, result=None, error=None):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id]["status"] = status
            if result is not None:
                _jobs[job_id]["result"] = result
            if error is not None:
                _jobs[job_id]["error"] = error

def _job_get(job_id: str) -> Optional[dict]:
    with _jobs_lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None

def _job_push_log(job_id: str, level: str, message: str):
    entry = {"level": level, "message": message, "ts": datetime.utcnow().isoformat()}
    with _jobs_lock:
        # Persist to history (capped at 2000 entries to avoid unbounded growth)
        hist = _job_log_history.get(job_id)
        if hist is not None and len(hist) < 2000:
            hist.append(entry)
        queues = list(_job_log_queues.get(job_id, []))
    for q in queues:
        try:
            q.put_nowait(entry)
        except queue.Full:
            pass

def _job_subscribe(job_id: str) -> queue.Queue:
    q = queue.Queue(maxsize=500)
    with _jobs_lock:
        if job_id not in _job_log_queues:
            _job_log_queues[job_id] = []
        _job_log_queues[job_id].append(q)
    return q

def _job_unsubscribe(job_id: str, q: queue.Queue):
    with _jobs_lock:
        lst = _job_log_queues.get(job_id, [])
        try:
            lst.remove(q)
        except ValueError:
            pass

def _job_finish_log(job_id: str):
    entry = {"level": "DONE", "message": "__done__", "ts": datetime.utcnow().isoformat()}
    with _jobs_lock:
        queues = list(_job_log_queues.get(job_id, []))
    for q in queues:
        try:
            q.put_nowait(entry)
        except queue.Full:
            pass

class _JobLogHandler(logging.Handler):
    def __init__(self, job_id: str):
        super().__init__()
        self.job_id = job_id

    def emit(self, record: logging.LogRecord):
        try:
            msg = self.format(record)
            _job_push_log(self.job_id, record.levelname, msg)
        except Exception:
            pass


_yolo_model = None
_yolo_lock = threading.Lock()

def _get_yolo():
    global _yolo_model
    with _yolo_lock:
        if _yolo_model is None:
            from ultralytics import YOLO
            if not Path(YOLO_WEIGHTS).is_file():
                raise RuntimeError(f"YOLO weights not found: {YOLO_WEIGHTS}")
            log.info("Loading YOLO model from %s", YOLO_WEIGHTS)
            _yolo_model = YOLO(YOLO_WEIGHTS)
        return _yolo_model


def _history_load() -> list[dict]:
    if LOCAL_HISTORY.exists():
        try:
            return json.loads(LOCAL_HISTORY.read_text())
        except Exception:
            pass
    return []


def _history_append(record: dict):
    records = _history_load()
    records.insert(0, record)
    LOCAL_HISTORY.write_text(json.dumps(records, ensure_ascii=False))


def _reencode_h264(src: Path, dst: Path) -> bool:
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(src),
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "23",
                "-movflags", "+faststart",
                "-an",
                str(dst),
            ],
            capture_output=True,
            timeout=120,
        )
        if result.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            log.info("Re-encoded %s → %s (H.264)", src.name, dst.name)
            return True
        log.warning("ffmpeg re-encode failed (rc=%d): %s", result.returncode,
                    result.stderr.decode(errors="replace")[-300:])
        return False
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.warning("ffmpeg not available or timed out: %s", e)
        return False


LOCAL_OVERLAYS.mkdir(parents=True, exist_ok=True)
LOCAL_ORIGINALS.mkdir(parents=True, exist_ok=True)
LOCAL_DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="SpeedGun API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "speedgun-backend"}


@app.get("/overlays/{job_id}.mp4")
async def serve_overlay(job_id: str):
    path = LOCAL_OVERLAYS / f"{job_id}.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Overlay not found")
    size = path.stat().st_size
    if size == 0:
        raise HTTPException(status_code=404, detail="Overlay file empty")
    return FileResponse(
        str(path),
        media_type="video/mp4",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": "bytes",
            "Content-Length": str(size),
        },
    )


@app.get("/original/{job_id}.mp4")
async def serve_original(job_id: str):
    path = LOCAL_ORIGINALS / f"{job_id}.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Original not found")
    size = path.stat().st_size
    if size == 0:
        raise HTTPException(status_code=404, detail="Original file empty")
    return FileResponse(
        str(path),
        media_type="video/mp4",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": "bytes",
            "Content-Length": str(size),
        },
    )


@app.get("/download/{job_id}.mp4")
async def download_overlay(job_id: str):
    src = LOCAL_OVERLAYS / f"{job_id}.mp4"
    if not src.exists():
        raise HTTPException(status_code=404, detail="Overlay not found")

    hq_path = LOCAL_OVERLAYS / f"{job_id}_hq.mp4"

    if not hq_path.exists():
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", str(src),
                    "-c:v", "libx264",
                    "-preset", "slow",
                    "-crf", "18",
                    "-movflags", "+faststart",
                    "-an",
                    str(hq_path),
                ],
                capture_output=True,
                timeout=180,
            )
            if result.returncode != 0 or not hq_path.exists() or hq_path.stat().st_size == 0:
                log.warning("HQ encode failed (rc=%d), falling back to preview quality: %s",
                            result.returncode, result.stderr.decode(errors="replace")[-200:])
                hq_path = src
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            log.warning("ffmpeg HQ encode failed: %s — falling back to preview", e)
            hq_path = src

    filename = f"speedgun_overlay_{job_id[:8]}.mp4"
    return FileResponse(
        str(hq_path),
        media_type="video/mp4",
        filename=filename,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@app.get("/jobs/{job_id}")
async def job_status(job_id: str):
    info = _job_get(job_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JSONResponse(content=info)


@app.get("/jobs/{job_id}/logs")
async def job_logs(job_id: str, level: Optional[str] = None):
    """Return persisted log entries for a completed (or running) job.

    Optional ``level`` query param filters by log level (INFO, WARNING, ERROR).
    Returns all stored entries by default.
    """
    with _jobs_lock:
        if job_id not in _job_log_history:
            raise HTTPException(status_code=404, detail="Job not found")
        entries = list(_job_log_history[job_id])
    if level:
        upper = level.upper()
        entries = [e for e in entries if e.get("level", "").upper() == upper]
    return JSONResponse(content={"job_id": job_id, "count": len(entries), "logs": entries})


@app.get("/logs/{job_id}")
async def stream_logs(job_id: str, request: Request):
    info = _job_get(job_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Job not found")

    sub_queue = _job_subscribe(job_id)

    async def event_generator():
        try:
            while True:
                try:
                    entry = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: sub_queue.get(timeout=0.1)
                    )
                except queue.Empty:
                    if await request.is_disconnected():
                        break
                    yield "event: ping\ndata: {}\n\n"
                    continue

                if await request.is_disconnected():
                    break

                data = json.dumps(entry, ensure_ascii=False)
                yield f"data: {data}\n\n"

                if entry.get("level") == "DONE":
                    break
        finally:
            _job_unsubscribe(job_id, sub_queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


def _resolve_base_url(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", "http")
    host  = request.headers.get("x-forwarded-host",
            request.headers.get("host", "localhost:8000"))
    if not request.headers.get("x-forwarded-host"):
        return API_BASE_URL
    return f"{proto}://{host}"


def _run_pipeline_thread(job_id: str, input_path: Path, tmpdir_path: Path,
                          output_path: Path, base_url: str,
                          mound_distance_m: float, stride_correction_m: float,
                          conf_threshold: float, filename: str,
                          batter_height_m: Optional[float] = None,
                          strike_zone: Optional[dict] = None):
    handler = _JobLogHandler(job_id)
    handler.setFormatter(logging.Formatter("%(name)s – %(message)s"))
    handler.setLevel(logging.INFO)

    root_logger = logging.getLogger()
    root_logger.addHandler(handler)

    try:
        _job_push_log(job_id, "INFO", f"⚡ 開始分析 {filename}…")
        _job_set_status(job_id, "running")

        # ── HDR→SDR 前處理：iPhone Dolby Vision / HLG 影片需先轉換 ──
        pipeline_input = input_path
        if _is_hdr_video(input_path):
            _job_push_log(job_id, "INFO", "🎨 偵測到 HDR 影片，正在轉換為 SDR…")
            sdr_path = tmpdir_path / "input_sdr.mp4"
            if _convert_hdr_to_sdr(input_path, sdr_path):
                pipeline_input = sdr_path
                _job_push_log(job_id, "INFO", "✅ HDR→SDR 轉換完成")
            else:
                _job_push_log(job_id, "WARN", "⚠️ HDR→SDR 轉換失敗，使用原始影片繼續")

        from src.pipelines.yolov8_pipeline import run_yolov8_pipeline
        yolo = _get_yolo()
        stride = stride_correction_m if stride_correction_m != 0.0 else None
        manual_dist = mound_distance_m if mound_distance_m and mound_distance_m > 0 else None
        if manual_dist is None:
            _job_push_log(job_id, "INFO", "📐 未指定投打距離，將由管線自動估算（pose-based）")

        all_speed_info = run_yolov8_pipeline(
            video_paths=[str(pipeline_input)],
            weights_path=YOLO_WEIGHTS,
            output_path=str(output_path),
            show_preview=False,
            enable_speed_calculation=True,
            manual_distance_meters=manual_dist,
            stride_correction=stride,
            conf=conf_threshold,
            debug=False,
            output_scale=1.0,
            batter_height_m=batter_height_m,
            strike_zone=strike_zone,
        )

        speed_info: dict = all_speed_info[0] if all_speed_info else {}

        original_dest = LOCAL_ORIGINALS / f"{job_id}.mp4"
        shutil.copy2(str(input_path), str(original_dest))

        overlay_url: Optional[str] = None
        if output_path.exists() and output_path.stat().st_size > 0:
            dest = LOCAL_OVERLAYS / f"{job_id}.mp4"
            _need_reencode = True
            try:
                import subprocess as _sp
                _probe = _sp.run(
                    ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
                     "-show_entries", "stream=codec_name", "-of", "default=nw=1",
                     str(output_path)],
                    capture_output=True, text=True, timeout=10,
                )
                if "h264" in _probe.stdout.lower() or "avc" in _probe.stdout.lower():
                    _need_reencode = False
            except Exception:
                pass

            if _need_reencode:
                h264_path = tmpdir_path / "overlay_h264.mp4"
                upload_path = h264_path if _reencode_h264(output_path, h264_path) else output_path
            else:
                upload_path = output_path

            shutil.copy2(str(upload_path), str(dest))
            if dest.exists() and dest.stat().st_size > 0:
                overlay_url = f"{base_url}/overlays/{job_id}.mp4"

        def _safe(v):
            import numpy as np
            if isinstance(v, (np.integer, np.int64, np.int32)): return int(v)
            if isinstance(v, (np.floating, np.float64, np.float32)): return float(v)
            if isinstance(v, np.ndarray): return v.tolist()
            if isinstance(v, tuple): return list(v)
            return v

        _PRIVATE_KEYS = {"frame_details", "_video_path", "_rotate_code", "_raw_detections_pose"}
        safe_speed_info = {k: _safe(v) for k, v in speed_info.items()
                           if k not in _PRIVATE_KEYS and not k.startswith("_")}

        _method = safe_speed_info.get("calculation_method")
        _nframes = safe_speed_info.get("num_frames", 0)
        _insufficient = (
            (_method == "theoretical" and _nframes < 5) or
            (_method == "pixel_based"  and _nframes < 3) or
            (_method is None and not safe_speed_info.get("release_speed_kmh"))
        )
        if _insufficient:
            _SPEED_KEYS = {
                "release_speed_kmh", "initial_speed_kmh", "max_speed_kmh",
                "average_speed_kmh", "pixel_release_speed_kmh",
                "flight_time_s", "spin_rpm",
            }
            for k in _SPEED_KEYS:
                safe_speed_info.pop(k, None)
            safe_speed_info["no_ball_detected"] = True

        created_at = datetime.utcnow().isoformat() + "Z"
        payload = {
            "job_id":       job_id,
            "overlay_url":  overlay_url,
            "original_url": f"{base_url}/original/{job_id}.mp4",
            "logs_url":     f"{base_url}/jobs/{job_id}/logs",
            "speed_info":   safe_speed_info,
            "created_at":   created_at,
        }

        _history_append({**payload, "filename": filename,
                         "mound_distance_m": mound_distance_m})

        _job_push_log(job_id, "INFO", "✅ 分析完成！")
        _job_set_status(job_id, "done", result=payload)

    except Exception as exc:
        err_msg = str(exc)
        log.error("Job %s – pipeline error: %s\n%s", job_id, exc, traceback.format_exc())
        _job_push_log(job_id, "ERROR", f"❌ 分析失敗：{err_msg}")
        _job_set_status(job_id, "error", error=err_msg)

    finally:
        root_logger.removeHandler(handler)
        _job_finish_log(job_id)
        try:
            shutil.rmtree(str(tmpdir_path), ignore_errors=True)
        except Exception:
            pass


@app.post("/analyze")
async def analyze(
    request: Request,
    video: UploadFile = File(...),
    mound_distance_m: float = Form(0.0),
    stride_correction_m: float = Form(0.0),
    conf_threshold: float = Form(0.05),
    batter_height_m: Optional[float] = Form(None),
    zone_x_min: Optional[float] = Form(None),
    zone_x_max: Optional[float] = Form(None),
    zone_y_min: Optional[float] = Form(None),
    zone_y_max: Optional[float] = Form(None),
):
    content_length = video.size
    if content_length and content_length > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"File too large. Max {MAX_UPLOAD_MB} MB.")

    job_id = str(uuid.uuid4())
    log.info("Job %s – received: %s (%.2f MB)",
             job_id, video.filename, (content_length or 0) / 1024 / 1024)

    data = await video.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_MB} MB.")

    tmpdir_path = Path(tempfile.mkdtemp(prefix=f"speedgun_{job_id}_"))
    input_path  = tmpdir_path / "input.mp4"
    output_path = tmpdir_path / "overlay.mp4"
    input_path.write_bytes(data)

    base_url = _resolve_base_url(request)
    filename = video.filename or "video.mp4"

    _job_create(job_id)

    # Assemble per-job strike-zone override if the caller sent all four bounds.
    strike_zone_override: Optional[dict] = None
    if None not in (zone_x_min, zone_x_max, zone_y_min, zone_y_max):
        if (0.0 <= zone_x_min < zone_x_max <= 1.0 and
                0.0 <= zone_y_min < zone_y_max <= 1.0):
            strike_zone_override = {
                "x_min": float(zone_x_min),
                "x_max": float(zone_x_max),
                "y_min": float(zone_y_min),
                "y_max": float(zone_y_max),
            }
            log.info("Job %s – strike_zone override: %s", job_id, strike_zone_override)

    resolved_batter_height_m = None
    if batter_height_m is not None and 1.0 <= batter_height_m <= 2.4:
        resolved_batter_height_m = float(batter_height_m)
        log.info("Job %s – batter_height_m: %.2f", job_id, resolved_batter_height_m)

    t = threading.Thread(
        target=_run_pipeline_thread,
        args=(job_id, input_path, tmpdir_path, output_path, base_url,
              mound_distance_m, stride_correction_m, conf_threshold, filename,
              resolved_batter_height_m, strike_zone_override),
        daemon=True,
    )
    t.start()

    log.info("Job %s – pipeline started in background thread", job_id)

    return JSONResponse(content={"job_id": job_id, "status": "pending"})


@app.get("/history")
async def history(limit: int = 20):
    records = _history_load()
    return JSONResponse(content={"records": records[:limit]})


@app.delete("/history")
async def history_clear():
    """Clear persisted job history (local dev server). Matches mobile 'clear all' UX for web."""
    if LOCAL_HISTORY.exists():
        try:
            LOCAL_HISTORY.unlink()
        except OSError:
            pass
    return JSONResponse(content={"ok": True})


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
