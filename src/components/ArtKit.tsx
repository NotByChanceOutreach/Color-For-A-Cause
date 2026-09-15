/** Decorative marks. Always aria-hidden. Never sit inside printable artwork. */

type Props = { className?: string };

export function ArtImg({
  src,
  alt,
  className,
  loading,
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
}) {
  const webp = src.replace(/\.jpe?g$/i, ".webp");
  return (
    <picture>
      <source srcSet={webp} type="image/webp" />
      <img src={src} alt={alt} className={className} loading={loading} />
    </picture>
  );
}

export function Tape({ className = "" }: Props) {
  return (
    <svg className={`doodle tape-svg ${className}`} viewBox="0 0 90 28" aria-hidden="true" focusable="false">
      <rect x="1" y="4" width="88" height="18" rx="2" fill="#e6d29a" stroke="#241910" strokeWidth="1.4" transform="rotate(-6 45 14)" opacity="0.92" />
      <path d="M10 10h70M12 16h66" stroke="#cbb56e" strokeWidth="0.8" opacity="0.5" />
    </svg>
  );
}

export function Pin({ className = "" }: Props) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 24 28" aria-hidden="true" focusable="false">
      <circle cx="12" cy="9" r="7" fill="#d4533a" stroke="#241910" strokeWidth="1.6" />
      <circle cx="10" cy="7" r="2" fill="#f4c4b8" />
      <path d="M12 16v10" stroke="#241910" strokeWidth="1.6" />
    </svg>
  );
}

export function Crayon({ className = "", color = "#3e74b0" }: Props & { color?: string }) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 18 72" aria-hidden="true" focusable="false">
      <path d="M5 12h8v50H5z" fill={color} stroke="#241910" strokeWidth="1.5" />
      <path d="M5 12l4-10 4 10" fill={color} stroke="#241910" strokeWidth="1.5" />
      <rect x="5" y="18" width="8" height="8" fill="#f3ead6" stroke="#241910" strokeWidth="1.2" />
    </svg>
  );
}

export function Pencil({ className = "" }: Props) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 16 80" aria-hidden="true" focusable="false">
      <path d="M4 14h8v52H4z" fill="#e8b63a" stroke="#241910" strokeWidth="1.5" />
      <path d="M4 14l4-12 4 12" fill="#f3ead6" stroke="#241910" strokeWidth="1.5" />
      <path d="M6 6l2-4 2 4" fill="#241910" />
      <rect x="4" y="58" width="8" height="16" fill="#c45a28" stroke="#241910" strokeWidth="1.4" />
    </svg>
  );
}

export function Marker({ className = "" }: Props) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 20 70" aria-hidden="true" focusable="false">
      <rect x="5" y="16" width="10" height="48" rx="2" fill="#2a4060" stroke="#241910" strokeWidth="1.5" />
      <rect x="6" y="6" width="8" height="14" fill="#355a43" stroke="#241910" strokeWidth="1.4" />
      <path d="M8 6v-4h4v4" stroke="#241910" strokeWidth="1.4" fill="#f3ead6" />
    </svg>
  );
}

export function Brush({ className = "" }: Props) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 18 78" aria-hidden="true" focusable="false">
      <rect x="7" y="22" width="4" height="50" fill="#8b5a2b" stroke="#241910" strokeWidth="1.3" />
      <path d="M3 22c2-14 12-18 12 0H3z" fill="#241910" />
      <path d="M5 18c3-8 8-8 10 0" fill="#c45a28" />
    </svg>
  );
}

export function Snowflake({ className = "" }: Props) {
  return (
    <svg className={`doodle flake ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2v20M4 6l16 12M4 18L20 6M2 12h20" stroke="#2a4060" strokeWidth="1.4" fill="none" opacity="0.55" />
    </svg>
  );
}

export function Star({ className = "" }: Props) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2l2.4 7.2H22l-6 4.4 2.3 7.2L12 16.8 5.7 20.8 8 13.6 2 9.2h7.6z" fill="#e8b63a" stroke="#241910" strokeWidth="1.2" />
    </svg>
  );
}

export function PaintDot({ className = "", color = "#c45a28" }: Props & { color?: string }) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 28 22" aria-hidden="true" focusable="false">
      <path d="M4 12c2-8 18-10 20 0 1 6-6 8-11 7C7 18 2 17 4 12z" fill={color} opacity="0.85" />
    </svg>
  );
}

export function Clip({ className = "" }: Props) {
  return (
    <svg className={`doodle ${className}`} viewBox="0 0 28 36" aria-hidden="true" focusable="false">
      <path d="M8 10v16c0 6 12 6 12 0V8c0-4-8-4-8 1v14" fill="none" stroke="#2a4060" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Snow({ count = 10 }: { count?: number }) {
  return (
    <div className="snow" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ left: `${(i * 9.7) % 100}%`, animationDelay: `${i * 0.35}s` }} />
      ))}
    </div>
  );
}

export function Confetti() {
  const colors = ["#c45a28", "#e8b63a", "#3e74b0", "#355a43", "#d4533a", "#2a4060"];
  return (
    <div className="confetti" aria-hidden="true">
      {colors.concat(colors).map((c, i) => (
        <i key={i} style={{ left: `${6 + i * 7.5}%`, background: c, animationDelay: `${i * 0.08}s` }} />
      ))}
    </div>
  );
}

export function PencilWait() {
  return (
    <div className="pencil-wait" role="status" aria-label="Loading">
      <Pencil />
      <span>Drawing a circle…</span>
    </div>
  );
}

export function Peek({ who, side = "left" }: { who: "pup" | "snug" | "lodge"; side?: "left" | "right" }) {
  const src = who === "pup" ? "/art/pup-color.jpg" : who === "snug" ? "/art/snug-color.jpg" : "/art/lodge-color.jpg";
  return (
    <span aria-hidden="true">
      <ArtImg className={`peek peek-${side} peek-${who}`} src={src} alt="" />
    </span>
  );
}
