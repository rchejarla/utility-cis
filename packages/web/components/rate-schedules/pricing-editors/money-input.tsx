"use client";

/**
 * A numeric input that says it holds money.
 *
 * The rate boxes were bare numbers, so nothing on the form
 * distinguished `2.15` the price from `5` the tier threshold beside it
 * — one is dollars, the other is HCF of water.
 *
 * The symbol is `$`, hard-coded, matching how every amount in the app
 * is already printed (`accounts/[id]/page.tsx`, `bills/page.tsx`).
 * There is no currency on `Utility` or in `utility_config`, so USD is
 * the system's standing assumption rather than a choice made here; a
 * second currency would be a data-model change, and this adornment
 * would be one of its smaller edits.
 *
 * `step` defaults to 0.0001 because per-unit energy rates are
 * authored to four places (0.0741/kWh) and a coarser step would make
 * the browser's own validation reject a real tariff.
 */
interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name — required, since these sit in unlabelled table cells. */
  ariaLabel: string;
  step?: string;
  style?: React.CSSProperties;
}

export function MoneyInput({ value, onChange, ariaLabel, step = "0.0001", style }: Props) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 8,
          fontSize: 12,
          color: "var(--text-muted)",
          pointerEvents: "none",
        }}
      >
        $
      </span>
      <input
        type="number"
        step={step}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...baseInputStyle, ...style, paddingLeft: 20 }}
      />
    </div>
  );
}

const baseInputStyle = {
  width: "100%",
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
};
