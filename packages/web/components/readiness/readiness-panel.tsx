"use client";

import { useState } from "react";
import Link from "next/link";
import type { TenantFix } from "./tenant-fixes";

export interface ReadinessCheck {
  key: string;
  /** What is being asked, in the operator's words. */
  label: string;
  ok: boolean;
  /** What was found: the names, the count, or what is absent. */
  detail: string;
  /** What cannot happen while this is unmet. */
  blocks: string;
}

export interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

/**
 * Shows what this tenant still needs before it can operate.
 *
 * It sits directly under the tenant's stats because the stats are what
 * made it necessary: "32 modules, 6 roles" reads like readiness, and a
 * freshly provisioned tenant showing those numbers cannot bill anything.
 *
 * It opens on request, not on arrival. Most visits to that page are not
 * about readiness, and a panel that is always open states its case
 * whether or not anyone asked — so the closed state carries the whole
 * answer to "is this tenant working?" (a tick, or how many steps are
 * left) and a click produces the particulars.
 *
 * Opening shows the met checks as well as the unmet ones. There was a
 * second toggle hiding those behind their count, which is one disclosure
 * too many once the panel itself is a disclosure: an operator who has
 * asked for the detail wants the evidence for the count, not another
 * button.
 *
 * It lives here rather than in the page beside it because a Next page
 * module may export only its default and the framework's own route
 * exports — a named export from `page.tsx` fails the generated type
 * check in `.next/types`, which is how this file came to exist.
 *
 * Two readers, and the asymmetry is in `guidance` rather than in two
 * components. The platform operator gets the diagnosis: these checks,
 * and what each unmet one prevents. The tenant's own admin gets the same
 * list with a link per unmet check, because they are the only party who
 * can satisfy any of it — and `defaultOpen`, because for them it is a
 * to-do list rather than a status they came for something else.
 */
export function ReadinessPanel({
  readiness,
  guidance,
  defaultOpen = false,
}: {
  readiness: Readiness;
  /** Keyed by check; a check with no entry renders without a link. */
  guidance?: Record<string, TenantFix>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const unmet = readiness.checks.filter((c) => !c.ok);
  const ordered = [...unmet, ...readiness.checks.filter((c) => c.ok)];
  const accent = readiness.ready ? "var(--success)" : "var(--warning)";

  return (
    <div style={{ ...card, marginBottom: 20 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          width: "100%",
          padding: "12px 14px",
          border: "none",
          borderRadius: 0,
          background: "transparent",
          textAlign: "left",
          fontFamily: "inherit",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        {/* The glyph is decoration: the sentence beside it already says
            ready or not, and an operator using a screen reader should
            hear that rather than "check mark". */}
        <span aria-hidden style={{ color: accent, fontSize: 14, lineHeight: 1.3 }}>
          {readiness.ready ? "✓" : "✕"}
        </span>
        <span style={{ fontSize: 13, color: "var(--text-primary)", flex: 1 }}>
          <strong style={{ color: accent }}>
            {readiness.ready ? "Ready to operate." : "Not ready to operate."}
          </strong>{" "}
          {readiness.ready
            ? `All ${readiness.checks.length} checks met.`
            : `${unmet.length} of ${readiness.checks.length} outstanding. The tenant's own staff fix these; ` +
              "nothing here does it for them."}
        </span>
        <span aria-hidden style={{ color: "var(--text-muted)", fontSize: 11 }}>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open &&
        ordered.map((c) => (
          <div
            key={c.key}
            style={{
              padding: c.ok ? "8px 14px" : "10px 14px",
              borderTop: "1px solid var(--border-subtle)",
              display: "grid",
              gap: 2,
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: c.ok ? "var(--text-secondary)" : "var(--text-primary)",
              }}
            >
              <span
                aria-hidden
                style={{ color: c.ok ? "var(--success)" : "var(--warning)", marginRight: 8 }}
              >
                {c.ok ? "✓" : "✕"}
              </span>
              {c.label}
              <span style={{ color: "var(--text-muted)" }}> — {c.detail}</span>
            </div>
            {/* Why it matters, which is the half an operator cannot infer
                from the label. Only for what is missing: a met check
                needs no argument. */}
            {!c.ok && (
              <div style={{ fontSize: 12, color: "var(--text-secondary)", paddingLeft: 20 }}>
                {c.blocks}
                {guidance?.[c.key] && (
                  <>
                    {" "}
                    <Link
                      href={guidance[c.key].href}
                      style={{ color: "var(--accent-primary)", textDecoration: "none" }}
                    >
                      {guidance[c.key].action} →
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
