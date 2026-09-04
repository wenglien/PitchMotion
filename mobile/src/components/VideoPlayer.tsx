import React, { useEffect } from 'react';
import {
  StyleSheet,
  View,
  ViewStyle,
  ActivityIndicator,
  TouchableOpacity,
  Text,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { useIsFocused } from '@react-navigation/native';

interface Props {
  uri: string;
  style?: ViewStyle;
  /** width / height. e.g. 16/9 (default), 9/16 for portrait. */
  aspectRatio?: number;
  /** Start playing as soon as ready. */
  autoPlay?: boolean;
  /** Loop playback. */
  loop?: boolean;
}

export default function VideoPlayer({
  uri,
  style,
  aspectRatio = 16 / 9,
  autoPlay = false,
  loop = false,
}: Props) {
  const isFocused = useIsFocused();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = loop;
    p.timeUpdateEventInterval = 0.25;
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: 0,
    bufferedPosition: 0,
  });

  const isLoading = status === 'loading';
  const isError = status === 'error';
  const duration = player.duration || 0;
  const reachedEnd =
    !loop &&
    duration > 0 &&
    currentTime >= duration - 0.1 &&
    !isPlaying;

  useEffect(() => {
    if (!isFocused) player.pause();
    else if (autoPlay && status === 'readyToPlay') {
      player.play();
    }
  }, [autoPlay, isFocused, status, player]);

  const handleReplay = () => {
    player.currentTime = 0;
    player.play();
  };

  return (
    <View style={[styles.container, { aspectRatio }, style]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
      />

      {isLoading && (
        <View pointerEvents="none" style={styles.overlay}>
          <ActivityIndicator size="large" color="#ffffff" />
          <Text style={styles.overlayText}>載入中…</Text>
        </View>
      )}

      {isError && (
        <View pointerEvents="none" style={styles.overlay}>
          <Text style={styles.errorTitle}>無法載入影片</Text>
          <Text style={styles.overlayText}>本機影片可能已移除，請重新選取原始影片。</Text>
        </View>
      )}

      {reachedEnd && (
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={0.85}
          onPress={handleReplay}
          accessibilityRole="button"
          accessibilityLabel="重新播放影片"
        >
          <View style={styles.replayBtn}>
            <Text style={styles.replayIcon}>↻</Text>
          </View>
          <Text style={styles.overlayText}>點擊重播</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderRadius: 12,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  overlayText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
  errorTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  replayBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  replayIcon: {
    fontSize: 34,
    fontWeight: '700',
    color: '#0f172a',
    lineHeight: 38,
  },
});
