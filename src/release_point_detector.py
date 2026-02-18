from __future__ import annotations

import numpy as np
from typing import List, Tuple, Optional, Dict

# ── Tunable Constants ──────────────────────────────────────────
MIN_VISIBILITY = 0.35           # Minimum landmark visibility threshold
MIN_FRAMES_FOR_DETECTION = 10   # Minimum frames needed for analysis
MIN_FRAMES_FOR_HAND_INFER = 8   # Minimum frames to infer throwing hand
VEL_WINDOW_DIVISOR = 10         # fps / this = velocity smoothing window
ELBOW_EXTENSION_RATIO = 0.9     # Fraction of max angle for "extended"
WRIST_SPEED_MULT = 1.5          # Wrist speed must exceed avg * this
FOOT_STABLE_SEC = 0.10          # Foot must be stable for this duration (sec)
FOOT_VEL_MULT = 0.25            # Foot Y-velocity threshold multiplier
FOOT_WINDOW_START_SEC = 0.08    # Release window start after foot contact
FOOT_WINDOW_END_SEC = 0.45      # Release window end after foot contact
S1_ADVANCE_SEC = 0.008          # Peak-to-release advance offset (sec)
S1S2_AGREEMENT_SEC = 0.15       # Max allowed S1-S2 disagreement (sec)
S1_DEFAULT_WEIGHT = 0.4         # S1 signal weight
S2_DEFAULT_WEIGHT = 0.3         # S2 signal weight
S2_DOWNWEIGHTED = 0.1           # S2 weight when disagreeing with S1
BALL_MAX_LEAD_SEC = 0.30        # Max lead time for ball cross-validation
S3_CONFIDENCE_BOOST = 1.2       # Confidence multiplier when S3 agrees
SINGLE_SIGNAL_MAX_CONF = 0.6    # Max confidence with only one signal


