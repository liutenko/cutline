interface Props { values: number[]; baseline: number; width?: number; height?: number; tone: 'up' | 'down' | 'flat' }

export function Sparkline({ values, baseline, width = 132, height = 36, tone }: Props) {
  if (values.length < 2) return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(baseline, ...values);
  const hi = Math.max(baseline, ...values);
  const span = hi - lo || 1;
  const x = (i: number): number => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number): number => height - 3 - ((v - lo) / span) * (height - 6);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className={`spark ${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Paper equity over time" role="img">
      <line className="spark-base" x1="0" x2={width} y1={y(baseline)} y2={y(baseline)} />
      <polyline points={pts} fill="none" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r="2" />
    </svg>
  );
}
