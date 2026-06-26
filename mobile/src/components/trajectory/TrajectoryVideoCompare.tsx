import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { useVideoPlayer, VideoView } from 'expo-video';
import { PitchResult } from '../../types';
import { Colors, FontSize, Radius, Spacing } from '../../theme';

interface Props {
  pitch: PitchResult;
  pitchColor: string;
}

function resolveUri(pitch: PitchResult) {
  return pitch.overlay_uri || pitch.overlay_url || pitch.original_url || null;
}

function TrajectoryVideoCompareInner({
  uri,
  pitch,
  pitchColor,
}: {
  uri: string;
  pitch: PitchResult;
  pitchColor: string;
}) {
  const points = pitch.trajectory_points_norm ?? [];
  const videoW = pitch.video_width ?? pitch.trajectory_metadata?.video_width ?? 16;
  const videoH = pitch.video_height ?? pitch.trajectory_metadata?.video_height ?? 9;

  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
  });

  const polyline = useMemo(() => {
    if (!points.length) return '';
    return points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ');
  }, [points]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>原始影片對照</Text>
      <Text style={styles.sub}>下方為分析疊加影片與偵測軌跡</Text>
      <View style={[styles.videoBox, { aspectRatio: videoW / videoH }]}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
        />
        {polyline ? (
          <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
            <Polyline
              points={polyline}
              fill="none"
              stroke={pitchColor}
              strokeWidth={0.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.92}
            />
            {points.map((p, i) => (
              <Circle
                key={`pt-${i}`}
                cx={p.x * 100}
                cy={p.y * 100}
                r={i === points.length - 1 ? 1.4 : 0.6}
                fill={i === points.length - 1 ? '#fff' : pitchColor}
                opacity={0.9}
              />
            ))}
          </Svg>
        ) : null}
      </View>
    </View>
  );
}

export default function TrajectoryVideoCompare({ pitch, pitchColor }: Props) {
  const uri = resolveUri(pitch);
  if (!uri) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>此筆分析沒有可對照的疊加影片</Text>
      </View>
    );
  }
  return <TrajectoryVideoCompareInner uri={uri} pitch={pitch} pitchColor={pitchColor} />;
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    marginTop: Spacing.sm,
  },
  title: {
    fontSize: FontSize.md,
    fontWeight: '800',
    color: Colors.text,
  },
  sub: {
    marginTop: 2,
    marginBottom: Spacing.sm,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  videoBox: {
    width: '100%',
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  empty: {
    padding: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
});