class ReleasePointDetector:
    
    def __init__(self, fps: int = 30):
        self.fps = fps
        self.pose_history = []  # 儲存每一幀的 pose landmarks
        self.frame_count = 0
        self._cached_throwing_wrist_idx: Optional[int] = None
        
    def add_frame(self, pose_landmarks, frame_width: int, frame_height: int) -> None:
        """
        添加一幀的 pose 資料
        
        Args:
            pose_landmarks: MediaPipe pose landmarks
            frame_width: 畫面寬度
            frame_height: 畫面高度
        """
        if pose_landmarks is None:
            self.pose_history.append(None)
            self.frame_count += 1
            return
        
        # 提取關鍵點座標
        landmarks = {}
        for idx in [11, 12, 13, 14, 15, 16, 19, 20, 27, 28]:  # 肩、肘、腕、指、踝
            lm = pose_landmarks.landmark[idx]
            landmarks[idx] = {
                'x': lm.x * frame_width,
                'y': lm.y * frame_height,
                'visibility': lm.visibility if hasattr(lm, 'visibility') else 1.0
            }
        
        self.pose_history.append(landmarks)
        self.frame_count += 1

        # pose history 更新後，丟棄快取（避免資料增加造成快取過期）
        self._cached_throwing_wrist_idx = None

    def infer_throwing_hand(self) -> Optional[Dict[str, int]]:
        """
        推斷投球手（左/右）並回傳該手的關鍵點 index。

        Returns:
            dict: {'wrist': 15/16, 'index_finger': 19/20, 'elbow': 13/14, 'shoulder': 11/12}
        """
        wrist_idx = self._infer_throwing_wrist_idx()
        if wrist_idx is None:
            return None
        if wrist_idx == 15:
            return {"wrist": 15, "index_finger": 19, "elbow": 13, "shoulder": 11}
        return {"wrist": 16, "index_finger": 20, "elbow": 14, "shoulder": 12}

    def _infer_throwing_wrist_idx(self) -> Optional[int]:
        """
        以「可見度覆蓋率 + 高分位數腕速」推斷投球手，避免逐幀用可見度切換造成左右手跳動。
        """
        if self._cached_throwing_wrist_idx is not None:
            return self._cached_throwing_wrist_idx

        if len(self.pose_history) < MIN_FRAMES_FOR_HAND_INFER:
            return None

        def build_series(wrist_idx: int) -> tuple[list[Tuple[float, float]], list[int], float]:
            pts: list[Tuple[float, float]] = []
            frame_ids: list[int] = []
            for i, frame_data in enumerate(self.pose_history):
                if frame_data is None:
                    continue
                w = frame_data.get(wrist_idx)
                if not w:
                    continue
                if w.get("visibility", 1.0) < MIN_VISIBILITY:
                    continue
                pts.append((float(w["x"]), float(w["y"])))
                frame_ids.append(i)
            visible_ratio = (len(frame_ids) / len(self.pose_history)) if self.pose_history else 0.0
            return pts, frame_ids, float(visible_ratio)

        def score_wrist(wrist_idx: int) -> float:
            pts, frame_ids, visible_ratio = build_series(wrist_idx)
            if len(pts) < 6:
                return -1e9
            vel_window = max(3, int(round(self.fps / VEL_WINDOW_DIVISOR)))
            vels = self._calculate_velocity(pts, window=vel_window)
            # 使用高分位數避免單幀雜訊峰值
            peak = float(np.percentile(vels, 90)) if vels else 0.0
            return peak * (0.5 + visible_ratio)

        left_score = score_wrist(15)
        right_score = score_wrist(16)

        if left_score <= -1e8 and right_score <= -1e8:
            return None

        self._cached_throwing_wrist_idx = 15 if left_score >= right_score else 16
        return self._cached_throwing_wrist_idx
    
    def _calculate_velocity(self, points: List[Tuple[float, float]], window: int = 3) -> List[float]:
        """
        計算速度（使用中心差分）
        
        Args:
            points: 位置點列表 [(x, y), ...]
            window: 平滑窗口
            
        Returns:
            速度列表（像素/幀）
        """
        if len(points) < 2:
            return [0.0] * len(points)
        
        velocities = []
        for i in range(len(points)):
            if i == 0:
                # 前向差分
                dx = points[i+1][0] - points[i][0]
                dy = points[i+1][1] - points[i][1]
            elif i == len(points) - 1:
                # 後向差分
                dx = points[i][0] - points[i-1][0]
                dy = points[i][1] - points[i-1][1]
            else:
                # 中心差分（更準確）
                dx = (points[i+1][0] - points[i-1][0]) / 2
                dy = (points[i+1][1] - points[i-1][1]) / 2
            
            v = np.sqrt(dx**2 + dy**2)
            velocities.append(v)
        
        # 移動平均平滑
        smoothed = []
        for i in range(len(velocities)):
            start = max(0, i - window//2)
            end = min(len(velocities), i + window//2 + 1)
            smoothed.append(np.mean(velocities[start:end]))
        
        return smoothed
    
    def _calculate_angle(self, p1: Tuple[float, float], p2: Tuple[float, float], 
                        p3: Tuple[float, float]) -> float:
        """
        計算三點形成的角度（p1-p2-p3）
        
        Returns:
            角度（度）
        """
        v1 = np.array([p1[0] - p2[0], p1[1] - p2[1]])
        v2 = np.array([p3[0] - p2[0], p3[1] - p2[1]])
        
        cos_angle = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6)
        cos_angle = np.clip(cos_angle, -1.0, 1.0)
        angle = np.arccos(cos_angle) * 180 / np.pi
        
        return angle
    
    def _detect_signal_s1_wrist_speed_peak(self) -> Optional[int]:
        """
        訊號 S1：手腕速度峰值附近（更接近真實放球瞬間）

        以前版本用「峰值後的減速拐點」會系統性偏晚（尤其在高 FPS）。
        這裡改為直接取速度峰值（並允許依 FPS 做輕微前移校正）。

        Returns:
            出球幀索引，如果找不到則返回 None
        """
        if len(self.pose_history) < MIN_FRAMES_FOR_DETECTION:
            return None

        # 提取手腕位置（固定投球手，避免左右切換）
        throwing = self.infer_throwing_hand()
        if not throwing:
            return None
        wrist_idx = throwing["wrist"]

        wrist_points = []
        for frame_data in self.pose_history:
            if frame_data is None:
                wrist_points.append(None)
                continue

            wrist = frame_data.get(wrist_idx)
            if not wrist or wrist.get("visibility", 1.0) < 0.35:
                wrist_points.append(None)
                continue
            wrist_points.append((float(wrist["x"]), float(wrist["y"])))

        # 過濾 None
        valid_indices = [i for i, p in enumerate(wrist_points) if p is not None]
        if len(valid_indices) < 10:
            return None

        valid_points = [wrist_points[i] for i in valid_indices]

        # 計算速度（平滑窗口隨 FPS 縮放：30fps≈3, 60fps≈6, 120fps≈12）
        vel_window = max(3, int(round(self.fps / 10)))
        velocities = self._calculate_velocity(valid_points, window=vel_window)

        # 只在後半段搜尋速度峰值：放球發生在投球動作後期，
        # 前半段的峰值通常是 wind-up 或 arm cocking 的假峰值
        search_start = len(velocities) // 3  # 從後 2/3 開始搜尋
        if search_start >= len(velocities):
            search_start = 0
        peak_local_idx = search_start + int(np.argmax(velocities[search_start:]))

        # 高 FPS 下，真實放球通常更接近峰值或峰值前 0~2 幀
        # 以「秒」表示的前移量，讓不同 FPS 表現一致
        advance_sec = S1_ADVANCE_SEC
        offset = -int(round(advance_sec * self.fps))

        chosen_local_idx = max(0, min(len(valid_indices) - 1, peak_local_idx + offset))
        return int(valid_indices[chosen_local_idx])


    def _detect_signal_s2_elbow_extension(self) -> Optional[int]:
        """
        訊號 S2：肘關節伸直 + 手腕鞭打動作
        
        Returns:
            出球幀索引
        """
        if len(self.pose_history) < MIN_FRAMES_FOR_DETECTION:
            return None
        
        # 提取肩-肘-腕的角度和手腕相對位置（固定投球手）
        throwing = self.infer_throwing_hand()
        if not throwing:
            return None
        shoulder_idx = throwing["shoulder"]
        elbow_idx = throwing["elbow"]
        wrist_idx = throwing["wrist"]

        elbow_angles = []
        wrist_velocities = []
        valid_indices = []
        
        for i, frame_data in enumerate(self.pose_history):
            if frame_data is None:
                continue
            
            shoulder = frame_data.get(shoulder_idx)
            elbow = frame_data.get(elbow_idx)
            wrist = frame_data.get(wrist_idx)
            if not shoulder or not elbow or not wrist:
                continue
            if min(
                shoulder.get("visibility", 1.0),
                elbow.get("visibility", 1.0),
                wrist.get("visibility", 1.0),
            ) < 0.35:
                continue
            
            # 計算肘關節角度
            angle = self._calculate_angle(
                (shoulder['x'], shoulder['y']),
                (elbow['x'], elbow['y']),
                (wrist['x'], wrist['y'])
            )
            
            elbow_angles.append(angle)
            wrist_velocities.append((wrist['x'], wrist['y']))
            valid_indices.append(i)
        
        if len(elbow_angles) < 5:
            return None
        
        # 計算手腕相對速度
        wrist_vels = self._calculate_velocity(wrist_velocities, window=2)
        
        # 找肘關節接近伸直（角度接近最大）且手腕速度高的時刻
        # 肘關節伸直通常是 140-180 度
        max_angle = max(elbow_angles)
        candidates = []
        
        for i in range(len(elbow_angles)):
            if elbow_angles[i] > max_angle * ELBOW_EXTENSION_RATIO:
                if wrist_vels[i] > np.mean(wrist_vels) * WRIST_SPEED_MULT:
                    candidates.append((i, wrist_vels[i]))
        
        if candidates:
            # 選擇手腕速度最高的候選點
            best_idx = max(candidates, key=lambda x: x[1])[0]
            return valid_indices[best_idx]
        
        return None
    
    def _detect_signal_s3_foot_contact(self) -> Optional[Tuple[int, int]]:
        """
        訊號 S3：前腳落地檢測，返回時間窗口
        
        Returns:
            (落地幀, 窗口結束幀) 或 None
        """
        if len(self.pose_history) < MIN_FRAMES_FOR_DETECTION:
            return None
        
        # 提取前腳踝位置：用「總位移較大」的腳當前腳，避免固定用左腳造成誤判
        left_series: list[Tuple[int, Tuple[float, float]]] = []
        right_series: list[Tuple[int, Tuple[float, float]]] = []
        
        for i, frame_data in enumerate(self.pose_history):
            if frame_data is None:
                continue
            
            left_ankle = frame_data.get(27)
            right_ankle = frame_data.get(28)

            if left_ankle and left_ankle.get("visibility", 1.0) >= 0.35:
                left_series.append((i, (float(left_ankle["x"]), float(left_ankle["y"]))))
            if right_ankle and right_ankle.get("visibility", 1.0) >= 0.35:
                right_series.append((i, (float(right_ankle["x"]), float(right_ankle["y"]))))

        def total_displacement(series: list[Tuple[int, Tuple[float, float]]]) -> float:
            if len(series) < 6:
                return 0.0
            pts = [p for _, p in series]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            return float((max(xs) - min(xs)) + (max(ys) - min(ys)))

        use_left = total_displacement(left_series) >= total_displacement(right_series)
        series = left_series if use_left else right_series

        if len(series) < 10:
            return None

        valid_indices = [fid for fid, _ in series]
        ankle_points = [pt for _, pt in series]

        # 計算 Y 方向速度（垂直方向）
        y_positions = [p[1] for p in ankle_points]
        y_velocities = []
        for i in range(1, len(y_positions)):
            y_velocities.append(abs(y_positions[i] - y_positions[i-1]))
        
        # 找前腳落地：Y 方向速度突然接近 0 並持續
        # 連續幀數需依 FPS 縮放：要求至少 ~100ms 的穩定期
        foot_contact_idx = None
        velocity_threshold = np.mean(y_velocities) * FOOT_VEL_MULT
        consec_needed = max(3, int(round(FOOT_STABLE_SEC * self.fps)))

        for i in range(len(y_velocities) - consec_needed):
            if all(y_velocities[i + k] < velocity_threshold for k in range(consec_needed)):
                foot_contact_idx = valid_indices[i]
                break
        
        if foot_contact_idx is not None:
            # 出球通常在落地後約 0.08s ~ 0.45s（用 FPS 換算成幀數，避免高 FPS 錯位）
            # 原本 0.67s 窗口太寬，容易把非出球幀也納入
            start_delay_sec = FOOT_WINDOW_START_SEC
            end_delay_sec = FOOT_WINDOW_END_SEC
            window_start = foot_contact_idx + int(round(start_delay_sec * self.fps))
            window_end = min(foot_contact_idx + int(round(end_delay_sec * self.fps)), len(self.pose_history) - 1)
            return (window_start, window_end)
        
        return None
    
    def detect_release_point(self, first_ball_frame: Optional[int] = None) -> Optional[Dict]:
        """
        偵測出球點。

        Args:
            first_ball_frame: 第一顆球偵測到的幀索引（可選），用於交叉驗證。

        Returns:
            dict with 'frame_idx', 'confidence', 'signals' or None
        """
        if len(self.pose_history) < MIN_FRAMES_FOR_DETECTION:
            return None

        # 檢測各個訊號
        s1_frame = self._detect_signal_s1_wrist_speed_peak()
        s2_frame = self._detect_signal_s2_elbow_extension()
        s3_window = self._detect_signal_s3_foot_contact()

        signals = {
            's1_wrist_speed': s1_frame,
            's2_elbow_extension': s2_frame,
            's3_foot_window': s3_window
        }

        # ---- S1-S2 時間一致性檢查 ----
        # 如果 S1 和 S2 相差超過 0.15 秒，表示其中一個可能是誤判，
        # 降低離群訊號的權重
        s1_weight = S1_DEFAULT_WEIGHT
        s2_weight = S2_DEFAULT_WEIGHT
        agreement_sec = S1S2_AGREEMENT_SEC
        agreement_frames = int(round(agreement_sec * self.fps))

        if s1_frame is not None and s2_frame is not None:
            gap = abs(s1_frame - s2_frame)
            if gap > agreement_frames:
                # 不一致：降低離群訊號的權重而非直接丟棄
                # 偏好 S1（手腕峰值較穩定），S2 降為 0.1
                s2_weight = S2_DOWNWEIGHTED

        # ---- 組建候選 ----
        candidates = []
        if s1_frame is not None:
            candidates.append((s1_frame, s1_weight))
        if s2_frame is not None:
            candidates.append((s2_frame, s2_weight))

        # ---- S3 約束 ----
        if s3_window is not None:
            window_start, window_end = s3_window
            filtered = [
                (f, w) for f, w in candidates
                if window_start <= f <= window_end
            ]

            if filtered:
                # S3 約束成功，給予信心加成
                candidates = [(f, w * S3_CONFIDENCE_BOOST) for f, w in filtered]
            # else: S3 約束失敗時不丟棄所有候選——繼續使用 S1/S2

        # ---- 球軌跡交叉驗證 ----
        # 出球應在第一顆球偵測到的前方（最多提前 ~0.3s）
        if first_ball_frame is not None and candidates:
            max_lead_sec = BALL_MAX_LEAD_SEC
            max_lead_frames = int(round(max_lead_sec * self.fps))
            ball_filtered = [
                (f, w) for f, w in candidates
                if f <= first_ball_frame and (first_ball_frame - f) <= max_lead_frames
            ]
            if ball_filtered:
                candidates = ball_filtered

        if not candidates:
            return None

        # ---- 選擇最佳幀 ----
        weighted_sum = sum(f * w for f, w in candidates)
        total_weight = sum(w for _, w in candidates)

        if total_weight == 0:
            return None

        target_frame = weighted_sum / total_weight

        # 選擇最接近加權中心的候選點
        best_frame = min(candidates, key=lambda x: abs(x[0] - target_frame))[0]

        # ---- 信心度 ----
        # 基礎信心來自訊號權重總和
        confidence = total_weight / 1.0
        # 只有單一訊號時上限為 0.6（避免單訊號過度自信）
        num_signals = sum(1 for s in [s1_frame, s2_frame] if s is not None)
        if num_signals <= 1:
            confidence = min(confidence, SINGLE_SIGNAL_MAX_CONF)
        confidence = min(confidence, 1.0)

        return {
            'frame_idx': best_frame,
            'confidence': confidence,
            'signals': signals
        }