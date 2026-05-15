import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Share } from 'react-native';
import { Colors, Spacing, Radius, FontSize, Shadows } from '../theme';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
}

/**
 * Catches render-time exceptions anywhere in the tree below it and shows a
 * friendly fallback instead of a white screen.  Without this, any uncaught
 * render error crashes the entire app.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info });
    if (__DEV__) {
      console.error('[ErrorBoundary]', error, info);
    }
    // Hook for crash reporting (Sentry/Bugsnag) — left as a no-op for now.
  }

  reset = () => this.setState({ error: null, info: null });

  shareDetails = async () => {
    const { error, info } = this.state;
    if (!error) return;
    const payload = [
      `SpeedGun crash report`,
      `Platform: ${Platform.OS} ${Platform.Version}`,
      `Time: ${new Date().toISOString()}`,
      ``,
      `Error: ${error.name}: ${error.message}`,
      ``,
      `Stack:`,
      error.stack || '(no stack)',
      ``,
      `Component stack:`,
      info?.componentStack || '(none)',
    ].join('\n');
    try {
      await Share.share({ message: payload });
    } catch {
      // user dismissed or share unavailable — silent fallback
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>!</Text>
          </View>
          <Text style={styles.title}>App 發生了非預期的錯誤</Text>
          <Text style={styles.subtitle}>
            別擔心，你的資料都還在。請點擊「重新載入」回到主畫面，再試一次。
            若同樣錯誤一直發生，請複製錯誤訊息回報給開發者。
          </Text>

          <View style={styles.errorCard}>
            <Text style={styles.errorLabel}>錯誤類型</Text>
            <Text style={styles.errorVal}>{error.name}</Text>
            <View style={styles.divider} />
            <Text style={styles.errorLabel}>訊息</Text>
            <Text style={styles.errorVal}>{error.message}</Text>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={this.reset} activeOpacity={0.8}>
            <Text style={styles.primaryBtnText}>重新載入</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={this.shareDetails} activeOpacity={0.7}>
            <Text style={styles.secondaryBtnText}>分享完整錯誤訊息</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xxxl,
    gap: Spacing.md,
  },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(239,68,68,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  iconText: {
    fontSize: 28,
    fontWeight: '900',
    color: Colors.red,
    lineHeight: 32,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: Spacing.md,
  },
  errorCard: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    ...Shadows.soft,
  },
  errorLabel: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  errorVal: {
    fontSize: FontSize.sm,
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  primaryBtn: {
    width: '100%',
    height: 50,
    borderRadius: Radius.xl,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.md,
  },
  primaryBtnText: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.3,
  },
  secondaryBtn: {
    width: '100%',
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  secondaryBtnText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.accent,
  },
});
