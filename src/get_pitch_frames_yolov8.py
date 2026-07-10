import cv2
import mediapipe as mp
import numpy as np
from ultralytics import YOLO
from typing import Optional

from src.FrameInfo import FrameInfo
from src.utils import fill_lost_tracking
from src.ball_speed_calculator import BallSpeedCalculator
from src.release_point_detector import ReleasePointDetector
from src.SORT_tracker.sort import Sort

mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils


def _names_to_map(names) -> dict[int, str]:
    if names is None:
        return {}
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    if isinstance(names, (list, tuple)):
        return {i: str(n) for i, n in enumerate(names)}
    return {}


def _infer_ball_class_ids(yolo_model: YOLO, first_result) -> Optional[set[int]]:
    """
    嘗試從 YOLO 類別名稱推斷「球」的 class id。
    若無法推斷（例如名稱不含 ball/baseball），回傳 None 表示不做 class 過濾。
    """
    names_map = {}
    if first_result is not None:
        names_map = _names_to_map(getattr(first_result, "names", None))
    if not names_map:
        names_map = _names_to_map(getattr(yolo_model, "names", None))

    if not names_map:
        return None

    if len(names_map) == 1:
        return set(names_map.keys())

    keywords = ("baseball", "ball")
    ball_ids = {cid for cid, name in names_map.items() if any(k in name.lower() for k in keywords)}
    return ball_ids or None


def _extract_ankles(pose_landmarks, width: int, height: int) -> list[tuple[int, int]]:
    if pose_landmarks is None:
        return []
    ankle_pts = []
    for idx in (27, 28):  # left/right ankle
        lm = pose_landmarks.landmark[idx]
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis >= 0.5:
            ankle_pts.append((int(lm.x * width), int(lm.y * height)))
    return ankle_pts


def _extract_release_point_from_pose(
    pose_landmarks,
    *,
    image_w: int,
    image_h: int,
    throwing_hand: Optional[dict],
) -> Optional[tuple[int, int]]:
    """
    從單幀 pose landmarks 擷取release point

    - 優先用投球手的食指指尖（較接近球離手位置）
    - 若指尖不可用，退回投球手手腕
    - 若投球手未知，則在左右手中選可見度較高者
    """
    if pose_landmarks is None:
        return None

    def get_xy(idx: int, min_vis: float) -> Optional[tuple[int, int]]:
        try:
            lm = pose_landmarks.landmark[idx]
        except Exception:
            return None
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis < min_vis:
            return None
        return (int(lm.x * image_w), int(lm.y * image_h))

    if throwing_hand:
        fp = get_xy(int(throwing_hand["index_finger"]), 0.5)
        if fp is not None:
            return fp
        wp = get_xy(int(throwing_hand["wrist"]), 0.35)
        if wp is not None:
            return wp
        return None

    # throwing hand unknown → pick best finger/wrist by visibility
    finger_candidates = []
    for idx in (19, 20):
        p = get_xy(idx, 0.5)
        if p is not None:
            finger_candidates.append(p)
    if finger_candidates:
        # 若兩邊都有，取較高（y 較小）的那一點（投球手通常舉高）
        return min(finger_candidates, key=lambda pt: pt[1])

    wrist_candidates = []
    for idx in (15, 16):
        p = get_xy(idx, 0.35)
        if p is not None:
            wrist_candidates.append(p)
    if wrist_candidates:
        return min(wrist_candidates, key=lambda pt: pt[1])

    return None


