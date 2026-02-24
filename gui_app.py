import logging
import os
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import List, Optional
import cv2
from PIL import Image, ImageTk
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import numpy as np
import subprocess
import shutil

log = logging.getLogger(__name__)

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    from src.pipelines.yolov8_pipeline import run_yolov8_pipeline
    from src.utils import kmh_to_mph
except ImportError:
    pass


class SpeedgunApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Speedgun Mobile Pro")
        self.geometry("1440x900")
        self.minsize(1200, 760)

        # Platform-aware fonts
        if sys.platform == "darwin":
            self.font_ui   = "SF Pro Display"
            self.font_mono = "SF Mono"
        elif sys.platform == "win32":
            self.font_ui   = "Segoe UI"
            self.font_mono = "Consolas"
        else:
            self.font_ui   = "DejaVu Sans"
            self.font_mono = "DejaVu Sans Mono"

        # Color palette
        self.colors = {
            "bg":      "#0d1117",
            "surface": "#161b22",
            "card":    "#1a2236",
            "border":  "#21262d",
            "accent":  "#58a6ff",   # blue – primary
            "orange":  "#f0883e",   # speed highlight
            "green":   "#3fb950",
            "yellow":  "#d29922",
            "red":     "#f85149",
            "text":    "#e6edf3",
            "subtext": "#8b949e",
            "muted":   "#30363d",
        }
        self.configure(bg=self.colors["bg"])

        # State variables
        self.video_paths: List[str] = []
        self.pipeline_running = False
        self.status_msg       = tk.StringVar(value="Ready to analyze.")
        self.yolov8_weights   = tk.StringVar(value=os.path.join("yolov8", "best_baseball.pt"))
        self.pitch_dist       = tk.DoubleVar(value=18.44)
        self.stride_correction = tk.DoubleVar(value=1.7)
        self.result_data      = {}
        self._cached_details  = []

        # Playback state
        self.is_playing          = False
        self.cap                 = None
        self.video_total_frames  = 0
        self.video_fps           = 30
        self.current_frame_idx   = 0
        self.playback_speed      = 1.0
        self._seeking            = False
        self._playback_start_time  = 0.0
        self._playback_start_frame = 0

        self._setup_styles()
        self._build_ui()

    # ── Styles ──────────────────────────────────────────────────────────
    def _setup_styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        c, f = self.colors, self.font_ui

        style.configure("TFrame",         background=c["bg"])
        style.configure("Surface.TFrame", background=c["surface"])
        style.configure("Card.TFrame",    background=c["card"])

        style.configure("TLabel",
            background=c["bg"], foreground=c["text"], font=(f, 10))
        style.configure("Surface.TLabel",
            background=c["surface"], foreground=c["text"], font=(f, 10))

        style.configure("TEntry",
            fieldbackground=c["card"], foreground=c["text"],
            insertcolor=c["text"], borderwidth=1,
            relief="solid", padding=7)
        style.map("TEntry",
            bordercolor=[("focus", c["accent"]), ("!focus", c["border"])])

        style.configure("TCombobox",
            fieldbackground=c["card"], background=c["card"],
            foreground=c["text"], selectbackground=c["accent"],
            selectforeground=c["bg"], borderwidth=1, padding=4)
        style.map("TCombobox",
            fieldbackground=[("readonly", c["card"])],
            bordercolor=[("focus", c["accent"]), ("!focus", c["border"])])

        style.configure("Timeline.Horizontal.TScale",
            background=c["surface"], troughcolor=c["muted"],
            sliderthickness=14, sliderlength=14)

    # ── UI Builder ───────────────────────────────────────────────────────
    def _build_ui(self):
        c = self.colors

        # ── Header ──────────────────────────────────────────────────────
        hdr = tk.Frame(self, bg=c["surface"], height=56)
        hdr.pack(side="top", fill="x")
        hdr.pack_propagate(False)

        tk.Label(hdr, text="SPEEDGUN", font=(self.font_mono, 15, "bold"),
                 bg=c["surface"], fg=c["text"]).pack(side="left", padx=(20, 0))
        tk.Label(hdr, text="  MOBILE PRO", font=(self.font_mono, 10),
                 bg=c["surface"], fg=c["subtext"]).pack(side="left")

        # Status badge (right)
        badge = tk.Frame(hdr, bg=c["surface"])
        badge.pack(side="right", padx=20)
        self._status_dot = tk.Label(badge, text="●", font=(self.font_ui, 11),
                                     bg=c["surface"], fg=c["green"])
        self._status_dot.pack(side="left", padx=(0, 6))
        self.lbl_status = tk.Label(badge, textvariable=self.status_msg,
                                    font=(self.font_ui, 9),
                                    bg=c["surface"], fg=c["subtext"])
        self.lbl_status.pack(side="left")

        # Accent separator
        tk.Frame(self, bg=c["accent"], height=2).pack(side="top", fill="x")

        # ── Main Row ────────────────────────────────────────────────────
        main = tk.Frame(self, bg=c["bg"])
        main.pack(side="top", fill="both", expand=True)

        self._build_sidebar(main).pack(side="left", fill="y")
        self._build_metrics_panel(main).pack(side="right", fill="y")
        self._build_video_area(main).pack(side="left", fill="both", expand=True, padx=1)

        # ── Chart Panel ─────────────────────────────────────────────────
        chart_wrap = tk.Frame(self, bg=c["surface"])
        chart_wrap.pack(side="bottom", fill="x")
        self._setup_charts(chart_wrap)

    # ── Sidebar ─────────────────────────────────────────────────────────
    def _build_sidebar(self, parent):
        c, f = self.colors, self.font_ui
        sidebar = tk.Frame(parent, bg=c["surface"], width=264)
        sidebar.pack_propagate(False)

        inner = tk.Frame(sidebar, bg=c["surface"], padx=16)
        inner.pack(fill="both", expand=True, pady=16)

        self._section_lbl(inner, "INPUT")

        self.btn_select = self._ghost_btn(inner, "📂  Select Video…", self.select_video)
        self.btn_select.pack(fill="x", pady=(6, 0))

        self.lbl_filename = tk.Label(inner, text="No file selected",
                                      font=(f, 9), bg=c["surface"], fg=c["subtext"],
                                      wraplength=224, anchor="w", justify="left")
        self.lbl_filename.pack(fill="x", pady=(6, 14))

        self._divider(inner)
        self._section_lbl(inner, "PARAMETERS")

        for label, var in [
            ("Mound Distance (m)",  self.pitch_dist),
            ("Stride Correction (m)", self.stride_correction),
        ]:
            tk.Label(inner, text=label, font=(f, 9),
                     bg=c["surface"], fg=c["subtext"]).pack(anchor="w", pady=(10, 3))
            ttk.Entry(inner, textvariable=var).pack(fill="x")

        tk.Label(inner, text="Effective = Mound − Stride",
                 font=(f, 8), bg=c["surface"], fg=c["muted"]).pack(anchor="w", pady=(3, 0))

        tk.Label(inner, text="YOLO Weights", font=(f, 9),
                 bg=c["surface"], fg=c["subtext"]).pack(anchor="w", pady=(12, 3))
        ttk.Entry(inner, textvariable=self.yolov8_weights).pack(fill="x")

        self._divider(inner)

        # Analyze button pinned to bottom
        spacer = tk.Frame(inner, bg=c["surface"])
        spacer.pack(fill="both", expand=True)

        self.btn_run = tk.Button(
            inner, text="▶  START ANALYSIS",
            font=(f, 11, "bold"),
            bg=c["accent"], fg=c["bg"],
            activebackground="#79b8ff", activeforeground=c["bg"],
            relief="flat", bd=0, cursor="hand2", pady=13,
            command=self.run_analysis)
        self.btn_run.pack(fill="x", pady=(0, 4))

        return sidebar

    # ── Video Area ──────────────────────────────────────────────────────
    def _build_video_area(self, parent):
        c, f = self.colors, self.font_ui
        area = tk.Frame(parent, bg=c["bg"])

        self.video_canvas = tk.Canvas(area, bg="#000000", highlightthickness=0)
        self.video_canvas.pack(fill="both", expand=True)

        # Controls bar
        ctrl = tk.Frame(area, bg=c["surface"])
        ctrl.pack(fill="x", side="bottom")

        # Timeline row
        tl_row = tk.Frame(ctrl, bg=c["surface"])
        tl_row.pack(fill="x", padx=14, pady=(8, 2))

        self.timeline_var = tk.IntVar(value=0)
        self.timeline_slider = ttk.Scale(
            tl_row, from_=0, to=100, orient="horizontal",
            variable=self.timeline_var, style="Timeline.Horizontal.TScale",
            command=self._on_timeline_change)
        self.timeline_slider.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.timeline_slider.state(["disabled"])

        self.lbl_time = tk.Label(tl_row, text="0:00 / 0:00",
                                  font=(self.font_mono, 9),
                                  bg=c["surface"], fg=c["subtext"], width=14, anchor="e")
        self.lbl_time.pack(side="right")

        # Button row
        btn_row = tk.Frame(ctrl, bg=c["surface"])
        btn_row.pack(fill="x", padx=10, pady=(2, 8))

        for text, cmd, attr, w in [
            ("⏮", self._prev_frame,  "btn_prev_frame", 3),
            ("▶  PLAY", self.play_video, "btn_play",   10),
            ("⏭", self._next_frame,  "btn_next_frame", 3),
        ]:
            btn = tk.Button(btn_row, text=text, width=w,
                            font=(f, 10),
                            bg=c["card"], fg=c["text"],
                            activebackground=c["muted"], activeforeground=c["text"],
                            relief="flat", bd=0, cursor="hand2",
                            disabledforeground=c["muted"],
                            command=cmd, state="disabled")
            btn.pack(side="left", padx=2)
            setattr(self, attr, btn)

        tk.Label(btn_row, text="Speed", font=(f, 9),
                 bg=c["surface"], fg=c["subtext"]).pack(side="left", padx=(18, 4))
        self.speed_var = tk.StringVar(value="1.0x")
        speed_combo = ttk.Combobox(btn_row, textvariable=self.speed_var, width=5,
                                    values=["0.1x", "0.25x", "0.5x", "1.0x", "1.5x", "2.0x"],
                                    state="readonly")
        speed_combo.pack(side="left")
        speed_combo.bind("<<ComboboxSelected>>", self._on_speed_change)

        self.lbl_frame_info = tk.Label(btn_row, text="",
                                        font=(self.font_mono, 8),
                                        bg=c["surface"], fg=c["muted"])
        self.lbl_frame_info.pack(side="right", padx=8)

        return area

    # ── Metrics Panel ────────────────────────────────────────────────────
    def _build_metrics_panel(self, parent):
        c = self.colors
        panel = tk.Frame(parent, bg=c["surface"], width=248)
        panel.pack_propagate(False)

        inner = tk.Frame(panel, bg=c["surface"], padx=14)
        inner.pack(fill="both", expand=True, pady=16)

        self._section_lbl(inner, "RESULTS")

        self._metric_card(inner, "BALL SPEED",  "result_release_speed",
                          "—", c["orange"], title_attr="lbl_speed_title")
        self._metric_card(inner, "MAX SPEED",   "result_max_speed",
                          "—", c["accent"])
        self._metric_card(inner, "DISTANCE",    "result_distance",
                          "—", c["green"])
        return panel

    # ── Chart Panel ───────────────────────────────────────────────────────
    def _setup_charts(self, parent):
        c = self.colors

        # Section header inside chart panel
        hdr = tk.Frame(parent, bg=c["surface"])
        hdr.pack(fill="x", padx=14, pady=(10, 0))
        self._section_lbl(hdr, "VELOCITY ANALYSIS")
        tk.Label(hdr, text="click chart to expand",
                 font=(self.font_ui, 8), bg=c["surface"], fg=c["muted"]).pack(side="right")

        self.fig, (self.ax_bar, self.ax_delta) = plt.subplots(
            1, 2, figsize=(10, 2.2), dpi=100,
            gridspec_kw={"width_ratios": [3, 2]})
        self.fig.patch.set_facecolor(c["surface"])
        self.fig.subplots_adjust(left=0.07, right=0.97, bottom=0.22, top=0.82, wspace=0.3)

        for ax in (self.ax_bar, self.ax_delta):
            ax.set_facecolor(c["card"])
            ax.tick_params(colors=c["subtext"], labelsize=7)
            for spine in ax.spines.values():
                spine.set_color(c["border"])
            ax.xaxis.label.set_color(c["subtext"])
            ax.yaxis.label.set_color(c["subtext"])

        self.ax_bar.set_title("Speed per Frame", color=c["text"], fontsize=9, fontweight="bold")
        self.ax_delta.set_title("Speed Change (Δ km/h)", color=c["text"], fontsize=9, fontweight="bold")

        self.chart_canvas = FigureCanvasTkAgg(self.fig, master=parent)
        self.chart_canvas.draw()
        self.chart_canvas.get_tk_widget().pack(fill="both", expand=True, padx=8, pady=(4, 10))
        self.chart_canvas.get_tk_widget().bind("<Button-1>", lambda e: self._open_detail_chart())

    # ── Widget helpers ────────────────────────────────────────────────────
    def _section_lbl(self, parent, text):
        tk.Label(parent, text=text, font=(self.font_ui, 8, "bold"),
                 bg=self.colors["surface"], fg=self.colors["muted"],
                 anchor="w").pack(fill="x", pady=(10, 4))

    def _divider(self, parent):
        tk.Frame(parent, bg=self.colors["border"], height=1).pack(fill="x", pady=(8, 0))

    def _ghost_btn(self, parent, text, command):
        c = self.colors
        return tk.Button(parent, text=text, font=(self.font_ui, 10),
                         bg=c["card"], fg=c["text"],
                         activebackground=c["muted"], activeforeground=c["text"],
                         relief="flat", bd=0, cursor="hand2", pady=8,
                         command=command)

    def _metric_card(self, parent, title, var_name, default, accent_color, title_attr=None):
        c = self.colors
        card = tk.Frame(parent, bg=c["card"])
        card.pack(fill="x", pady=5)

        # Colored left accent bar
        tk.Frame(card, bg=accent_color, width=3).pack(side="left", fill="y")

        content = tk.Frame(card, bg=c["card"], padx=12, pady=10)
        content.pack(side="left", fill="both", expand=True)

        lbl_title = tk.Label(content, text=title,
                              font=(self.font_ui, 8, "bold"),
                              bg=c["card"], fg=c["subtext"], anchor="w")
        lbl_title.pack(fill="x")
        if title_attr:
            setattr(self, title_attr, lbl_title)

        setattr(self, var_name, tk.StringVar(value=default))
        tk.Label(content, textvariable=getattr(self, var_name),
                 font=(self.font_mono, 20, "bold"),
                 bg=c["card"], fg=accent_color,
                 anchor="w", justify="left").pack(fill="x", pady=(2, 0))

    # ── Video File Selection ──────────────────────────────────────────────
    def select_video(self):
        path = filedialog.askopenfilename(filetypes=[("Video", "*.mp4 *.avi *.mov")])
        if path:
            self.video_paths = [path]
            self.lbl_filename.config(text=os.path.basename(path))
            self.status_msg.set("Video loaded. Click 'Start Analysis'.")
            self._show_preview_frame(path)

    def _show_preview_frame(self, video_path):
        cap = cv2.VideoCapture(video_path)
        ret, frame = cap.read()
        if ret:
            self._update_video_canvas(frame)
        cap.release()

    # ── Video Playback ────────────────────────────────────────────────────
    def _init_video_capture(self, path: str):
        if self.cap and self.cap.isOpened():
            self.cap.release()
        self.cap = cv2.VideoCapture(path)
        self.video_total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.video_fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.current_frame_idx = 0
        self.timeline_slider.config(to=max(1, self.video_total_frames - 1))
        self.timeline_var.set(0)
        self._update_time_label()

    def play_video(self):
        if not hasattr(self, "current_output_path") or not self.current_output_path:
            return
        if self.is_playing:
            self.is_playing = False
            self.btn_play.config(text="▶  PLAY")
            return
        if self.cap and self.current_frame_idx >= self.video_total_frames - 1:
            self._seek_to_frame(0)
        if not self.cap or not self.cap.isOpened():
            self._init_video_capture(self.current_output_path)
        self.is_playing = True
        self.btn_play.config(text="⏸  PAUSE")
        self._playback_start_time  = time.perf_counter()
        self._playback_start_frame = self.current_frame_idx
        self._video_loop()

    def _video_loop(self):
        if not self.is_playing:
            return
        if not self.cap or not self.cap.isOpened():
            return
        if self._seeking:
            self.after(50, self._video_loop)
            return

        now     = time.perf_counter()
        elapsed = now - self._playback_start_time
        target  = self._playback_start_frame + int(elapsed * self.video_fps * self.playback_speed)
        target  = min(target, self.video_total_frames - 1)

        if target > self.current_frame_idx + 1:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, target)

        ret, frame = self.cap.read()
        if ret:
            self.current_frame_idx = int(self.cap.get(cv2.CAP_PROP_POS_FRAMES))
            self._update_video_canvas(frame)
            self._seeking = True
            self.timeline_var.set(self.current_frame_idx)
            self._seeking = False
            self._update_time_label()

            if self.current_frame_idx >= self.video_total_frames - 1:
                self.is_playing = False
                self.btn_play.config(text="↺  REPLAY")
                return

            next_f    = self.current_frame_idx - self._playback_start_frame + 1
            next_time = self._playback_start_time + next_f / (self.video_fps * self.playback_speed)
            delay_ms  = max(1, int((next_time - time.perf_counter()) * 1000))
            self.after(delay_ms, self._video_loop)
        else:
            self.is_playing = False
            self.btn_play.config(text="↺  REPLAY")

    def _seek_to_frame(self, frame_idx: int):
        if not self.cap or not self.cap.isOpened():
            return
        frame_idx = max(0, min(frame_idx, self.video_total_frames - 1))
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = self.cap.read()
        if ret:
            self.current_frame_idx = frame_idx
            self._update_video_canvas(frame)
            self._update_time_label()

    def _on_timeline_change(self, value):
        if self._seeking:
            return
        frame = int(float(value))
        was_playing = self.is_playing
        if was_playing:
            self.is_playing = False
        self._seeking = True
        self._seek_to_frame(frame)
        self._seeking = False
        if was_playing:
            self.is_playing = True
            self._playback_start_time  = time.perf_counter()
            self._playback_start_frame = self.current_frame_idx
            self._video_loop()

    def _on_speed_change(self, _event=None):
        txt = self.speed_var.get().replace("x", "")
        try:
            self.playback_speed = float(txt)
        except ValueError:
            self.playback_speed = 1.0
        if self.is_playing:
            self._playback_start_time  = time.perf_counter()
            self._playback_start_frame = self.current_frame_idx

    def _prev_frame(self):
        self.is_playing = False
        self.btn_play.config(text="▶  PLAY")
        self._seek_to_frame(max(0, self.current_frame_idx - 2))
        self.timeline_var.set(self.current_frame_idx)

    def _next_frame(self):
        self.is_playing = False
        self.btn_play.config(text="▶  PLAY")
        self._seek_to_frame(self.current_frame_idx)
        self.timeline_var.set(self.current_frame_idx)

    def _update_time_label(self):
        cur_sec   = self.current_frame_idx / self.video_fps if self.video_fps else 0
        total_sec = self.video_total_frames / self.video_fps if self.video_fps else 0
        cm, cs    = divmod(int(cur_sec),   60)
        tm, ts    = divmod(int(total_sec), 60)
        self.lbl_time.config(text=f"{cm}:{cs:02d} / {tm}:{ts:02d}")
        self.lbl_frame_info.config(text=f"Frame {self.current_frame_idx} / {self.video_total_frames}")

    def _update_video_canvas(self, frame):
        cw = self.video_canvas.winfo_width()
        ch = self.video_canvas.winfo_height()
        if cw < 10 or ch < 10:
            cw, ch = 800, 450

        img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(img)
        iw, ih = pil.size
        ratio  = min(cw / iw, ch / ih)
        pil    = pil.resize((int(iw * ratio), int(ih * ratio)), Image.Resampling.LANCZOS)

        if hasattr(self, "_tk_image_id") and self._tk_image_id:
            self.video_canvas.delete(self._tk_image_id)
        self.tk_image   = ImageTk.PhotoImage(pil)
        self._tk_image_id = self.video_canvas.create_image(
            cw // 2, ch // 2, anchor="center", image=self.tk_image)

    # ── Video Preprocessing ───────────────────────────────────────────────
    def _get_video_properties(self, video_path: str) -> tuple:
        try:
            cap = cv2.VideoCapture(video_path)
            if not cap.isOpened():
                return None, None, None
            fps    = cap.get(cv2.CAP_PROP_FPS)
            width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cap.release()
            return fps, width, height
        except Exception as e:
            log.warning("Error reading video properties: %s", e)
            return None, None, None

    def _check_and_preprocess_video(self, video_path: str) -> Optional[str]:
        fps, width, height = self._get_video_properties(video_path)
        if fps is None:
            return None
        if fps == 120 and width == 3840 and height == 2160:
            log.info("Video already 120fps/4K, skipping preprocessing")
            return None

        log.info("Preprocessing: fps=%s %dx%d", fps, width, height)
        if shutil.which("ffmpeg") is None:
            self.after(0, lambda: messagebox.showwarning(
                "FFmpeg Not Found",
                "ffmpeg is not installed. Analysis will use the original video."))
            return None

        video_dir  = os.path.dirname(video_path)
        video_name = os.path.splitext(os.path.basename(video_path))[0]
        out_path   = os.path.join(video_dir, f"{video_name}_120fps_4k.mp4")

        if os.path.exists(out_path):
            return out_path

        try:
            scale_pad = "scale=3840:-2,pad=3840:2160:(3840-iw)/2:(2160-ih)/2"
            vf = f"minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,{scale_pad}"
            cmd = ["ffmpeg", "-y", "-i", video_path, "-vf", vf,
                   "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                   "-c:a", "copy", out_path]
            self.after(0, lambda: self.status_msg.set("Preprocessing video…"))
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if proc.returncode != 0:
                log.error("FFmpeg error: %s", proc.stdout)
                return None
            return out_path
        except Exception:
            log.exception("Preprocessing error")
            return None

    # ── Analysis ──────────────────────────────────────────────────────────
    def run_analysis(self):
        if not self.video_paths:
            messagebox.showwarning("Warning", "Please select a video first.")
            return
        self.pipeline_running = True
        self.btn_run.config(state="disabled", text="ANALYZING…")
        self.btn_select.config(state="disabled")
        self.btn_play.config(state="disabled")
        self._status_dot.config(fg=self.colors["yellow"])
        self.status_msg.set("Checking video format…")

        snapshot = {
            "video_path":       self.video_paths[0],
            "weights_path":     os.path.abspath(self.yolov8_weights.get()),
            "pitch_dist":       self.pitch_dist.get(),
            "stride_correction": self.stride_correction.get(),
        }
        threading.Thread(target=self._worker_thread, args=(snapshot,), daemon=True).start()

    def _worker_thread(self, params: dict):
        try:
            video = params["video_path"]
            self.after(0, lambda: self.status_msg.set("Checking video format…"))
            preprocessed = self._check_and_preprocess_video(video)
            if preprocessed:
                video = preprocessed
                self.after(0, lambda: self.status_msg.set("Preprocessed. Initializing model…"))
            else:
                self.after(0, lambda: self.status_msg.set("Initializing AI model…"))

            output_path = os.path.join(os.path.dirname(video), "Overlay_Pro.mp4")
            results = run_yolov8_pipeline(
                [video],
                weights_path=params["weights_path"],
                output_path=output_path,
                manual_distance_meters=params["pitch_dist"],
                stride_correction=params["stride_correction"],
                show_preview=False,
                debug=True,
            )
            if results:
                data = results[0]
                self.after(0, lambda: self._update_ui_with_results(data, output_path))
            else:
                self.after(0, lambda: messagebox.showwarning(
                    "No Data", "Could not detect enough ball trajectory."))
        except Exception as e:
            log.exception("Analysis failed")
            err = str(e)
            self.after(0, lambda: messagebox.showerror("Error", err))
        finally:
            self.after(0, self._reset_ui_state)

    def _update_ui_with_results(self, data: dict, output_path: str):
        def fmt(kmh):
            if kmh is None:
                return "N/A"
            mph = kmh_to_mph(kmh)
            return f"{kmh:.1f} km/h\n({mph:.1f} mph)"

        rel  = data.get("release_speed_kmh")
        init = data.get("initial_speed_kmh")
        if rel:
            self.result_release_speed.set(fmt(rel))
            if hasattr(self, "lbl_speed_title"):
                self.lbl_speed_title.config(text="BALL SPEED")
        elif init:
            self.result_release_speed.set(fmt(init))
            if hasattr(self, "lbl_speed_title"):
                self.lbl_speed_title.config(text="SPEED")
        else:
            self.result_release_speed.set("N/A")

        self.result_max_speed.set(fmt(data.get("max_speed_kmh", 0)))
        dist = data.get("effective_distance_m") or data.get("total_distance_m", 0)
        self.result_distance.set(f"{dist:.1f} m")

        details = data.get("frame_details", [])
        if details:
            self._render_velocity_charts(details)

        self._status_dot.config(fg=self.colors["green"])
        self.status_msg.set(f"Done ✓  {os.path.basename(output_path)}")

        self.current_output_path = output_path
        self._init_video_capture(output_path)
        self._seek_to_frame(0)
        self.btn_play.config(state="normal", text="▶  PLAY")
        self.btn_prev_frame.config(state="normal")
        self.btn_next_frame.config(state="normal")
        self.timeline_slider.state(["!disabled"])

    # ── Charts ────────────────────────────────────────────────────────────
    def _render_velocity_charts(self, details: list):
        self._cached_details = details
        c = self.colors
        frames = [d["frame"] for d in details]
        speeds = [d["speed_kmh"] for d in details]

        # Left: bar chart
        ax = self.ax_bar
        ax.clear()
        ax.set_facecolor(c["card"])
        for sp in ax.spines.values():
            sp.set_color(c["border"])
        ax.tick_params(colors=c["subtext"], labelsize=7)

        s_min, s_max = min(speeds), max(speeds)
        norm = [(s - s_min) / (s_max - s_min + 1e-6) for s in speeds]
        bar_colors = [plt.cm.plasma(0.2 + 0.7 * n) for n in norm]

        bars = ax.bar(frames, speeds, color=bar_colors, width=0.8, edgecolor="none")
        pad  = max(0.5, (s_max - s_min) * 0.3)
        ax.set_ylim(max(0, s_min - pad), s_max + pad)

        for bar, spd in zip(bars, speeds):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                    f"{spd:.1f}", ha="center", va="bottom",
                    color="white", fontsize=6, fontweight="bold")

        ax.set_xlabel("Frame", fontsize=7, color=c["subtext"])
        ax.set_ylabel("Speed (km/h)", fontsize=7, color=c["subtext"])
        ax.set_title("Speed per Frame", color=c["text"], fontsize=9, fontweight="bold")
        ax.grid(True, axis="y", color=c["border"], linestyle="--", alpha=0.5)

        # Right: delta chart
        ax2 = self.ax_delta
        ax2.clear()
        ax2.set_facecolor(c["card"])
        for sp in ax2.spines.values():
            sp.set_color(c["border"])
        ax2.tick_params(colors=c["subtext"], labelsize=7)

        if len(speeds) > 1:
            deltas = [speeds[i + 1] - speeds[i] for i in range(len(speeds) - 1)]
            dframes = frames[1:]
            dcolors = [c["green"] if d >= 0 else c["red"] for d in deltas]
            bars2 = ax2.bar(dframes, deltas, color=dcolors, width=0.8, edgecolor="none")
            for bar, d in zip(bars2, deltas):
                y   = bar.get_height() if d >= 0 else bar.get_y()
                va  = "bottom" if d >= 0 else "top"
                ax2.text(bar.get_x() + bar.get_width() / 2, y,
                         f"{d:+.2f}", ha="center", va=va,
                         color="white", fontsize=6, fontweight="bold")
            ax2.axhline(y=0, color=c["muted"], linewidth=0.8)
            d_max = max(abs(d) for d in deltas) if deltas else 0.5
            ax2.set_ylim(-max(d_max, 0.1) * 1.5, max(d_max, 0.1) * 1.5)

        ax2.set_xlabel("Frame", fontsize=7, color=c["subtext"])
        ax2.set_ylabel("Δ km/h", fontsize=7, color=c["subtext"])
        ax2.set_title("Speed Change (Δ km/h)", color=c["text"], fontsize=9, fontweight="bold")
        ax2.grid(True, axis="y", color=c["border"], linestyle="--", alpha=0.5)

        self.chart_canvas.draw()

    # ── Detail Popup ──────────────────────────────────────────────────────
    def _open_detail_chart(self):
        if not self._cached_details:
            return
        c = self.colors
        details = self._cached_details
        frames  = [d["frame"] for d in details]
        speeds  = [d["speed_kmh"] for d in details]

        popup = tk.Toplevel(self)
        popup.title("Velocity Breakdown — Detail View")
        popup.geometry("1050x680")
        popup.configure(bg=c["bg"])
        popup.grab_set()

        # Header
        hdr = tk.Frame(popup, bg=c["surface"], height=48)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)
        tk.Label(hdr, text="VELOCITY DETAIL", font=(self.font_mono, 13, "bold"),
                 bg=c["surface"], fg=c["accent"]).pack(side="left", padx=20, pady=12)
        tk.Label(hdr, text="click data points for info",
                 font=(self.font_ui, 9), bg=c["surface"], fg=c["subtext"]).pack(side="left")
        tk.Frame(popup, bg=c["accent"], height=2).pack(fill="x")

        fig, (ax_top, ax_bot) = plt.subplots(2, 1, figsize=(10, 5.5), dpi=100,
                                              gridspec_kw={"height_ratios": [3, 2]})
        fig.patch.set_facecolor(c["bg"])
        fig.subplots_adjust(left=0.08, right=0.97, top=0.93, bottom=0.08, hspace=0.38)

        for ax in (ax_top, ax_bot):
            ax.set_facecolor(c["card"])
            for sp in ax.spines.values():
                sp.set_color(c["border"])
            ax.tick_params(colors=c["subtext"], labelsize=8)

        # Top: speed line
        ax_top.plot(frames, speeds, color=c["accent"], linewidth=2.5,
                    marker="o", markersize=5, markerfacecolor="white",
                    markeredgecolor=c["accent"], markeredgewidth=1.5, zorder=3)
        ax_top.fill_between(frames, speeds, color=c["accent"], alpha=0.07)

        avg = float(np.mean(speeds))
        ax_top.axhline(y=avg,        color=c["yellow"], lw=1, ls="--", alpha=0.7,
                       label=f"Avg: {avg:.1f} km/h")
        ax_top.axhline(y=max(speeds), color=c["green"],  lw=1, ls=":",  alpha=0.5,
                       label=f"Max: {max(speeds):.1f} km/h")
        ax_top.axhline(y=min(speeds), color=c["red"],    lw=1, ls=":",  alpha=0.5,
                       label=f"Min: {min(speeds):.1f} km/h")

        s_r = max(speeds) - min(speeds)
        pad = max(0.5, s_r * 0.4) if s_r < 2.0 else s_r * 0.15
        ax_top.set_ylim(min(speeds) - pad, max(speeds) + pad)
        ax_top.set_title("Speed vs Frame", color=c["text"], fontsize=11, fontweight="bold")
        ax_top.set_xlabel("Frame", fontsize=9, color=c["subtext"])
        ax_top.set_ylabel("Speed (km/h)", fontsize=9, color=c["subtext"])
        ax_top.grid(True, color=c["border"], ls="--", alpha=0.4)
        ax_top.legend(loc="upper right", fontsize=7,
                      facecolor=c["card"], edgecolor=c["border"], labelcolor=c["text"])

        # Bottom: delta
        if len(speeds) > 1:
            deltas   = [speeds[i + 1] - speeds[i] for i in range(len(speeds) - 1)]
            dframes  = frames[1:]
            dcolors  = [c["green"] if d >= 0 else c["red"] for d in deltas]
            ax_bot.bar(dframes, deltas, color=dcolors, width=0.7, alpha=0.75, edgecolor="none")
            ax_bot.plot(dframes, deltas, color="white", lw=1.2,
                        marker="D", markersize=3, alpha=0.8)
            ax_bot.axhline(y=0, color=c["muted"], lw=0.8)
            d_max = max(abs(d) for d in deltas) if deltas else 0.5
            ax_bot.set_ylim(-max(d_max, 0.1) * 1.8, max(d_max, 0.1) * 1.8)

        ax_bot.set_title("Frame-to-Frame Speed Change", color=c["text"], fontsize=11, fontweight="bold")
        ax_bot.set_xlabel("Frame", fontsize=9, color=c["subtext"])
        ax_bot.set_ylabel("Δ km/h", fontsize=9, color=c["subtext"])
        ax_bot.grid(True, color=c["border"], ls="--", alpha=0.4)

        # Annotation on click
        annot = ax_top.annotate(
            "", xy=(0, 0), xytext=(15, 15), textcoords="offset points",
            bbox=dict(boxstyle="round,pad=0.4", fc=c["card"], ec=c["accent"], lw=1.5),
            color=c["text"], fontsize=9, fontweight="bold", zorder=10)
        annot.set_visible(False)

        def on_click(event):
            if event.inaxes != ax_top:
                annot.set_visible(False)
                canvas.draw_idle()
                return
            if event.xdata is None:
                return
            idx = min(range(len(frames)), key=lambda i: abs(frames[i] - event.xdata))
            f, s = frames[idx], speeds[idx]
            mph  = kmh_to_mph(s)
            delta_txt = f"\nΔ: {speeds[idx]-speeds[idx-1]:+.2f} km/h" if idx > 0 else ""
            annot.xy = (f, s)
            annot.set_text(f"Frame {f}\n{s:.2f} km/h\n{mph:.1f} mph{delta_txt}")
            annot.set_visible(True)
            canvas.draw_idle()

        canvas = FigureCanvasTkAgg(fig, master=popup)
        canvas.draw()
        canvas.get_tk_widget().pack(fill="both", expand=True, padx=10, pady=(8, 0))
        canvas.mpl_connect("button_press_event", on_click)

        tk.Button(popup, text="CLOSE", font=(self.font_ui, 10, "bold"),
                  bg=c["accent"], fg=c["bg"], bd=0, padx=24, pady=8,
                  activebackground="#79b8ff", activeforeground=c["bg"],
                  cursor="hand2",
                  command=lambda: (plt.close(fig), popup.destroy())
                  ).pack(pady=12)

    # ── Reset ─────────────────────────────────────────────────────────────
    def _reset_ui_state(self):
        self.pipeline_running = False
        self.btn_run.config(state="normal", text="▶  START ANALYSIS")
        self.btn_select.config(state="normal")
        if not (hasattr(self, "current_output_path") and self.current_output_path):
            self._status_dot.config(fg=self.colors["red"])


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app = SpeedgunApp()
    app.mainloop()
