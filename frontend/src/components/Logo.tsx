// The Tabellar mark: three tablets set together, one of them sealed. The
// channel between them is the T.
const SQUIRCLE = "M61.00 32.00L60.94 42.56L60.76 46.25L60.45 48.94L60.02 51.10L59.46 52.91L58.76 54.46L57.93 55.79L56.94 56.94L55.79 57.93L54.46 58.76L52.91 59.46L51.10 60.02L48.94 60.45L46.25 60.76L42.56 60.94L32.00 61.00L21.44 60.94L17.75 60.76L15.06 60.45L12.90 60.02L11.09 59.46L9.54 58.76L8.21 57.93L7.06 56.94L6.07 55.79L5.24 54.46L4.54 52.91L3.98 51.10L3.55 48.94L3.24 46.25L3.06 42.56L3.00 32.00L3.06 21.44L3.24 17.75L3.55 15.06L3.98 12.90L4.54 11.09L5.24 9.54L6.07 8.21L7.06 7.06L8.21 6.07L9.54 5.24L11.09 4.54L12.90 3.98L15.06 3.55L17.75 3.24L21.44 3.06L32.00 3.00L42.56 3.06L46.25 3.24L48.94 3.55L51.10 3.98L52.91 4.54L54.46 5.24L55.79 6.07L56.94 7.06L57.93 8.21L58.76 9.54L59.46 11.09L60.02 12.90L60.45 15.06L60.76 17.75L60.94 21.44Z";

export function Mark({ size = 22, className = "" }: { size?: number; className?: string }) {
  const small = size < 24;
  const gap = small ? 6.5 : 5;
  const top = small ? 21 : 22;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={`shrink-0 ${className}`} aria-hidden>
      <clipPath id="tabellar-mark"><path d={SQUIRCLE} /></clipPath>
      <g clipPath="url(#tabellar-mark)">
        <rect width="64" height={top} fill="var(--ink)" />
        <rect y={top + gap} width={32 - gap / 2} height="64" fill="var(--ink)" />
        <rect x={32 + gap / 2} y={top + gap} width="40" height="64" fill="var(--wax)" />
      </g>
    </svg>
  );
}

export default function Logo({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.42em] text-ink ${className}`} style={{ fontSize: size * 0.78 }}>
      <Mark size={size} />
      <span className="font-brand font-[650] leading-none tracking-[0.004em] pb-px">Tabellar</span>
    </span>
  );
}
