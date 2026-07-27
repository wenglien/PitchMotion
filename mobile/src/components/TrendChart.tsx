import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { Colors, FontSize, Radius, Spacing, Surfaces, Typography } from '../theme';

export interface TrendDatum {
  label: string;
  value: number;
}

interface Props {
  data: TrendDatum[];
  color?: string;
  unit: string;
  title: string;
  subtitle: string;
}

const W = 340;
const H = 156;
const PAD_X = 24;
const PAD_TOP = 18;
const PAD_BOTTOM = 28;

export default function TrendChart({ data, color = Colors.accent, unit, title, subtitle }: Props) {
  const model = useMemo(() => {
    if (!data.length) return null;
    const values = data.map((item) => item.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const spread = Math.max(1, rawMax - rawMin);
    const min = rawMin - spread * 0.18;
    const max = rawMax + spread * 0.18;
    const plotW = W - PAD_X * 2;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const points = data.map((item, index) => ({
      ...item,
      x: PAD_X + (data.length === 1 ? plotW / 2 : (index / (data.length - 1)) * plotW),
      y: PAD_TOP + ((max - item.value) / Math.max(1e-6, max - min)) * plotH,
    }));
    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    const area = `${line} L ${points[points.length - 1].x} ${H - PAD_BOTTOM} L ${points[0].x} ${H - PAD_BOTTOM} Z`;
    return { points, line, area, min: rawMin, max: rawMax };
  }, [data]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        {model && (
          <View style={styles.rangePill}>
            <Text style={styles.rangeText}>{model.min.toFixed(1)}–{model.max.toFixed(1)} {unit}</Text>
          </View>
        )}
      </View>
      {!model ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>目前沒有足夠的資料可繪製趨勢。</Text>
        </View>
      ) : (
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} accessibilityLabel={`${title}趨勢圖`}>
          <Defs>
            <LinearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.28} />
              <Stop offset="1" stopColor={color} stopOpacity={0.02} />
            </LinearGradient>
          </Defs>
          {[0, 0.5, 1].map((ratio) => {
            const y = PAD_TOP + ratio * (H - PAD_TOP - PAD_BOTTOM);
            return <Line key={ratio} x1={PAD_X} x2={W - PAD_X} y1={y} y2={y} stroke={Colors.chartGrid} strokeWidth={1} />;
          })}
          <Path d={model.area} fill="url(#trendArea)" />
          <Path d={model.line} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          {model.points.map((point, index) => (
            <React.Fragment key={`${point.label}-${index}`}>
              <Circle cx={point.x} cy={point.y} r={5} fill={Colors.surface} stroke={color} strokeWidth={3} />
              {(index === 0 || index === model.points.length - 1) && (
                <SvgText
                  x={point.x}
                  y={H - 9}
                  fill={Colors.textMuted}
                  fontSize={10}
                  fontWeight="700"
                  textAnchor={index === 0 ? 'start' : 'end'}
                >
                  {point.label}
                </SvgText>
              )}
            </React.Fragment>
          ))}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    ...Surfaces.card,
    marginTop: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  headerCopy: { flex: 1 },
  title: Typography.cardTitle,
  subtitle: { ...Typography.cardSub, marginTop: 3 },
  rangePill: {
    minHeight: 30,
    justifyContent: 'center',
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.sm,
    backgroundColor: Colors.accentSubtle,
    borderWidth: 1,
    borderColor: Colors.accentBorder,
  },
  rangeText: {
    color: Colors.accent,
    fontSize: FontSize.xs,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  empty: { minHeight: 140, alignItems: 'center', justifyContent: 'center' },
  emptyText: { ...Typography.caption, textAlign: 'center' },
});
