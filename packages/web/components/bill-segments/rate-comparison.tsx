"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * "Compare rates" for one billed period (spec 26, TOU-BIL-4): staff pick
 * one or more rates and see what the period would have cost on them.
 *
 * Self-contained so the bill dialog and the segment dialog offer the same
 * thing — the comparison is per segment, and a segment can be compared
 * before it is on a bill (generated from the agreement page) as well as
 * after. Rated on request by the API and never stored.
 */

/** A rate staff may pick, with the role it is usually billed in. */
interface ShadowOption {
  code: string;
  name: string;
  version: number;
  tou: boolean;
  role: string | null;
}

interface ShadowBillView {
  shadow: {
    schedules: Array<{ code: string; name: string; version: number }>;
    total: string;
    lines: Array<{ label: string; kindCode: string; amount: string; quantity: string | null; unit: string | null }>;
  };
  /** Comparison minus actual: positive means the comparison would have cost more. */
  difference: string;
  /** The schedules the picked rates stood in for, and the riders kept. */
  replaced: string[];
  kept: string[];
  /** Where a TOU comparison's usage by period came from; null for a standard comparison. */
  touUsageFrom?: "registers" | "intervals" | null;
}

type State =
  | { idle: true }
  | { picking: true; options: ShadowOption[] | null; selected: string[] }
  | { loading: true }
  | { data: ShadowBillView }
  | { error: string };

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;
const apiMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message.replace(/^API error \d+:\s*/, "") : fallback;

const box: React.CSSProperties = {
  padding: "10px 14px",
  background: "var(--bg-elevated)",
  borderTop: "1px solid var(--border-subtle)",
  fontSize: 12.5,
};
const link: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--accent-primary)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};
const td: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
};

export function RateComparison({ segmentId }: { segmentId: string }) {
  const [state, setState] = useState<State>({ idle: true });

  const pick = () => {
    setState({ picking: true, options: null, selected: [] });
    apiClient
      .get<{ data: ShadowOption[] }>(`/api/v1/bill-segments/${segmentId}/shadow/options`)
      .then((res) => setState({ picking: true, options: res.data ?? [], selected: [] }))
      .catch((err) => setState({ error: apiMessage(err, "Could not list the rates") }));
  };

  const compare = (codes: string[]) => {
    setState({ loading: true });
    apiClient
      .get<ShadowBillView>(`/api/v1/bill-segments/${segmentId}/shadow`, { with: codes.join(",") })
      .then((data) => setState({ data }))
      .catch((err) => setState({ error: apiMessage(err, "Could not compare") }));
  };

  const close = () => setState({ idle: true });

  if ("idle" in state) {
    return (
      <div style={{ ...box, background: "transparent", padding: "8px 14px" }}>
        <button style={link} onClick={pick}>
          Compare rates
        </button>
      </div>
    );
  }

  if ("picking" in state) {
    if (state.options === null) {
      return <div style={{ ...box, color: "var(--text-muted)" }}>Finding rates to compare with…</div>;
    }
    if (state.options.length === 0) {
      return (
        <div data-testid="shadow-picker" style={{ ...box, color: "var(--text-secondary)" }}>
          No other published rate for this service to compare with.{" "}
          <button style={link} onClick={close}>Close</button>
        </div>
      );
    }
    const { options, selected } = state;
    const toggle = (code: string) =>
      setState({
        picking: true,
        options,
        selected: selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code],
      });
    return (
      <div data-testid="shadow-picker" style={box}>
        <div style={{ color: "var(--text-secondary)", marginBottom: 6 }}>
          Compare with — pick a whole rate: an all-in tariff, or delivery and supply together. Riders on the bill carry over.
        </div>
        {options.map((o) => (
          <label key={o.code} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={selected.includes(o.code)}
              onChange={() => toggle(o.code)}
              style={{ accentColor: "var(--accent-primary)" }}
            />
            <span>{o.name}</span>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
              {o.code} v{o.version}
            </span>
            {(o.tou || o.role) && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                · {[o.tou ? "time-of-use" : null, o.role].filter(Boolean).join(", ")}
              </span>
            )}
          </label>
        ))}
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button
            onClick={() => compare(selected)}
            disabled={selected.length === 0}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 500,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              cursor: selected.length === 0 ? "default" : "pointer",
              opacity: selected.length === 0 ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            Compare
          </button>
          <button style={link} onClick={close}>Cancel</button>
        </div>
      </div>
    );
  }

  if ("loading" in state) {
    return <div style={{ ...box, color: "var(--text-muted)" }}>Rating the comparison…</div>;
  }

  if ("error" in state) {
    return (
      <div data-testid="shadow-bill" style={{ ...box, color: "var(--text-secondary)" }}>
        {state.error}{" "}
        <button style={link} onClick={pick}>Pick other rates</button>
      </div>
    );
  }

  const { shadow, difference, replaced, kept, touUsageFrom } = state.data;
  const diff = parseFloat(difference);
  const names = shadow.schedules
    .filter((s) => !kept.includes(s.code))
    .map((s) => `${s.code} v${s.version}`)
    .join(" + ");
  return (
    <div data-testid="shadow-bill" style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "var(--text-secondary)" }}>
          On <strong style={{ fontFamily: "monospace" }}>{names}</strong> this period would have cost
        </span>
        <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{fmt(shadow.total)}</span>
      </div>
      <div data-testid="shadow-scope" style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
        In place of {replaced.join(" + ")}
        {kept.length > 0 ? `; ${kept.join(", ")} kept as billed` : ""}.
      </div>
      <div
        data-testid="shadow-difference"
        style={{
          marginBottom: 8,
          color: diff > 0 ? "var(--success)" : diff < 0 ? "var(--warning)" : "var(--text-muted)",
        }}
      >
        {diff === 0
          ? "The same as billed."
          : diff > 0
            ? `${fmt(String(diff))} more than billed — the customer saved by being on their own rate.`
            : `${fmt(String(-diff))} less than billed — the comparison would have been cheaper.`}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {shadow.lines.map((l, i) => (
            <tr key={`${l.label}-${i}`}>
              <td style={{ ...td, color: "var(--text-secondary)" }}>{l.label}</td>
              <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                {l.quantity ? `${parseFloat(l.quantity).toFixed(2)}${l.unit ? ` ${l.unit}` : ""}` : "—"}
              </td>
              <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>{fmt(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
        {touUsageFrom === "intervals" &&
          "Usage by time of day worked out from this meter's interval data, with the tariff's own hours. "}
        A comparison only — rated on request from this period&apos;s reads, never stored or sent to the customer.{" "}
        <button style={link} onClick={pick}>Compare other rates</button>
      </div>
    </div>
  );
}