def _filter_candidate_dets(
    dets_with_cls: list[np.ndarray],
    *,
    width: int,
    height: int,
    ball_class_ids: Optional[set[int]],
    pose_landmarks,
) -> list[np.ndarray]:
    """
    det 格式: [x1, y1, x2, y2, conf, cls]
    """
    if not dets_with_cls:
        return []

    max_area = float(width * height) * 0.01  # 1% 畫面面積，避免把人腳/身體當球
    min_side = 3.0
    max_aspect = 2.5  # 球應接近正方形，過扁長通常不是球

    ankle_pts = _extract_ankles(pose_landmarks, width, height)
    ankle_radius = max(20.0, min(width, height) * 0.03)

    filtered: list[np.ndarray] = []
    for det in dets_with_cls:
        x1, y1, x2, y2, conf, cls_id = det.tolist()
        cls_id_int = int(cls_id) if cls_id is not None else -1

        if ball_class_ids is not None and cls_id_int not in ball_class_ids:
            continue

        bw = max(0.0, x2 - x1)
        bh = max(0.0, y2 - y1)
        if bw < min_side or bh < min_side:
            continue

        area = bw * bh
        if area <= 0 or area > max_area:
            continue

        aspect = (bw / (bh + 1e-6)) if bh > 0 else 999.0
        aspect = max(aspect, 1.0 / (aspect + 1e-6))
        if aspect > max_aspect:
            continue

        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0

        # 太靠近畫面最底部也常是誤判（腳、地面反光）；保守排除最底 5%
        if cy > height * 0.95:
            continue

        # 排除腳踝附近（常見誤判來源）
        if ankle_pts:
            near_ankle = False
            for ax, ay in ankle_pts:
                if (cx - ax) ** 2 + (cy - ay) ** 2 <= ankle_radius ** 2:
                    near_ankle = True
                    break
            if near_ankle:
                continue

        filtered.append(det)

    # 若過濾後全空，退回原始（避免在極端情況完全沒球）
    return filtered if filtered else dets_with_cls


def _pick_best_track_id(
    tracks_by_id: dict[int, list[dict]],
    *,
    width: int,
    height: int,
    raw_detections: list[dict],
) -> Optional[int]:
    """
    從 SORT 產生的多條 track 中挑出最像「球」的那一條。
    主要依據：長度、平均速度、總位移、bbox 面積偏小、少出現在腳踝/底部區域。
    """
    if not tracks_by_id:
        return None

    best_id = None
    best_score = -1e18

    for tid, items in tracks_by_id.items():
        # 球在影片中可能只出現很短（尤其高 fps / 快門很高時），至少 2 點即可形成軌跡
        if len(items) < 2:
            continue

        items_sorted = sorted(items, key=lambda x: x["frame_id"])
        pts = [(it["cx"], it["cy"], it["frame_id"], it["area"]) for it in items_sorted]

        # 速度（以 frame gap 正規化）
        speeds = []
        for i in range(1, len(pts)):
            x0, y0, f0, _ = pts[i - 1]
            x1, y1, f1, _ = pts[i]
            df = max(1, int(f1 - f0))
            dist = float(np.hypot(x1 - x0, y1 - y0))
            speeds.append(dist / df)
        avg_speed = float(np.mean(speeds)) if speeds else 0.0

        x_start, y_start, _, _ = pts[0]
        x_end, y_end, _, _ = pts[-1]
        displacement = float(np.hypot(x_end - x_start, y_end - y_start))
        avg_area = float(np.mean([p[3] for p in pts]))

        # 位置懲罰：底部/腳踝附近
        bottom_frac = float(np.mean([1.0 if p[1] > height * 0.9 else 0.0 for p in pts]))

        ankle_hits = 0
        ankle_total = 0
        ankle_radius = max(20.0, min(width, height) * 0.03)
        for p in pts:
            _, _, frame_id, _ = p
            if 0 <= frame_id < len(raw_detections):
                ankle_pts = raw_detections[frame_id].get("ankle_pts", [])
                if ankle_pts:
                    ankle_total += 1
                    cx = p[0]
                    cy = p[1]
                    if any((cx - ax) ** 2 + (cy - ay) ** 2 <= ankle_radius ** 2 for ax, ay in ankle_pts):
                        ankle_hits += 1
        ankle_frac = (ankle_hits / ankle_total) if ankle_total > 0 else 0.0

        # 基礎分數：偏好「長、快、位移大、框小」
        # - foot/地面：通常框較大、速度低、位移小、靠底部/踝部 → 自然會被壓下去
        score = (len(pts) ** 1.1) * (avg_speed + 1.0) * (displacement + 1.0) / ((avg_area + 1.0) ** 0.25)

        # 懲罰項
        score *= (1.0 - 0.6 * min(bottom_frac, 1.0))
        score *= (1.0 - 0.8 * min(ankle_frac, 1.0))

        if score > best_score:
            best_score = score
            best_id = tid

    return best_id


