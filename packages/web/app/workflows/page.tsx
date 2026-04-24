"use client";

import Link from "next/link";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { PageDescription } from "@/components/ui/page-description";

/**
 * Workflows hub — the landing page for multi-entity operational flows
 * that don't fit a single CRUD shape. Three large action tiles, each
 * linking to its own guided wizard. Deliberately minimal chrome: the
 * value is in making the three workflows discoverable and equally
 * weighted, not in dressing up the page.
 */

interface WorkflowTile {
  title: string;
  description: string;
  href: string;
  accent: string;
  glyph: string;
  module: string;
}

const TILES: WorkflowTile[] = [
  {
    title: "Move In",
    description:
      "Onboard a new customer at a premise: create customer, account, and service agreements in one atomic transaction, with optional initial meter reads.",
    href: "/workflows/move-in",
    accent: "var(--success)",
    glyph: "→◉",
    module: "workflows",
  },
  {
    title: "Move Out",
    description:
      "Close out all active service agreements on an account at a premise. Record final meter reads, capture a forwarding address, and optionally close the account.",
    href: "/workflows/move-out",
    accent: "var(--warning)",
    glyph: "◉→",
    module: "workflows",
  },
  {
    title: "Transfer Service",
    description:
      "Reassign an active service agreement from one account to another as of a transfer date, with optional final and initial meter readings.",
    href: "/workflows/transfer",
    accent: "var(--info)",
    glyph: "◉⇄◉",
    module: "workflows",
  },
];

export default function WorkflowsHubPage() {
  const { canView } = usePermission("workflows");
  if (!canView) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "1080px" }}>
      <h1
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "28px",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          margin: "0 0 16px 0",
          color: "var(--text-primary)",
        }}
      >
        WORKFLOWS
      </h1>
      <div style={{ marginBottom: 24 }}>
        <PageDescription storageKey="workflows">
          <b>Workflows</b> are multi-entity operations that touch customer,
          account, and service-agreement records together. Each flow commits
          in a single database transaction — partial state is never possible,
          so a move-in that can't create an agreement rolls back the customer
          and account it just created rather than leaving orphans.
        </PageDescription>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "20px",
        }}
      >
        {TILES.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            style={{
              display: "block",
              padding: "28px 24px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              textDecoration: "none",
              color: "inherit",
              position: "relative",
              overflow: "hidden",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.borderColor = tile.accent;
              e.currentTarget.style.boxShadow = `0 8px 24px rgba(0,0,0,0.18)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "3px",
                background: tile.accent,
              }}
            />
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "28px",
                color: tile.accent,
                marginBottom: "12px",
                letterSpacing: "-0.02em",
              }}
            >
              {tile.glyph}
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "14px",
                fontWeight: 700,
                letterSpacing: "0.04em",
                color: "var(--text-primary)",
                marginBottom: "8px",
              }}
            >
              {tile.title.toUpperCase()}
            </div>
            <p
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                margin: 0,
                lineHeight: 1.55,
              }}
            >
              {tile.description}
            </p>
            <div
              style={{
                marginTop: "20px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "0.04em",
                color: tile.accent,
              }}
            >
              START →
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
