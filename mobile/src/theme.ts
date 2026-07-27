export const Colors = {
  bg: '#edf2f7',
  bgDeep: '#0b1120',
  surface: '#ffffff',
  surface2: '#f1f5f9',
  surface3: '#e2e8f0',
  panel: '#111827',
  panel2: '#172033',
  border: '#d6deea',
  borderStrong: '#b6c2d2',
  accent: '#0ea5e9',
  accent2: '#7c3aed',
  cyan: '#06b6d4',
  green: '#10b981',
  yellow: '#f59e0b',
  red: '#ef4444',
  text: '#0f172a',
  textMuted: '#64748b',
  textInverse: '#f8fafc',
  onAccent: '#ffffff',
  accentSoft: '#e0f2fe',
  accentSubtle: '#f0f9ff',
  accentBorder: '#bae6fd',
  successSoft: '#ecfdf5',
  successBorder: '#a7f3d0',
  warningSoft: '#fffbeb',
  warningBorder: '#fde68a',
  dangerSoft: '#fef2f2',
  dangerBorder: '#fecaca',
  chartGrid: '#dbe4ef',
  chartArea: '#bae6fd',
};

export const PitchColors: Record<string, string> = {
  Fastball: '#4f8ef7',
  'Four-Seam': '#4f8ef7',
  Curveball: '#f5c542',
  Slider: '#f07a5a',
  Changeup: '#22d3a5',
  Sinker: '#9b7cfc',
  Cutter: '#f05aa5',
  Splitter: '#22c0d3',
};

export const PITCH_PALETTE = [
  '#4f8ef7', '#22d3a5', '#f5c542', '#f05a5a',
  '#7c5cfc', '#f07a5a', '#22c0d3', '#e056e0',
];

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const Radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  xxl: 24,
};

export const FontSize = {
  xs: 9,
  sm: 11,
  md: 13,
  lg: 15,
  xl: 17,
  xxl: 22,
  hero: 88,
};

export const Layout = {
  maxWidth: 760,
};

/**
 * Reusable typography tokens. Prefer these over inline `fontSize` / `fontWeight`
 * combinations so new screens stay consistent. Existing screens have inline
 * styles that we haven't migrated yet — migrate when you next touch them.
 */
export const Typography = {
  pageTitle: {
    fontSize: 24,
    fontWeight: '900' as const,
    color: Colors.text,
  },
  /** Card / section heading. e.g. "好球帶落點" */
  cardTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700' as const,
    color: '#0f172a',
  },
  metricValue: {
    fontSize: FontSize.xxl,
    fontWeight: '900' as const,
    fontVariant: ['tabular-nums'] as const,
    color: Colors.text,
  },
  metricLabel: {
    fontSize: FontSize.sm,
    fontWeight: '700' as const,
    color: Colors.textMuted,
  },
  /** Sub-heading directly under a cardTitle. e.g. "本次練習 5 球" */
  cardSub: {
    fontSize: FontSize.sm,
    fontWeight: '500' as const,
    color: '#64748b',
  },
  /** Tiny uppercase eyebrow / pill label. e.g. "PITCH LAB" */
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: '700' as const,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
    color: '#64748b',
  },
  /** Hero numeric value (e.g. mph). Uses tabular-nums for stable width. */
  numericHero: {
    fontWeight: '900' as const,
    fontVariant: ['tabular-nums'] as const,
    color: '#0f172a',
  },
  /** Standard body copy. */
  body: {
    fontSize: FontSize.md,
    fontWeight: '400' as const,
    lineHeight: 21,
    color: '#0f172a',
  },
  /** Hint / caption text. */
  caption: {
    fontSize: FontSize.sm,
    fontWeight: '400' as const,
    lineHeight: 18,
    color: '#64748b',
  },
};

/** Shared structural styles used by feature screens. */
export const Surfaces = {
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
  },
  inset: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
  },
};

/** Minimum touch-target size (Apple HIG: 44pt; Material: 48dp). */
export const TouchTarget = {
  min: 44,
};

export const Shadows = {
  card: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 4,
  },
  soft: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
};
