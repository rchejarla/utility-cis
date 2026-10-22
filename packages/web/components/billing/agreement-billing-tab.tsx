"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * Service agreement → Billing tab.
 *
 * An agreement's charges are its `BillSegment`s: one per billed period,
 * each priced from one schedule version. It has no bills of its own —
 * a `Bill` belongs to the Account and aggregates the segments of every
 * agreement on it, which is why the Bills tab lives there.
 *
 * Until 2026-10-22 this tab showed a mock "SaaSLogic Subscription"
 * card, an entity dropped from the design on 2026-10-09 when SaaSLogic
 * stopped doing the pricing, next to an estimated charge nothing
 * computes and a fabricated activity log. Both endpoints it needed had
 * existed since rate-model slice 5a.
 *
 * There is deliberately no "estimated charge" here. Nothing in CIS
 * estimates: a period is resolved from the meter reads, so the honest
 * forward-looking answer is the interval the next segment would cover
 * — or the reason there isn't one yet.
 */
interface AgreementBillingTabProps {
  agreementId: string;
}

interface BillSegmentSummary {
  id: string;
  segmentNumber: number;
  periodStart: string;
  periodEnd: string;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  minimumFloorApplied: boolean;
  createdAt: string;
}

/**
 * `GET .../next-service-period` answers a missing read with a 200 and a
 * reason rather than a status, so this shape carries both outcomes and
 * the component renders whichever arrived.
 */
interface NextServicePeriod {
  periodStart: string | null;
  periodEnd: string | null;
  readCount?: number;
  days?: number;
  reason?: string;
  message?: string;
}

const cardStyle = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "20px 24px",
} as const;

const cardHeadingStyle = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
  margin: "0 0 14px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
};

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "180px 1fr",
  gap: 8,
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};

const labelStyle = { fontSize: 12, color: "var(--text-muted)", fontWeight: 500 as const };
const valueStyle = { fontSize: 13, color: "var(--text-primary)" };
const monoValueStyle = {
  ...valueStyle,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
};

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;
const ymd = (s: string) => s.slice(0, 10);

export function AgreementBillingTab({ agreementId }: AgreementBillingTabProps) {
  const [segments, setSegments] = useState<BillSegmentSummary[]>([]);
  const [next, setNext] = useState<NextServicePeriod | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      apiClient
        .get<BillSegmentSummary[]>(`/api/v1/service-agreements/${agreementId}/bill-segments`)
        .catch(() => [] as BillSegmentSummary[]),
      apiClient
        .get<NextServicePeriod>(
          `/api/v1/service-agreements/${agreementId}/next-service-period`,
        )
        .catch(() => null),
    ])
      .then(([segs, np]) => {
        if (!live) return;
        setSegments(segs);
        setNext(np);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [agreementId]);

  const billed = segments.reduce((sum, s) => sum + parseFloat(s.total), 0);

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div style={cardStyle}>
          <h3 style={cardHeadingStyle}>Next period</h3>
          {loading ? (
            <div style={{ ...valueStyle, color: "var(--text-muted)" }}>Loading…</div>
          ) : next?.periodStart && next.periodEnd ? (
            <>
              <Field label="Would cover" value={`${ymd(next.periodStart)} → ${ymd(next.periodEnd)}`} />
              <Field label="Days" value={next.days != null ? String(next.days) : "—"} />
              <Field
                label="Unbilled reads"
                value={next.readCount != null ? String(next.readCount) : "—"}
              />
            </>
          ) : (
            /* The reason, verbatim from the API. It names the date it
               looked up to, which a generic "nothing to bill" would
               lose — that date is what tells a clerk whether they are
               waiting on a reader or on a cycle. */
            <div style={{ ...valueStyle, color: "var(--text-secondary)" }}>
              {next?.message ?? "No period could be resolved for this agreement."}
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <h3 style={cardHeadingStyle}>Billed to date</h3>
          <Field label="Segments" value={String(segments.length)} />
          <Field
            label="Total charged"
            valueNode={
              <span
                style={{
                  ...monoValueStyle,
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                }}
              >
                {fmt(billed.toFixed(4))}
              </span>
            }
          />
          <Field
            label="Most recent"
            value={segments[0] ? ymd(segments[0].periodEnd) : "—"}
          />
        </div>
      </div>

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-surface)",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-muted)",
          }}
        >
          Billed periods
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <Th style={{ width: 60 }}>#</Th>
              <Th style={{ width: 200 }}>Period</Th>
              <Th style={{ width: 120, textAlign: "right" }}>Subtotal</Th>
              <Th style={{ width: 110, textAlign: "right" }}>Taxes</Th>
              <Th style={{ width: 110, textAlign: "right" }}>Credits</Th>
              <Th style={{ width: 120, textAlign: "right" }}>Total</Th>
              <Th>Basis</Th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.id}>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {s.segmentNumber}
                  </span>
                </Td>
                <Td>{`${ymd(s.periodStart)} → ${ymd(s.periodEnd)}`}</Td>
                <Td style={{ textAlign: "right" }}>
                  <Money value={s.subtotal} />
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <Money value={s.taxes} />
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <Money value={s.credits} />
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <Money value={s.total} bold />
                </Td>
                <Td>
                  {s.minimumFloorApplied ? <MinimumPill /> : <Metered />}
                </Td>
              </tr>
            ))}
            {!loading && segments.length === 0 && (
              <tr>
                <Td colSpan={7}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                    No billed periods yet. A segment appears here once this agreement is
                    billed.
                  </span>
                </Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Money({ value, bold = false }: { value: string; bold?: boolean }) {
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        fontWeight: bold ? 600 : 400,
      }}
    >
      {fmt(value)}
    </span>
  );
}

/**
 * The charge is the tariff's floor, not the metered amount. Without
 * this marker the screen cannot answer "why is my bill the same every
 * month", since the figure alone looks like ordinary usage.
 */
function MinimumPill() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: 999,
        background: "var(--warning-subtle)",
        border: "1px solid var(--warning)",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--warning)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning)" }}
      />
      Minimum applied
    </span>
  );
}

function Metered() {
  return (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Metered</span>
  );
}

function Field({
  label,
  value,
  valueNode,
  mono = false,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div style={fieldStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={mono ? monoValueStyle : valueStyle}>{valueNode ?? value ?? "—"}</div>
    </div>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      scope="col"
      style={{
        padding: "10px 16px",
        textAlign: "left",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        borderBottom: "1px solid var(--border)",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
  colSpan,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: "12px 16px",
        fontSize: 13,
        color: "var(--text-primary)",
        borderBottom: "1px solid var(--border-subtle)",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </td>
  );
}
