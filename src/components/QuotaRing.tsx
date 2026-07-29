/**
 * The free-tier quota, as a ring.
 *
 * This is the most commercially important number in the app and it used to render as a grey pill
 * of text ("Free · 3 of 10 used"), which nobody reads until it is already 10 of 10. A ring makes
 * running out visible several turns before it happens, and it turns amber for the last two so the
 * paywall is never a surprise.
 */
const SIZE = 40;
const STROKE = 4;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function QuotaRing({ used, limit }: { used: number; limit: number }) {
  const safeLimit = limit > 0 ? limit : 1;
  const fraction = Math.max(0, Math.min(1, used / safeLimit));
  const remaining = Math.max(0, safeLimit - used);
  // Amber for the last two turns, and the accent otherwise — the app's own warning colour, not red:
  // running low is not an error.
  const low = remaining <= 2;

  return (
    <div className="quota">
      <svg
        className="quota-ring"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${used} of ${safeLimit} free turns used`}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="quota-track"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          className="quota-fill"
          data-low={low || undefined}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        />
      </svg>
      <div className="quota-body">
        <span className="quota-count">
          {used} of {safeLimit}
        </span>
        <span className="settings-muted quota-label">
          {remaining === 0 ? 'free turns used — upgrade to continue' : 'free turns used'}
        </span>
      </div>
    </div>
  );
}
