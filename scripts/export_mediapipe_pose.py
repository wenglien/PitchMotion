import cv2
import mediapipe as mp


def export_mediapipe_pose(
    input_path: str = "pitcher.mp4",
    output_path: str = "pitcher_pose.mp4",
    draw_landmarks: bool = True,
) -> None:
    """
    使用 MediaPipe Pose 讀取輸入影片，輸出帶有姿勢骨架標註的新影片。

    :param input_path: 輸入影片路徑
    :param output_path: 輸出影片路徑
    :param draw_landmarks: 是否在影像上畫出關鍵點與骨架
    """
    mp_pose = mp.solutions.pose
    mp_drawing = mp.solutions.drawing_utils
    mp_drawing_styles = mp.solutions.drawing_styles

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise RuntimeError(f"無法開啟影片檔案: {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    with mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            # OpenCV is BGR, need to convert to RGB for MediaPipe
            image_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = pose.process(image_rgb)

            if draw_landmarks and results.pose_landmarks:
                mp_drawing.draw_landmarks(
                    frame,
                    results.pose_landmarks,
                    mp_pose.POSE_CONNECTIONS,
                    landmark_drawing_spec=mp_drawing_styles.get_default_pose_landmarks_style(),
                )

            out.write(frame)

    cap.release()
    out.release()


if __name__ == "__main__":
    # Default read the pitcher.mp4 in the current directory, output pitcher_pose.mp4
    export_mediapipe_pose("pitcher.mp4", "pitcher_pose.mp4")