def get_pitch_frames_yolov8(
    video_path: str,
    yolo_model: YOLO,
    conf_threshold: float = 0.15,
    show_preview: bool = False,
    speed_calculator: Optional[BallSpeedCalculator] = None,
) -> tuple[list[FrameInfo], int, int, int, dict]:
    """
    使用 YOLOv8 模型偵測球，配 Mediapipe Pose 追蹤，
    輸出與原本 get_pitch_frames 類似的 pitch_frames
    
    Args:
        video_path: 影片檔案路徑
        yolo_model: 已載入的 YOLOv8 模型
        conf_threshold: YOLOv8 閾值（預設 0.15，建議 0.1-0.3 之間）
        show_preview: 是否顯示即時預覽視窗
        speed_calculator: 球速計算器（可選，用於計算球速）
    
    Returns:
        tuple: (pitch_frames, width, height, fps, speed_info)
            - pitch_frames: FrameInfo 列表，包含每一 frame 的球位置資訊
            - width: 影片寬度
            - height: 影片高度
            - fps: 影片幀率
            - speed_info: 球速資訊字典
    """
    print("Video from: ", video_path)
    # Use OpenCV to read the video information (width, height, FPS), the actual frame is read by YOLOv8 later
    meta_cap = cv2.VideoCapture(video_path)
    if not meta_cap.isOpened():
        raise ValueError(
            f"無法開啟影片檔案：{video_path}\n請確認檔案格式是否支援（mp4/avi/mov/mkv）。"
        )

    width = int(meta_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(meta_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = int(meta_cap.get(cv2.CAP_PROP_FPS))
    meta_cap.release()

    if width <= 0 or height <= 0:
        raise ValueError(
            f"無法讀取影片尺寸，可能是檔案損壞或格式不支援：{video_path}"
        )
    if fps <= 0:
        fps = 30
        print("警告：無法讀取 fps，使用預設值 30")

    pitch_frames: list[FrameInfo] = []
    raw_detections: list = []  # 儲存原始偵測結果（尚未修正出球點）
    frame_id = 0
    release_point = None  # 記錄出手點
    
    # 初始化多訊號出球點檢測器
    release_detector = ReleasePointDetector(fps=fps)
    ball_class_ids: Optional[set[int]] = None

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    try:
        # Use the YOLOv8 video streaming interface, the same as the way you tested the video with CLI
        results_generator = yolo_model.predict(
            source=video_path,
            conf=conf_threshold,
            iou=0.3,
            imgsz=1280,
            stream=True,
            verbose=False,
        )
    except Exception as e:
        pose.close()
        raise RuntimeError(
            f"無法使用 YOLOv8 處理影片：{video_path}\n錯誤：{e}"
        ) from e

    first_result = None
    try:
        for result in results_generator:
            if first_result is None:
                first_result = result
                ball_class_ids = _infer_ball_class_ids(yolo_model, first_result)

            # The original image returned by YOLO is BGR
            frame_bgr = result.orig_img
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

            # Mediapipe pose
            results = pose.process(frame_rgb)
            has_pose = results is not None and results.pose_landmarks is not None
            if has_pose:
                # 添加到出球點檢測器
                release_detector.add_frame(results.pose_landmarks, width, height)

                mp_drawing.draw_landmarks(
                    frame_rgb,
                    results.pose_landmarks,
                    mp_pose.POSE_CONNECTIONS,
                    mp_drawing.DrawingSpec(color=(0, 255, 0), thickness=2, circle_radius=2),
                    mp_drawing.DrawingSpec(color=(0, 0, 255), thickness=2, circle_radius=2),
                )
            else:
                # 沒有 pose，添加 None
                release_detector.add_frame(None, width, height)

            # Directly extract the detection box from the YOLO result
            # det format: [x1, y1, x2, y2, conf, cls]
            dets_with_cls: list[np.ndarray] = []
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                score = float(box.conf[0].item())
                cls_id = None
                if hasattr(box, "cls") and box.cls is not None:
                    try:
                        cls_id = int(box.cls[0].item())
                    except Exception:
                        cls_id = None
                dets_with_cls.append(
                    np.array(
                        [x1, y1, x2, y2, score, cls_id if cls_id is not None else -1],
                        dtype=float,
                    )
                )

            # 以球的 class / 尺寸 / 腳踝附近等條件做第一階段過濾（避免腳誤判）
            dets_filtered = _filter_candidate_dets(
                dets_with_cls,
                width=width,
                height=height,
                ball_class_ids=ball_class_ids,
                pose_landmarks=results.pose_landmarks if has_pose else None,
            )

            # 儲存原始偵測資料（第一階段：收集數據）
            raw_detections.append(
                {
                    "frame_rgb": frame_rgb,
                    "frame_id": frame_id,
                    "dets_list": dets_filtered,
                    "has_pose": has_pose,
                    "pose_landmarks": results.pose_landmarks if has_pose else None,
                    "ankle_pts": _extract_ankles(results.pose_landmarks, width, height) if has_pose else [],
                }
            )

            if show_preview:
                vis = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
                cv2.imshow("yolov8_result", vis)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            frame_id += 1
    finally:
        # 避免 mediapipe 資源未釋放（長影片/多次執行時較容易累積）
        pose.close()
        if show_preview:
            try:
                cv2.destroyAllWindows()
            except Exception:
                pass

    print("Processing complete - Phase 1: Data collection")
    
    # ===== 執行多訊號出球點檢測並生成軌跡 =====
    
    optimal_release_frame_idx = None
    release_detection = None
    throwing_hand = release_detector.infer_throwing_hand()
    release_pose_frame_idx = None

    # 找出第一個有球偵測的幀，用於交叉驗證 release point
    _first_ball_frame_for_validation = None
    for _rd in raw_detections:
        if _rd["dets_list"]:
            _first_ball_frame_for_validation = _rd["frame_id"]
            break

    if release_detector.frame_count >= 10:
        release_detection = release_detector.detect_release_point(
            first_ball_frame=_first_ball_frame_for_validation
        )
        
        if release_detection and release_detection['confidence'] > 0.3:
            optimal_release_frame_idx = release_detection['frame_idx']
            
            print(f"\n{'='*60}")
            print(f"出球點檢測結果")
            print(f"{'='*60}")
            print(f"  檢測幀號: {optimal_release_frame_idx}")
            print(f"  準確度: {release_detection['confidence']:.2f}")
            
            signals = release_detection['signals']
            print(f"  訊號 S1 (手腕速度峰值): {signals['s1_wrist_speed']}")
            print(f"  訊號 S2 (肘部伸展): {signals['s2_elbow_extension']}")
            print(f"  訊號 S3 (前腳落地窗口): {signals['s3_foot_window']}")
            print(f"{'='*60}\n")

    # 找到「最接近 optimal_release_frame_idx 且有 pose」的幀，
    # 讓出球點可以在「沒有球偵測」的出手幀也能被記錄（提升 release point 準確性）
    if optimal_release_frame_idx is not None and raw_detections:
        for delta in (0, -1, 1, -2, 2, -3, 3, -4, 4):
            idx = int(optimal_release_frame_idx + delta)
            if 0 <= idx < len(raw_detections) and raw_detections[idx].get("has_pose"):
                release_pose_frame_idx = idx
                break
    
    # 第二階段：使用檢測結果處理每一幀
    print("Processing Phase 2: Applying release point detection")

    # 以 SORT 做多幀追蹤，避免單幀誤判（腳/地面）把軌跡拉走
    # min_hits 用 1：讓短暫/斷續的球軌跡也能形成 track
    sort_tracker = Sort(max_age=10, min_hits=1, iou_threshold=0.1)
    tracks_by_id: dict[int, list[dict]] = {}
    tracks_by_frame: dict[int, dict[int, tuple[int, int]]] = {}

    for frame_data in raw_detections:
        fid = frame_data["frame_id"]
        dets_list = frame_data["dets_list"]

        if dets_list:
            dets_np = np.array([d[:5] for d in dets_list], dtype=float)
            trackings = sort_tracker.update(dets_np)
        else:
            trackings = sort_tracker.update()

        if trackings is None or len(trackings) == 0:
            continue

        for t in trackings:
            x1, y1, x2, y2, tid = t.tolist()
            tid_int = int(tid)
            cx = int((x1 + x2) / 2)
            cy = int((y1 + y2) / 2)
            area = float(max(0.0, (x2 - x1)) * max(0.0, (y2 - y1)))

            tracks_by_id.setdefault(tid_int, []).append(
                {"frame_id": fid, "cx": cx, "cy": cy, "area": area}
            )
            tracks_by_frame.setdefault(fid, {})[tid_int] = (cx, cy)

    best_track_id = _pick_best_track_id(
        tracks_by_id, width=width, height=height, raw_detections=raw_detections
    )
    if best_track_id is None and tracks_by_id:
        print("提示：有偵測到追蹤片段但未選出球軌跡，可嘗試降低 --conf（例如 0.03）再跑一次。")
    elif best_track_id is None and sum(1 for d in raw_detections if d.get("dets_list")) == 0:
        print("提示：未偵測到球，請確認權重路徑與影片內容；可嘗試降低 --conf（例如 0.03）。")

    first_release_adjusted = False
    first_ball_frame_idx = None

    # Fallback：若追蹤無法挑出合理 track（例如影片很短/偵測很少），改用逐幀貪婪選點
    # 仍保留「尺寸/踝部排除」的 dets_list，因此比原本的「只挑最高分」穩定很多。
    last_point = None
    last_vel = None

    for frame_data in raw_detections:
        frame_rgb = frame_data["frame_rgb"]
        fid = frame_data["frame_id"]
        has_pose = frame_data["has_pose"]
        pose_landmarks = frame_data["pose_landmarks"]

        # 先嘗試用 pose 的出手幀記錄 release point（即使該幀沒有球偵測）
        if (
            not first_release_adjusted
            and release_pose_frame_idx is not None
            and fid == release_pose_frame_idx
            and has_pose
        ):
            image_h, image_w, _ = frame_rgb.shape
            rp = _extract_release_point_from_pose(
                pose_landmarks, image_w=image_w, image_h=image_h, throwing_hand=throwing_hand
            )
            if rp is not None:
                release_point = rp
                first_release_adjusted = True
                print(f"記錄出球點（pose 幀 {fid}）")

        point = None
        if best_track_id is not None:
            point = tracks_by_frame.get(fid, {}).get(best_track_id)
        else:
            dets_list = frame_data["dets_list"]
            if dets_list:
                # 從過濾後候選中，優先挑「接近預測位置」者；沒有歷史時挑最高分
                cand_centers = []
                for d in dets_list:
                    x1, y1, x2, y2, conf, _ = d.tolist()
                    cx = int((x1 + x2) / 2)
                    cy = int((y1 + y2) / 2)
                    cand_centers.append((cx, cy, float(conf)))

                if last_point is None:
                    point = max(cand_centers, key=lambda c: c[2])[:2]
                else:
                    pred = last_point
                    if last_vel is not None:
                        pred = (int(last_point[0] + last_vel[0]), int(last_point[1] + last_vel[1]))

                    # 距離太離譜的直接不選（避免突然跳到腳）
                    max_jump = width * 0.25
                    best = None
                    best_cost = 1e18
                    for cx, cy, conf in cand_centers:
                        dist = float(np.hypot(cx - pred[0], cy - pred[1]))
                        if dist > max_jump:
                            continue
                        # cost: 距離為主，置信度為輔（越高越好）
                        cost = dist - (conf * 50.0)
                        if cost < best_cost:
                            best_cost = cost
                            best = (cx, cy)
                    point = best

        if point is None:
            pitch_frames.append(FrameInfo(frame_rgb, False))
            continue

        centerX, centerY = point

        # 更新 fallback 的速度估計（即便走 track 模式也可以讓後續更穩）
        if last_point is not None:
            last_vel = (centerX - last_point[0], centerY - last_point[1])
        last_point = (centerX, centerY)

        if first_ball_frame_idx is None:
            first_ball_frame_idx = fid

        # 若 pose 出手幀未成功記錄（例如 pose 缺失/信心不足），退回用「第一個球偵測點」記錄一次
        if not first_release_adjusted and fid == first_ball_frame_idx:
            if has_pose:
                image_h, image_w, _ = frame_rgb.shape
                rp = _extract_release_point_from_pose(
                    pose_landmarks, image_w=image_w, image_h=image_h, throwing_hand=throwing_hand
                )
                release_point = rp if rp is not None else (centerX, centerY)
            else:
                release_point = (centerX, centerY)
            first_release_adjusted = True
            print(f"使用第一個球偵測點作為出球點（幀 {fid}）")

        color = (255, 255, 0)
        pitch_frames.append(FrameInfo(frame_rgb, True, (centerX, centerY), color))

    # 計算球速
    speed_info = {}
    if speed_calculator and len(pitch_frames) > 0:
        # 提取所有有球的 frame 的座標
        ball_trajectory = [
            frame.ball for frame in pitch_frames 
            if frame.ball_in_frame
        ]
        
        # 若 pose 不可靠導致出球點退化成「第一顆球的位置」，用軌跡前段反推一個較合理的出球點
        # （主要用於 overlay 標記，避免出球點落在打者腳邊或畫面中段）
        if len(ball_trajectory) >= 2:
            p0 = ball_trajectory[0]
            p1 = ball_trajectory[1]
            vx = p1[0] - p0[0]
            vy = p1[1] - p0[1]
            # 速度太小通常代表誤判或幾乎沒動，不做反推
            if (vx * vx + vy * vy) >= 4:
                frames_back = 2.5  # 與 BallSpeedCalculator.calculate_release_speed 預設一致
                est_x = int(p0[0] - vx * frames_back)
                est_y = int(p0[1] - vy * frames_back)
                est_x = max(0, min(width - 1, est_x))
                est_y = max(0, min(height - 1, est_y))
                
                # 只有在 release_point 不存在或明顯是退化值（與第一點相同）時才覆蓋
                if release_point is None or release_point == p0:
                    release_point = (est_x, est_y)
        
        if len(ball_trajectory) >= 2:
            speed_info = speed_calculator.calculate_speed_detailed(
                ball_trajectory,
                release_point=release_point
            )
            
            # 添加 release_point 到 speed_info 以便在 overlay 中繪製
            if release_point:
                speed_info['release_point'] = release_point
            
            # 顯示計算結果
            if speed_info and not speed_info.get('error'):
                calc_method = speed_info.get('calculation_method', 'unknown')
                
                # 轉換函數
                def kmh_to_mph(kmh):
                    return kmh * 0.621371 if kmh else None
                
                print(f"\n{'='*60}")
                print(f"球速測定結果")
                if calc_method == 'theoretical':
                    print(f"（基於輸入距離計算）")
                print(f"{'='*60}")
                
                if speed_info.get('release_speed_kmh'):
                    kmh = speed_info['release_speed_kmh']
                    mph = kmh_to_mph(kmh)
                    print(f"  出手球速: {kmh:.1f} km/h ({mph:.1f} mph)")
                
                if speed_info.get('initial_speed_kmh'):
                    kmh = speed_info['initial_speed_kmh']
                    mph = kmh_to_mph(kmh)
                    print(f"  初速度:   {kmh:.1f} km/h ({mph:.1f} mph)")
                
                if speed_info.get('max_speed_kmh'):
                    kmh = speed_info['max_speed_kmh']
                    mph = kmh_to_mph(kmh)
                    print(f"  最大速度: {kmh:.1f} km/h ({mph:.1f} mph)")
                
                if speed_info.get('average_speed_kmh'):
                    kmh = speed_info['average_speed_kmh']
                    mph = kmh_to_mph(kmh)
                    print(f"  平均速度: {kmh:.1f} km/h ({mph:.1f} mph)")
                
                if speed_info.get('total_distance_m'):
                    print(f"  飛行距離: {speed_info['total_distance_m']:.2f} m")
                
                if speed_info.get('num_frames'):
                    print(f"  追蹤幀數: {speed_info['num_frames']} frames")
                
                print(f"{'='*60}\n")

    # 補齊少量漏追蹤，讓軌跡更順（若點數不足則函式會直接略過）
    fill_lost_tracking(pitch_frames)

    return pitch_frames, width, height, fps, speed_info

