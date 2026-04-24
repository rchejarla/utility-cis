"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

export interface SettingsSectionLink {
  slug: string;
  label: string;
}

export const SETTINGS_SECTIONS: SettingsSectionLink[] = [
  { slug: "general", label: "General" },
  { slug: "branding", label: "Branding" },
  { slug: "theme", label: "Theme" },
  { slug: "numbering", label: "Numbering" },
  { slug: "custom-fields", label: "Custom Fields" },
  { slug: "billing", label: "Billing Integration" },
  { slug: "notifications", label: "Notifications" },
  { slug: "slas", label: "Service Request SLAs" },
  { slug: "retention", label: "Retention & Audit" },
  { slug: "api-keys", label: "API Keys & Webhooks" },
  { slug: "danger-zone", label: "Danger Zone" },
];

export function SettingsRail() {
  const pathname = usePathname();
  const current = pathname?.replace(/^\/settings\/?/, "") || "general";

  return (
    <nav
      aria-label="Settings sections"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        position: "sticky",
        top: "24px",
      }}
    >
      {SETTINGS_SECTIONS.map((s) => {
        const isActive = current === s.slug;
        const isDanger = s.slug === "danger-zone";
        return (
          <Link
            key={s.slug}
            href={`/settings/${s.slug}`}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "9px 14px",
              fontSize: "13px",
              fontWeight: isActive ? 600 : 500,
              color: isActive
                ? isDanger
                  ? "var(--danger)"
                  : "var(--text-primary)"
                : isDanger
                  ? "var(--danger)"
                  : "var(--text-secondary)",
              background: isActive ? "var(--bg-hover)" : "transparent",
              borderRadius: "var(--radius)",
              textDecoration: "none",
              boxShadow: isActive
                ? `inset 2px 0 0 ${isDanger ? "var(--danger)" : "var(--accent-primary)"}`
                : "none",
              transition: "background 0.12s, color 0.12s",
            }}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  danger?: boolean;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  danger,
  children,
}: SettingsSectionProps) {
  return (
    <section style={{ marginBottom: "40px" }}>
      <h2
        style={{
          fontSize: "20px",
          fontWeight: 600,
          margin: "0 0 6px",
          color: danger ? "var(--danger)" : "var(--text-primary)",
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </h2>
      {description && (
        <p
          style={{
            fontSize: "13px",
            color: "var(--text-secondary)",
            margin: "0 0 20px",
            maxWidth: "60ch",
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

interface SettingsCardProps {
  danger?: boolean;
  children: ReactNode;
  padded?: boolean;
}

export function SettingsCard({ danger, children, padded = true }: SettingsCardProps) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: `1px solid ${danger ? "var(--danger)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        padding: padded ? "4px 24px" : 0,
        boxShadow: danger ? "0 0 0 1px var(--danger-subtle) inset" : "none",
      }}
    >
      {children}
    </div>
  );
}

interface SettingRowProps {
  label: string;
  description?: string;
  control: ReactNode;
}

/**
 * Grid row matching the Signet reference: label/description on the left,
 * control on the right. Rows share a hairline border so a stack of them
 * reads as one card.
 */
export function SettingRow({ label, description, control }: SettingRowProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "20px",
        alignItems: "center",
        padding: "18px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h4
          style={{
            margin: "0 0 3px",
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {label}
        </h4>
        {description && (
          <p
            style={{
              margin: 0,
              fontSize: "12px",
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}
          >
            {description}
          </p>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

/**
 * Inline input used inside a SettingRow control slot. Matches the
 * darker --bg-deep input styling used elsewhere in the CIS on
 * data-heavy detail pages.
 */
export const settingInputStyle = {
  padding: "8px 12px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "280px",
} as const;

/** Compact secondary button used for "disabled for now" actions. */
export const settingMutedBtnStyle = {
  padding: "6px 12px",
  fontSize: "12px",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-secondary)",
  cursor: "not-allowed",
} as const;

/**
 * Save bar rendered at the bottom of a settings section. Handles the
 * saving / disabled / dirty states. Matches the same pattern the
 * existing GeneralTab uses so the four new pages don't drift.
 */
interface SettingsSaveBarProps {
  saving: boolean;
  isDirty: boolean;
  canEdit: boolean;
  onSave: () => void;
  onReset?: () => void;
}

export function SettingsSaveBar({
  saving,
  isDirty,
  canEdit,
  onSave,
  onReset,
}: SettingsSaveBarProps) {
  const active = canEdit && isDirty && !saving;
  return (
    <div
      style={{
        display: "flex",
        gap: "8px",
        justifyContent: "flex-end",
        marginTop: "24px",
      }}
    >
      {onReset && isDirty && (
        <button
          type="button"
          onClick={onReset}
          disabled={saving}
          style={{
            padding: "8px 16px",
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: "13px",
            fontWeight: 500,
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          Reset
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={!active}
        style={{
          padding: "8px 20px",
          background: active ? "var(--accent-primary)" : "var(--bg-elevated)",
          color: active ? "#fff" : "var(--text-muted)",
          border: "none",
          borderRadius: "var(--radius)",
          fontSize: "13px",
          fontWeight: 600,
          cursor: active ? "pointer" : "not-allowed",
          opacity: saving ? 0.7 : 1,
        }}
      >
        {saving ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );
}

interface SettingPlaceholderProps {
  children?: ReactNode;
}

/** Empty-state banner shown inside sections that are not yet wired up. */
export function SettingPlaceholder({ children }: SettingPlaceholderProps) {
  return (
    <div
      style={{
        padding: "24px",
        background: "var(--bg-card)",
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        color: "var(--text-muted)",
        fontSize: "13px",
        lineHeight: 1.6,
      }}
    >
      {children ?? "Coming soon."}
    </div>
  );
}

export interface SettingsAccordionItem {
  id: string;
  title: ReactNode;
  /** Muted text shown next to the title (e.g. a human-readable label). */
  subtitle?: ReactNode;
  /** Right-aligned hint shown on the collapsed header (e.g. "4/4 priorities"). */
  summary?: ReactNode;
  /** Body rendered when the item is expanded. */
  content: ReactNode;
}

interface SettingsAccordionProps {
  items: SettingsAccordionItem[];
  /**
   * IDs of items to open initially. When omitted, the first item opens
   * so the page isn't blank on load. Pass [] for all collapsed.
   */
  defaultOpen?: string[];
}

/**
 * Independently-expandable accordion for settings pages that group a
 * list of similar configurations (e.g. SLAs per request type, custom
 * fields per entity). Each header stays visible so the overview stays
 * scannable; clicking a header toggles just that row. Keyboard-
 * accessible through native <button> semantics + aria-expanded.
 */
export function SettingsAccordion({ items, defaultOpen }: SettingsAccordionProps) {
  const initial = useMemo(() => {
    if (defaultOpen !== undefined) return new Set(defaultOpen);
    return new Set(items[0] ? [items[0].id] : []);
    // Deliberately only run on mount — subsequent renders with new
    // `items` should preserve whatever the user has opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [open, setOpen] = useState<Set<string>>(initial);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => {
        const isOpen = open.has(item.id);
        return (
          <div
            key={item.id}
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
              aria-controls={`accordion-body-${item.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "12px 16px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                color: "var(--text-primary)",
                textAlign: "left",
              }}
            >
              <ChevronIcon open={isOpen} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</span>
              {item.subtitle && (
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  {item.subtitle}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {item.summary && (
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {item.summary}
                </span>
              )}
            </button>
            {isOpen && (
              <div
                id={`accordion-body-${item.id}`}
                style={{
                  borderTop: "1px solid var(--border)",
                }}
              >
                {item.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.12s ease",
        color: "var(--text-muted)",
      }}
      aria-hidden
    >
      <path
        d="M4 2 L8 6 L4 10"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
