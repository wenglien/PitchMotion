import os
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import List, Optional
import cv2
from PIL import Image, ImageTk
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import numpy as np

# Adjust import path if needed
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    from src.pipelines.yolov8_pipeline import run_yolov8_pipeline
except ImportError:
    pass

class SpeedgunApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Speedgun Mobile - Pro Analysis Dashboard")
        self.geometry("1400x900")
        
        # Configure Dark Theme Colors
        self.colors = {
            "bg_dark": "#1e1e1e",
            "bg_panel": "#2d2d2d",
            "fg_text": "#ffffff",
            "fg_subtext": "#aaaaaa",
            "accent": "#3498db",
            "accent_hover": "#2980b9",
            "success": "#2ecc71",
            "warning": "#f1c40f",
            "danger": "#e74c3c"
        }
        
        self.configure(bg=self.colors["bg_dark"])
        self._setup_styles()
        
        # Data Variables
        self.video_paths: List[str] = []
        self.current_video_frame = None
        self.pipeline_running = False
        
        # UI State Variables
        self.status_msg = tk.StringVar(value="Ready to analyze.")
        self.yolov8_weights = tk.StringVar(value=os.path.join("yolov8", "best_baseball.pt"))
        self.pitch_dist = tk.DoubleVar(value=18.44)
        self.stride_correction = tk.DoubleVar(value=1.7)
        
        # Analysis Results
        self.result_data = {}
        self._cached_details = []  # Store frame_details for popup chart

        # Video Playback State
        self.is_playing = False
        self.cap = None
        self.video_total_frames = 0
        self.video_fps = 30
        self.current_frame_idx = 0
        self.playback_speed = 1.0          # Multiplier: 0.25x ~ 2x
        self._seeking = False              # True while user drags slider

        self._build_ui()
        
    def _setup_styles(self):
        style = ttk.Style(self)
        style.theme_use('clam')
        
        # General Frame
        style.configure("TFrame", background=self.colors["bg_dark"])
        style.configure("Panel.TFrame", background=self.colors["bg_panel"])
        
        # Labels
        style.configure("TLabel", background=self.colors["bg_dark"], foreground=self.colors["fg_text"], font=("Segoe UI", 10))
        style.configure("Panel.TLabel", background=self.colors["bg_panel"], foreground=self.colors["fg_text"])
        style.configure("Header.TLabel", font=("Segoe UI", 16, "bold"), background=self.colors["bg_dark"], foreground=self.colors["accent"])
        style.configure("SubHeader.TLabel", font=("Segoe UI", 12, "bold"), background=self.colors["bg_panel"], foreground=self.colors["fg_subtext"])
        
        # Metrics
        style.configure("MetricVal.TLabel", font=("Segoe UI", 24, "bold"), background=self.colors["bg_panel"], foreground=self.colors["accent"])
        style.configure("MetricLabel.TLabel", font=("Segoe UI", 10), background=self.colors["bg_panel"], foreground=self.colors["fg_subtext"])

        # Buttons
        style.configure("Accent.TButton", background=self.colors["accent"], foreground="white", borderwidth=0, font=("Segoe UI", 10, "bold"))
        style.map("Accent.TButton", background=[("active", self.colors["accent_hover"])])
        
        style.configure("TButton", background=self.colors["bg_panel"], foreground="white", borderwidth=1, font=("Segoe UI", 10))
        style.map("TButton", background=[("active", "#404040")])
        
        # Inputs
        style.configure("TEntry", fieldbackground="#404040", foreground="white", insertcolor="white")

        # Timeline Scale (slider)
        style.configure("Timeline.Horizontal.TScale",
                        background=self.colors["bg_panel"],
                        troughcolor="#404040")
        
    def _build_ui(self):
        # 1. Top Bar (Logo + Title)
        top_bar = ttk.Frame(self, height=60)
        top_bar.pack(side="top", fill="x", padx=20, pady=10)
        
        lbl_title = ttk.Label(top_bar, text="SPEEDGUN MOBILE PRO", style="Header.TLabel")
        lbl_title.pack(side="left")
        
        # 2. Main Container (Sidebar + Content)
        main_container = ttk.Frame(self)
        main_container.pack(fill="both", expand=True, padx=20, pady=(0, 20))
        
        # --- LEFT SIDEBAR (Controls) ---
        sidebar = ttk.Frame(main_container, width=300, style="Panel.TFrame")
        sidebar.pack(side="left", fill="y", padx=(0, 20))
        
        # Inner padding for sidebar
        sidebar_content = ttk.Frame(sidebar, style="Panel.TFrame", padding=15)
        sidebar_content.pack(fill="both", expand=True)
        
        ttk.Label(sidebar_content, text="CONFIGURATION", style="SubHeader.TLabel").pack(anchor="w", pady=(0, 15))
        
        # File Selection
        ttk.Label(sidebar_content, text="Input Video", style="MetricLabel.TLabel").pack(anchor="w")
        self.btn_select = ttk.Button(sidebar_content, text="Select Video...", command=self.select_video)
        self.btn_select.pack(fill="x", pady=(5, 15))
        
        self.lbl_filename = ttk.Label(sidebar_content, text="No file selected", style="MetricLabel.TLabel", wraplength=250)
        self.lbl_filename.pack(anchor="w", pady=(0, 20))
        
        ttk.Separator(sidebar_content, orient="horizontal").pack(fill="x", pady=10)
        
        # Parameters
        ttk.Label(sidebar_content, text="Mound Distance (m)", style="MetricLabel.TLabel").pack(anchor="w")
        entry_dist = ttk.Entry(sidebar_content, textvariable=self.pitch_dist)
        entry_dist.pack(fill="x", pady=(5, 10))

        ttk.Label(sidebar_content, text="Stride Correction (m)", style="MetricLabel.TLabel").pack(anchor="w")
        entry_stride = ttk.Entry(sidebar_content, textvariable=self.stride_correction)
        entry_stride.pack(fill="x", pady=(5, 5))
        ttk.Label(
            sidebar_content,
            text="Effective = Mound - Stride",
            style="MetricLabel.TLabel",
            foreground=self.colors["fg_subtext"],
        ).pack(anchor="w", pady=(0, 15))
        
        ttk.Label(sidebar_content, text="YOLO Model", style="MetricLabel.TLabel").pack(anchor="w")
        entry_model = ttk.Entry(sidebar_content, textvariable=self.yolov8_weights)
        entry_model.pack(fill="x", pady=(5, 15))
        
        # Action Button
        self.btn_run = ttk.Button(sidebar_content, text="START ANALYSIS", style="Accent.TButton", command=self.run_analysis)
        self.btn_run.pack(fill="x", pady=(20, 0), ipady=10)
        
        # Status Bar in Sidebar
        self.lbl_status = ttk.Label(sidebar_content, textvariable=self.status_msg, style="MetricLabel.TLabel", wraplength=250)
        self.lbl_status.pack(side="bottom", anchor="w", pady=10)

        # --- RIGHT CONTENT (Dashboard) ---
        content_area = ttk.Frame(main_container)
        content_area.pack(side="left", fill="both", expand=True)
        
        # Top: Video Player & Key Metrics
        top_split = ttk.Frame(content_area)
        top_split.pack(fill="both", expand=True) # Takes remaining space
        
        # Video Player (Left of top split)
        video_panel = ttk.Frame(top_split, style="Panel.TFrame")
        video_panel.pack(side="left", fill="both", expand=True, padx=(0, 20))
        
        # Custom Canvas for video
        self.video_canvas = tk.Canvas(video_panel, bg="black", highlightthickness=0)
        self.video_canvas.pack(fill="both", expand=True, padx=2, pady=2)
        
        # --- Playback Controls ---
        controls_wrapper = ttk.Frame(video_panel, style="Panel.TFrame")
        controls_wrapper.pack(fill="x", pady=(3, 5), padx=5)

        # Row 1: Timeline slider + time label
        timeline_row = ttk.Frame(controls_wrapper, style="Panel.TFrame")
        timeline_row.pack(fill="x")

        self.timeline_var = tk.IntVar(value=0)
        self.timeline_slider = ttk.Scale(
            timeline_row, from_=0, to=100, orient="horizontal",
            variable=self.timeline_var, style="Timeline.Horizontal.TScale",
            command=self._on_timeline_change
        )
        self.timeline_slider.pack(side="left", fill="x", expand=True, padx=(0, 8))
        self.timeline_slider.state(["disabled"])

        self.lbl_time = ttk.Label(timeline_row, text="0:00 / 0:00",
                                   style="MetricLabel.TLabel", width=14, anchor="e")
        self.lbl_time.pack(side="right")

        # Row 2: Buttons + speed selector
        btn_row = ttk.Frame(controls_wrapper, style="Panel.TFrame")
        btn_row.pack(fill="x", pady=(4, 0))

        self.btn_prev_frame = ttk.Button(btn_row, text="⏮", width=3,
                                          command=self._prev_frame, state="disabled")
        self.btn_prev_frame.pack(side="left", padx=2)

        self.btn_play = ttk.Button(btn_row, text="▶ PLAY",
                                    command=self.play_video, state="disabled", width=10)
        self.btn_play.pack(side="left", padx=2)

        self.btn_next_frame = ttk.Button(btn_row, text="⏭", width=3,
                                          command=self._next_frame, state="disabled")
        self.btn_next_frame.pack(side="left", padx=2)

        # Speed selector
        ttk.Label(btn_row, text="Speed:", style="MetricLabel.TLabel").pack(side="left", padx=(15, 4))
        self.speed_var = tk.StringVar(value="1.0x")
        speed_combo = ttk.Combobox(btn_row, textvariable=self.speed_var, width=5,
                                    values=["0.1x", "0.25x", "0.5x", "1.0x", "1.5x", "2.0x"],
                                    state="readonly")
        speed_combo.pack(side="left")
        speed_combo.bind("<<ComboboxSelected>>", self._on_speed_change)

        # Frame counter
        self.lbl_frame_info = ttk.Label(btn_row, text="", style="MetricLabel.TLabel")
        self.lbl_frame_info.pack(side="right", padx=5)
        
        # Metrics Panel (Right of top split)
        metrics_panel = ttk.Frame(top_split, width=350, style="Panel.TFrame", padding=20)
        metrics_panel.pack(side="right", fill="y")
        
        self._create_metric_card(metrics_panel, "BALL SPEED", "result_release_speed", "0.0", "km/h", row=0, is_title_dynamic=True)
        self._create_metric_card(metrics_panel, "MAX SPEED", "result_max_speed", "0.0", "km/h", row=1)
        self._create_metric_card(metrics_panel, "DISTANCE", "result_distance", "0.00", "m", row=2)

        # Bottom: Charts
        charts_panel = ttk.Frame(content_area, height=300, style="Panel.TFrame", padding=10)
        charts_panel.pack(side="bottom", fill="x", pady=(20, 0)) # Fixed height
        
        self._setup_charts(charts_panel)

    def _create_metric_card(self, parent, title, var_name, default, unit, row, is_title_dynamic=False):
        """Helper to create a consistent metric display."""
        frame = ttk.Frame(parent, style="Panel.TFrame")
        frame.pack(fill="x", pady=(0, 25))
        
        # Initialize variable
        setattr(self, var_name, tk.StringVar(value=default))
        
        lbl = ttk.Label(frame, text=title, style="MetricLabel.TLabel")
        lbl.pack(anchor="w")
        
        if is_title_dynamic:
            self.lbl_speed_title = lbl
        
        # Value + Unit row
        val_row = ttk.Frame(frame, style="Panel.TFrame")
        val_row.pack(anchor="w")
        
        ttk.Label(val_row, textvariable=getattr(self, var_name), style="MetricVal.TLabel").pack(side="left")
        ttk.Label(val_row, text=unit, style="MetricLabel.TLabel", padding=(5, 0, 0, 5)).pack(side="left", anchor="sw")

    def _setup_charts(self, parent):
        """Embed Matplotlib figure with multi-panel velocity breakdown."""
        self.fig, (self.ax_bar, self.ax_delta) = plt.subplots(
            1, 2, figsize=(8, 2.5), dpi=100,
            gridspec_kw={'width_ratios': [3, 2]}
        )
        self.fig.patch.set_facecolor(self.colors["bg_panel"])
        self.fig.subplots_adjust(left=0.08, right=0.95, bottom=0.18, top=0.85, wspace=0.35)

        for ax in (self.ax_bar, self.ax_delta):
            ax.set_facecolor(self.colors["bg_panel"])
            ax.tick_params(colors='white', labelsize=7)
            for spine in ax.spines.values():
                spine.set_color('#555555')
            ax.xaxis.label.set_color('white')
            ax.yaxis.label.set_color('white')

        self.ax_bar.set_title("Speed per Frame", color='white', fontsize=9, fontweight='bold')
        self.ax_delta.set_title("Speed Change (Δ km/h)", color='white', fontsize=9, fontweight='bold')

        self.chart_canvas = FigureCanvasTkAgg(self.fig, master=parent)
        self.chart_canvas.draw()
        self.chart_canvas.get_tk_widget().pack(fill="both", expand=True)

        # Click on chart area to open detailed popup
        self.chart_canvas.get_tk_widget().bind("<Button-1>", lambda e: self._open_detail_chart())

    def select_video(self):
        path = filedialog.askopenfilename(filetypes=[("Video", "*.mp4 *.avi *.mov")])
        if path:
            self.video_paths = [path]
            self.lbl_filename.config(text=os.path.basename(path))
            self.status_msg.set("Video loaded. Click 'Start Analysis'.")
            
            # Show preview
            self._show_preview_frame(path)

    def _show_preview_frame(self, video_path):
        cap = cv2.VideoCapture(video_path)
        ret, frame = cap.read()
        if ret:
            self._update_video_canvas(frame)
        cap.release()

    # ------------------------------------------------------------------
    # Video Playback (timeline + speed control)
    # ------------------------------------------------------------------
    def _init_video_capture(self, path: str):
        """Open a video file and read its metadata."""
        if self.cap and self.cap.isOpened():
            self.cap.release()
        self.cap = cv2.VideoCapture(path)
        self.video_total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.video_fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.current_frame_idx = 0

        # Update slider range
        self.timeline_slider.config(to=max(1, self.video_total_frames - 1))
        self.timeline_var.set(0)
        self._update_time_label()

    def play_video(self):
        if not hasattr(self, 'current_output_path') or not self.current_output_path:
            return

        if self.is_playing:
            # Pause
            self.is_playing = False
            self.btn_play.config(text="▶ PLAY")
            return

        # If at end, rewind
        if self.cap and self.current_frame_idx >= self.video_total_frames - 1:
            self._seek_to_frame(0)

        # Start / Resume
        if not self.cap or not self.cap.isOpened():
            self._init_video_capture(self.current_output_path)

        self.is_playing = True
        self.btn_play.config(text="⏸ PAUSE")
        self._video_loop()

    def _video_loop(self):
        if not self.is_playing:
            return
        if not self.cap or not self.cap.isOpened():
            return
        if self._seeking:
            # Wait for user to finish dragging
            self.after(50, self._video_loop)
            return

        ret, frame = self.cap.read()
        if ret:
            self.current_frame_idx = int(self.cap.get(cv2.CAP_PROP_POS_FRAMES))
            self._update_video_canvas(frame)

            # Update slider / labels without triggering seek callback
            self._seeking = True
            self.timeline_var.set(self.current_frame_idx)
            self._seeking = False
            self._update_time_label()

            # Schedule next frame based on playback speed
            delay = max(1, int((1000.0 / self.video_fps) / self.playback_speed))
            self.after(delay, self._video_loop)
        else:
            # End of video
            self.is_playing = False
            self.btn_play.config(text="↺ REPLAY")

    def _seek_to_frame(self, frame_idx: int):
        """Seek the video capture to a specific frame and display it."""
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
        """Called when user drags the timeline slider."""
        if self._seeking:
            return  # Ignore programmatic updates
        frame = int(float(value))
        was_playing = self.is_playing
        if was_playing:
            self.is_playing = False  # Pause during seek
        self._seeking = True
        self._seek_to_frame(frame)
        self._seeking = False
        if was_playing:
            self.is_playing = True
            self._video_loop()

    def _on_speed_change(self, _event=None):
        """Called when user changes the speed combobox."""
        txt = self.speed_var.get().replace('x', '')
        try:
            self.playback_speed = float(txt)
        except ValueError:
            self.playback_speed = 1.0

    def _prev_frame(self):
        """Step back one frame."""
        self.is_playing = False
        self.btn_play.config(text="▶ PLAY")
        target = max(0, self.current_frame_idx - 2)  # -2 because read() advances
        self._seek_to_frame(target)
        self.timeline_var.set(self.current_frame_idx)

    def _next_frame(self):
        """Step forward one frame."""
        self.is_playing = False
        self.btn_play.config(text="▶ PLAY")
        self._seek_to_frame(self.current_frame_idx)  # read() will advance +1
        self.timeline_var.set(self.current_frame_idx)

    def _update_time_label(self):
        """Update the time display and frame counter."""
        cur_sec = self.current_frame_idx / self.video_fps if self.video_fps else 0
        total_sec = self.video_total_frames / self.video_fps if self.video_fps else 0
        cur_m, cur_s = divmod(int(cur_sec), 60)
        tot_m, tot_s = divmod(int(total_sec), 60)
        self.lbl_time.config(text=f"{cur_m}:{cur_s:02d} / {tot_m}:{tot_s:02d}")
        self.lbl_frame_info.config(
            text=f"Frame {self.current_frame_idx} / {self.video_total_frames}"
        )

    def _update_video_canvas(self, frame):
        # Resize to fit canvas
        canvas_w = self.video_canvas.winfo_width()
        canvas_h = self.video_canvas.winfo_height()
        
        if canvas_w < 10 or canvas_h < 10:
             # Wait for UI to render
             canvas_w, canvas_h = 800, 450
        
        img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img_pil = Image.fromarray(img)
        
        # Keep aspect ratio
        img_w, img_h = img_pil.size
        ratio = min(canvas_w/img_w, canvas_h/img_h)
        new_w = int(img_w * ratio)
        new_h = int(img_h * ratio)
        
        img_pil = img_pil.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Delete previous image to prevent memory leak from accumulating PhotoImage refs
        if hasattr(self, '_tk_image_id') and self._tk_image_id:
            self.video_canvas.delete(self._tk_image_id)
        self.tk_image = ImageTk.PhotoImage(img_pil)
        self._tk_image_id = self.video_canvas.create_image(
            canvas_w // 2, canvas_h // 2, anchor="center", image=self.tk_image
        )

    def run_analysis(self):
        if not self.video_paths:
            messagebox.showwarning("Warning", "Please select a video first.")
            return
            
        self.pipeline_running = True
        self.btn_run.config(state="disabled", text="ANALYZING...")
        self.btn_select.config(state="disabled")
        self.btn_play.config(state="disabled") # Disable play during analysis
        self.status_msg.set("Initializing AI model...")
        
        # Start worker thread
        threading.Thread(target=self._worker_thread, daemon=True).start()

    def _worker_thread(self):
        try:
            output_filename = "Overlay_Pro.mp4"
            base_dir = os.path.dirname(self.video_paths[0])
            output_path = os.path.join(base_dir, output_filename)
            
            # Run Pipeline
            results = run_yolov8_pipeline(
                self.video_paths,
                weights_path=os.path.abspath(self.yolov8_weights.get()),
                output_path=output_path,
                manual_distance_meters=self.pitch_dist.get(),
                stride_correction=self.stride_correction.get(),
                show_preview=False,
                debug=True 
            )
            
            if results and len(results) > 0:
                data = results[0]
                self.after(0, lambda: self._update_ui_with_results(data, output_path))
            else:
                self.after(0, lambda: messagebox.showwarning("No Data", "Could not detect enough ball trajectory."))
                
        except Exception as e:
            self.after(0, lambda: messagebox.showerror("Error", str(e)))
        finally:
            self.after(0, self._reset_ui_state)

    def _update_ui_with_results(self, data: dict, output_path: str):
        def fmt_speed(kmh):
            if kmh is None: return "N/A"
            mph = kmh * 0.621371
            return f"{kmh:.1f} km/h\n({mph:.1f} mph)"

        # 1. Ball Speed (Release or Initial)
        # Match overlay logic: prefer release, else initial
        rel_speed = data.get('release_speed_kmh')
        init_speed = data.get('initial_speed_kmh')
        
        if rel_speed:
            self.result_release_speed.set(fmt_speed(rel_speed))
            if hasattr(self, 'lbl_speed_title'):
                self.lbl_speed_title.config(text="BALL SPEED")
        elif init_speed:
            self.result_release_speed.set(fmt_speed(init_speed))
            if hasattr(self, 'lbl_speed_title'):
                self.lbl_speed_title.config(text="SPEED")
        else:
            self.result_release_speed.set("N/A")
        
        # 2. Max Speed
        self.result_max_speed.set(fmt_speed(data.get('max_speed_kmh', 0)))
        
        # 3. Distance (prefer effective_distance if available)
        dist = data.get('effective_distance_m') or data.get('total_distance_m', 0)
        self.result_distance.set(f"{dist:.1f} m")
        
        # Update Chart
        details = data.get('frame_details', [])
        if details:
            self._render_velocity_charts(details)
            
        self.status_msg.set(f"Analysis Complete! Output: {os.path.basename(output_path)}")
        
        # Enable Playback
        self.current_output_path = output_path
        self._init_video_capture(output_path)
        self._seek_to_frame(0)  # Show first frame

        self.btn_play.config(state="normal", text="▶ PLAY")
        self.btn_prev_frame.config(state="normal")
        self.btn_next_frame.config(state="normal")
        self.timeline_slider.state(["!disabled"])

    def _render_velocity_charts(self, details: list):
        """Render a two-panel velocity breakdown that highlights speed changes."""
        self._cached_details = details  # Cache for popup
        frames = [d['frame'] for d in details]
        speeds = [d['speed_kmh'] for d in details]

        # --- Left panel: color-coded bar chart (speed per frame) ---
        ax = self.ax_bar
        ax.clear()
        ax.set_facecolor(self.colors["bg_panel"])
        for spine in ax.spines.values():
            spine.set_color('#555555')
        ax.tick_params(colors='white', labelsize=7)

        # Normalize speeds to [0,1] for colormap
        s_min, s_max = min(speeds), max(speeds)
        if s_max == s_min:
            norm_speeds = [0.5] * len(speeds)
        else:
            norm_speeds = [(s - s_min) / (s_max - s_min) for s in speeds]

        # Use a warm-to-cool colormap: high speed = red, low = blue
        cmap = plt.cm.RdYlGn  # Red (low) -> Yellow (mid) -> Green (high)
        bar_colors = [cmap(n) for n in norm_speeds]

        bars = ax.bar(frames, speeds, color=bar_colors, width=0.8, edgecolor='none')

        # Y-axis: zoom in to show differences clearly
        speed_range = s_max - s_min
        if speed_range < 1.0:
            # Very small range — zoom in aggressively
            pad = max(0.5, speed_range * 2)
        else:
            pad = speed_range * 0.3
        ax.set_ylim(max(0, s_min - pad), s_max + pad)

        # Add value labels on bars
        for bar, spd in zip(bars, speeds):
            ax.text(
                bar.get_x() + bar.get_width() / 2, bar.get_height(),
                f'{spd:.1f}', ha='center', va='bottom',
                color='white', fontsize=6, fontweight='bold'
            )

        ax.set_xlabel("Frame", fontsize=7, color='white')
        ax.set_ylabel("Speed (km/h)", fontsize=7, color='white')
        ax.set_title("Speed per Frame", color='white', fontsize=9, fontweight='bold')
        ax.grid(True, axis='y', color='#444444', linestyle='--', alpha=0.5)

        # --- Right panel: speed delta (change between consecutive frames) ---
        ax2 = self.ax_delta
        ax2.clear()
        ax2.set_facecolor(self.colors["bg_panel"])
        for spine in ax2.spines.values():
            spine.set_color('#555555')
        ax2.tick_params(colors='white', labelsize=7)

        if len(speeds) > 1:
            deltas = [speeds[i+1] - speeds[i] for i in range(len(speeds)-1)]
            delta_frames = frames[1:]

            # Color: green for acceleration, red for deceleration
            delta_colors = ['#2ecc71' if d >= 0 else '#e74c3c' for d in deltas]
            bars2 = ax2.bar(delta_frames, deltas, color=delta_colors, width=0.8, edgecolor='none')

            # Add delta labels
            for bar, d in zip(bars2, deltas):
                y_pos = bar.get_height() if d >= 0 else bar.get_y()
                va = 'bottom' if d >= 0 else 'top'
                ax2.text(
                    bar.get_x() + bar.get_width() / 2, y_pos,
                    f'{d:+.2f}', ha='center', va=va,
                    color='white', fontsize=6, fontweight='bold'
                )

            # Zero line
            ax2.axhline(y=0, color='#888888', linewidth=0.8)

            # Auto-scale with padding
            d_abs_max = max(abs(d) for d in deltas) if deltas else 0.5
            if d_abs_max < 0.1:
                d_abs_max = 0.5
            ax2.set_ylim(-d_abs_max * 1.5, d_abs_max * 1.5)
        else:
            ax2.text(0.5, 0.5, 'Not enough data', transform=ax2.transAxes,
                     ha='center', va='center', color='#888888', fontsize=10)

        ax2.set_xlabel("Frame", fontsize=7, color='white')
        ax2.set_ylabel("Δ Speed (km/h)", fontsize=7, color='white')
        ax2.set_title("Speed Change (Δ km/h)", color='white', fontsize=9, fontweight='bold')
        ax2.grid(True, axis='y', color='#444444', linestyle='--', alpha=0.5)

        self.chart_canvas.draw()

    # ------------------------------------------------------------------
    # Popup Detail Chart (click to open)
    # ------------------------------------------------------------------
    def _open_detail_chart(self):
        """Open a large popup window with interactive line charts."""
        if not self._cached_details:
            return

        details = self._cached_details
        frames = [d['frame'] for d in details]
        speeds = [d['speed_kmh'] for d in details]

        # Create popup Toplevel window
        popup = tk.Toplevel(self)
        popup.title("Velocity Breakdown - Detail View")
        popup.geometry("1000x700")
        popup.configure(bg=self.colors["bg_dark"])
        popup.grab_set()  # Modal

        # Header
        header = tk.Frame(popup, bg=self.colors["bg_dark"])
        header.pack(fill="x", padx=20, pady=(15, 5))
        tk.Label(
            header, text="VELOCITY DETAIL VIEW",
            font=("Segoe UI", 14, "bold"), bg=self.colors["bg_dark"], fg=self.colors["accent"]
        ).pack(side="left")
        tk.Label(
            header, text="(click on data points for details)",
            font=("Segoe UI", 9), bg=self.colors["bg_dark"], fg=self.colors["fg_subtext"]
        ).pack(side="left", padx=10)

        # --- Matplotlib figure: 2 rows ---
        fig, (ax_top, ax_bot) = plt.subplots(
            2, 1, figsize=(10, 6), dpi=100,
            gridspec_kw={'height_ratios': [3, 2]}
        )
        fig.patch.set_facecolor(self.colors["bg_dark"])
        fig.subplots_adjust(left=0.08, right=0.95, top=0.93, bottom=0.08, hspace=0.35)

        # ---- Top: Speed Line Chart (zoomed Y-axis) ----
        ax_top.set_facecolor(self.colors["bg_panel"])
        for spine in ax_top.spines.values():
            spine.set_color('#555555')
        ax_top.tick_params(colors='white', labelsize=8)

        # Main line
        ax_top.plot(frames, speeds, color=self.colors["accent"], linewidth=2.5,
                    marker='o', markersize=5, markerfacecolor='white',
                    markeredgecolor=self.colors["accent"], markeredgewidth=1.5,
                    zorder=3, label='Speed')
        ax_top.fill_between(frames, speeds, color=self.colors["accent"], alpha=0.08)

        # Reference lines
        avg_speed = np.mean(speeds)
        ax_top.axhline(y=avg_speed, color=self.colors["warning"], linewidth=1,
                       linestyle='--', alpha=0.7, label=f'Avg: {avg_speed:.1f} km/h')
        ax_top.axhline(y=max(speeds), color=self.colors["success"], linewidth=1,
                       linestyle=':', alpha=0.5, label=f'Max: {max(speeds):.1f} km/h')
        ax_top.axhline(y=min(speeds), color=self.colors["danger"], linewidth=1,
                       linestyle=':', alpha=0.5, label=f'Min: {min(speeds):.1f} km/h')

        # Zoom Y-axis
        s_min, s_max = min(speeds), max(speeds)
        speed_range = s_max - s_min
        pad = max(0.5, speed_range * 0.4) if speed_range < 2.0 else speed_range * 0.15
        ax_top.set_ylim(s_min - pad, s_max + pad)

        ax_top.set_title("Speed vs Frame (Zoomed)", color='white', fontsize=11, fontweight='bold')
        ax_top.set_xlabel("Frame", fontsize=9, color='white')
        ax_top.set_ylabel("Speed (km/h)", fontsize=9, color='white')
        ax_top.grid(True, color='#444444', linestyle='--', alpha=0.4)
        ax_top.legend(loc='upper right', fontsize=7, facecolor='#333333',
                      edgecolor='#555555', labelcolor='white')

        # ---- Bottom: Delta chart (bar + line overlay) ----
        ax_bot.set_facecolor(self.colors["bg_panel"])
        for spine in ax_bot.spines.values():
            spine.set_color('#555555')
        ax_bot.tick_params(colors='white', labelsize=8)

        if len(speeds) > 1:
            deltas = [speeds[i + 1] - speeds[i] for i in range(len(speeds) - 1)]
            delta_frames = frames[1:]

            delta_colors = [self.colors["success"] if d >= 0 else self.colors["danger"] for d in deltas]
            ax_bot.bar(delta_frames, deltas, color=delta_colors, width=0.7, alpha=0.7, edgecolor='none')
            ax_bot.plot(delta_frames, deltas, color='white', linewidth=1.2,
                        marker='D', markersize=3, alpha=0.8)
            ax_bot.axhline(y=0, color='#888888', linewidth=0.8)

            d_abs_max = max(abs(d) for d in deltas) if deltas else 0.5
            if d_abs_max < 0.1:
                d_abs_max = 0.5
            ax_bot.set_ylim(-d_abs_max * 1.8, d_abs_max * 1.8)

        ax_bot.set_title("Frame-to-Frame Speed Change", color='white', fontsize=11, fontweight='bold')
        ax_bot.set_xlabel("Frame", fontsize=9, color='white')
        ax_bot.set_ylabel("Δ Speed (km/h)", fontsize=9, color='white')
        ax_bot.grid(True, color='#444444', linestyle='--', alpha=0.4)

        # --- Interactive annotation on hover/click ---
        annot = ax_top.annotate(
            "", xy=(0, 0), xytext=(15, 15), textcoords="offset points",
            bbox=dict(boxstyle="round,pad=0.4", fc="#1e1e1e", ec=self.colors["accent"], lw=1.5),
            color='white', fontsize=9, fontweight='bold', zorder=10
        )
        annot.set_visible(False)

        def on_click(event):
            if event.inaxes != ax_top:
                annot.set_visible(False)
                canvas.draw_idle()
                return
            # Find closest data point
            x_click = event.xdata
            if x_click is None:
                return
            idx = int(min(range(len(frames)), key=lambda i: abs(frames[i] - x_click)))
            f, s = frames[idx], speeds[idx]
            mph = s * 0.621371
            delta_txt = ""
            if idx > 0:
                d = speeds[idx] - speeds[idx - 1]
                delta_txt = f"\nΔ: {d:+.2f} km/h"
            annot.xy = (f, s)
            annot.set_text(f"Frame {f}\n{s:.2f} km/h\n{mph:.1f} mph{delta_txt}")
            annot.set_visible(True)
            canvas.draw_idle()

        canvas = FigureCanvasTkAgg(fig, master=popup)
        canvas.draw()
        canvas.get_tk_widget().pack(fill="both", expand=True, padx=10, pady=(0, 10))
        canvas.mpl_connect("button_press_event", on_click)

        # Close button
        btn_close = tk.Button(
            popup, text="CLOSE", font=("Segoe UI", 10, "bold"),
            bg=self.colors["accent"], fg="white", bd=0, padx=20, pady=6,
            activebackground=self.colors["accent_hover"], activeforeground="white",
            command=lambda: (plt.close(fig), popup.destroy())
        )
        btn_close.pack(pady=(0, 15))

    def _reset_ui_state(self):
        self.pipeline_running = False
        self.btn_run.config(state="normal", text="START ANALYSIS")
        self.btn_select.config(state="normal")

if __name__ == "__main__":
    app = SpeedgunApp()
    app.mainloop()
