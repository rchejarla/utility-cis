"use client";

import Link from "next/link";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faInbox } from "@fortawesome/pro-solid-svg-icons";

interface ListEmptyCtaProps {
  /**
   * Entity noun in the singular ("customer", "rate schedule"). Used to
   * build the default headline and CTA label if overrides aren't given.
   */
  subject: string;
  /**
   * Optional headline override. Defaults to "No {subject}s yet".
   */
  headline?: string;
  /**
   * Optional short description shown below the headline. 1–2 sentences
   * max — emit only when there's a genuinely non-obvious concept to
   * explain, otherwise the button alone is enough.
   */
  description?: string;
  /**
   * Primary action. When omitted the block becomes a read-only muted
   * "No {subject}s yet" panel — used in embedded contexts where the
   * surrounding page, not this block, owns the create flow.
   */
  action?: {
    label: string;
    href: string;
  };
  /** Optional icon override. Defaults to a muted inbox. */
  icon?: IconDefinition;
}

/**
 * Empty-state call-to-action rendered by EntityListPage when a list
 * has zero rows AND no filters / search have been applied — i.e.
 * a genuinely fresh state, not a "no matches for your filter" case.
 * Replaces the empty table + filter bar with a single focused block
 * that teaches the user what the page is for and how to start.
 */
export function ListEmptyCta({
  subject,
  headline,
  description,
  action,
  icon,
}: ListEmptyCtaProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "56px 24px",
        margin: "20px auto 0",
        maxWidth: 560,
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-card)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 999,
          background: "var(--bg-elevated)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
        }}
        aria-hidden
      >
        <FontAwesomeIcon icon={icon ?? faInbox} style={{ width: 20, height: 20 }} />
      </div>
      <h3
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 600,
          color: "var(--text-primary)",
        }}
      >
        {headline ?? `No ${subject}s yet`}
      </h3>
      {description && (
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            maxWidth: 420,
          }}
        >
          {description}
        </p>
      )}
      {action && (
        <Link
          href={action.href}
          style={{
            marginTop: 6,
            display: "inline-flex",
            alignItems: "center",
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 600,
            background: "var(--accent-primary)",
            color: "#fff",
            border: "none",
            borderRadius: "var(--radius)",
            textDecoration: "none",
          }}
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
