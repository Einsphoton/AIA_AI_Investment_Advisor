/**
 * Lightweight inline sparkline (pure SVG — no chart library, safe in long lists).
 * Owner: Lead.
 */
export function Sparkline(props: {
  values: number[];
  width?: number;
  height?: number;
  /** Force a colour; by default it follows first→last direction. */
  tone?: 'pos' | 'neg' | 'flat';
  className?: string;
}) {
  const { values, width = 92, height = 26, tone, className = 'sparkline' } = props;
  const clean = (values ?? []).filter((value) => Number.isFinite(value));

  if (clean.length < 2) {
    return <span className="mute tiny">—</span>;
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const stepX = width / (clean.length - 1);
  const points = clean.map((value, index) => {
    const x = index * stepX;
    const y = height - 2 - ((value - min) / span) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const direction = clean[clean.length - 1]! - clean[0]!;
  const resolvedTone = tone ?? (direction > 0 ? 'pos' : direction < 0 ? 'neg' : 'flat');
  // Mirrors --pos / --neg / --text-mute in styles.css (SVG cannot read CSS vars).
  const color = resolvedTone === 'pos' ? '#ff5a5f' : resolvedTone === 'neg' ? '#2fbf8f' : '#7d7566';
  const gradientId = `spark-${Math.abs(hash(clean.join(','))) % 100000}`;

  return (
    <svg className={className} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="走势缩略图">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points.join(' ')} ${width},${height}`} fill={`url(#${gradientId})`} />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return value;
}
