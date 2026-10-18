"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { usePermission } from "@/lib/use-permission";
import { useAuth } from "@/lib/auth-context";
import { visibleNavItems } from "@/lib/nav-visibility";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faLocationDot,
  faGauge,
  faUser,
  faUsers,
  faFileContract,
  faMoneyBill,
  faMoneyBillTransfer,
  faCalendarDays,
  faDroplet,
  faClipboardList,
  faClipboardCheck,
  faGear,
  faBars,
  faBolt,
  faTriangleExclamation,
  faDumpster,
  faPauseCircle,
  faTruck,
  faArrowRightArrowLeft,
  faUserShield,
  faEnvelope,
  faScaleUnbalanced,
  faPlugCircleXmark,
  faPalette,
  faPaintbrush,
  faHashtag,
  faListCheck,
  faCreditCard,
  faBell,
  faStopwatch,
  faBoxArchive,
  faKey,
  faBomb,
  faRobot,
  faRulerHorizontal,
  faFileImport,
  faHouse,
  faIdCard,
  faScaleBalanced,
  faFileInvoiceDollar,
  faPlay,
  faFileInvoice,
  faCommentDots,
  // Section headers. Deliberately not reused from the items below: a
  // header wearing an item's icon reads as that item.
  faBriefcase,
  faRecycle,
  faMoneyCheckDollar,
  faHandHoldingDollar,
  faSliders,
  faGears,
  faShieldHalved,
  faChevronRight,
} from "@fortawesome/pro-solid-svg-icons";

interface NavItem {
  href: string;
  label: string;
  icon: IconDefinition;
  module: string;
  /**
   * Optional hover tooltip shown when sidebar is expanded. Useful for
   * expanding acronyms or adding clarifying context without lengthening
   * the visible label (e.g. "RAMS Events" tooltipped as "Route and
   * Asset Management System — solid-waste field events").
   */
  tooltip?: string;
}

interface NavSection {
  title: string;
  /**
   * Shown beside the header. Seven uppercase words in a column read as
   * a table of contents — the icon is what lets the eye find a section
   * by shape instead of by reading each label.
   */
  icon: IconDefinition;
  items: NavItem[];
  /**
   * Collapse this section on first visit. Daily-use sections default
   * to open; rarely-visited groups (Settings, Administration) default
   * to closed so the sidebar stays calm. Applied only when the user
   * hasn't explicitly toggled the section — their choice persists
   * after.
   */
  defaultCollapsed?: boolean;
}

/*
 * Each section answers one question, and that sentence decides what
 * belongs in it:
 *
 *   Operations      — the utility's business records, and the
 *                     transactions on them. About customers and their
 *                     service.
 *   Configuration   — lists the business maintains. Many rows.
 *   Settings        — one value per tenant. One row.
 *   Administration  — the system itself: who may use it, and whether it
 *                     is sound. About staff and the software.
 *
 * The first two of those read "work somebody does" and "who may act",
 * which were too loose to decide anything: somebody reads the audit log
 * too. What separates the two sections is the subject — customers and
 * their service, versus staff and the software. That is also why one
 * log sits in each: the delivery log answers "did my customer get their
 * notice", the audit log answers "what did our staff do".
 *
 * One entry straddles the line and is left straddling it: Operations →
 * Notifications is a delivery log (Operations, by the rule) and a
 * template list (Configuration, by the rule) on a single page. Splitting
 * a working screen to satisfy a menu rule is the wrong trade, so it
 * stays — but the rule should not pretend the case is clean.
 *
 * Settings held eighteen entries before this, mixing all four kinds:
 * single-value tenant config next to multi-row reference data
 * (Custom Fields, Bill Messages, SLAs), next to access control, next
 * to three things that are not settings at all — Imports is weekly
 * work, Audit Log is a report, Ledger Integrity is a diagnostic. The
 * rule above is the decision; the groupings below only follow from it.
 *
 * The test, borrowed from the Billing Runs note below: a cycle is a
 * setting somebody edits twice a year, a run is work somebody does
 * every month.
 *
 * NOTE: the `module` gates are deliberately unchanged here, so this is
 * a pure relabelling with no effect on who can see which page. They
 * are still inconsistent — `tenant_profile`, `settings` and `theme`
 * across what now reads as three sections — and settling that is an
 * API change, not a nav change.
 */

const navSections: NavSection[] = [
  {
    title: "Operations",
    icon: faBriefcase,
    items: [
      { href: "/customers", label: "Customers", icon: faUsers, module: "customers" },
      { href: "/premises", label: "Premises", icon: faLocationDot, module: "premises" },
      { href: "/meters", label: "Meters", icon: faGauge, module: "meters" },
      { href: "/meter-reads", label: "Meter Reads", icon: faBolt, module: "meter_reads" },
      { href: "/meter-events", label: "Meter Events", icon: faTriangleExclamation, module: "meter_events" },
      { href: "/service-requests", label: "Service Requests", icon: faClipboardCheck, module: "service_requests" },
      { href: "/accounts", label: "Accounts", icon: faUser, module: "accounts" },
      { href: "/service-agreements", label: "Agreements", icon: faFileContract, module: "agreements" },
      { href: "/workflows", label: "Workflows", icon: faArrowRightArrowLeft, module: "workflows" },
      { href: "/notifications", label: "Notifications", icon: faEnvelope, module: "notifications" },
      {
        href: "/imports",
        label: "Imports",
        icon: faFileImport,
        // Work, not configuration: a clerk loads reads or customers on a
        // schedule. It sat under Settings, which is where you look for
        // the sender address, not for this week's meter reads.
        module: "imports",
        tooltip: "Load meter reads, customers, accounts, premises or meters from a file",
      },
    ],
  },
  {
    title: "Solid Waste",
    icon: faRecycle,
    items: [
      { href: "/containers", label: "Containers", icon: faDumpster, module: "containers" },
      { href: "/service-suspensions", label: "Service Holds", icon: faPauseCircle, module: "service_suspensions" },
      { href: "/service-events", label: "RAMS Events", icon: faTruck, module: "service_events", tooltip: "Route and Asset Management System — field events from solid-waste collection crews" },
    ],
  },
  {
    title: "Billing",
    icon: faMoneyCheckDollar,
    items: [
      {
        href: "/bills",
        label: "Bills",
        icon: faFileInvoiceDollar,
        module: "accounts",
        tooltip: "Every bill across all accounts, searchable by bill number, with posting",
      },
      {
        href: "/billing-runs",
        label: "Billing Runs",
        icon: faPlay,
        module: "accounts",
        // Under Billing rather than Configuration, where the cycle
        // lives: a cycle is a setting somebody edits twice a year, a run
        // is work somebody does every month.
        tooltip:
          "Bill a whole cycle, account by account — review what failed, then post it. Nothing is owed until the run is posted",
      },
      {
        href: "/receipts",
        label: "Receipts",
        icon: faMoneyBill,
        module: "payments",
        // Not "Payments": the list holds deposits too, because a deposit
        // taken at the counter is on the same bank slip as a cheque
        // settling a bill. A label saying "Payments" over a total that
        // includes deposits is the kind that gets trusted for the wrong
        // question.
        tooltip:
          "Payments and security deposits received across all accounts — a day's takings, for tying out against the bank",
      },
      {
        href: "/disbursements",
        label: "Disbursements",
        icon: faMoneyBillTransfer,
        module: "payments",
        // The mirror of Receipts, and its own entry rather than a filter
        // there: a receipts total ties out against a bank deposit slip,
        // which holds only money in, and this one against a cheque run.
        // One screen netting the two would break both reconciliations.
        tooltip:
          "Refunds and deposit returns across all accounts — what left the building, for tying out against the cheque run",
      },
    ],
  },
  {
    title: "Collections",
    icon: faHandHoldingDollar,
    items: [
      { href: "/delinquency", label: "Delinquency", icon: faScaleUnbalanced, module: "delinquency" },
      { href: "/delinquency/shutoff-eligible", label: "Shut-Off Queue", icon: faPlugCircleXmark, module: "delinquency" },
    ],
  },
  {
    title: "Configuration",
    icon: faSliders,
    items: [
      { href: "/commodities", label: "Commodities & UOM", icon: faDroplet, module: "commodities" },
      { href: "/measure-types", label: "Measure Types", icon: faRulerHorizontal, module: "commodities" },
      { href: "/premise-types", label: "Premise Types", icon: faHouse, module: "premises" },
      { href: "/account-types", label: "Account Types", icon: faIdCard, module: "accounts" },
      { href: "/rate-schedules", label: "Rate Schedules", icon: faMoneyBill, module: "rate_schedules" },
      { href: "/billing-cycles", label: "Billing Cycles", icon: faCalendarDays, module: "billing_cycles" },
      { href: "/settings/custom-fields", label: "Custom Fields", icon: faListCheck, module: "tenant_profile" },
      { href: "/settings/bill-messages", label: "Bill Messages", icon: faCommentDots, module: "settings" },
      { href: "/settings/slas", label: "Service Request SLAs", icon: faStopwatch, module: "service_request_slas" },
      {
        href: "/delinquency/rules",
        // "Rules" alone was readable under Collections and would not be
        // here, so the label carries its subject now that the section no
        // longer supplies it.
        label: "Delinquency Rules",
        icon: faGear,
        module: "delinquency",
        tooltip: "Tiers, thresholds and the notice each one sends",
      },
    ],
  },
  {
    title: "Settings",
    icon: faGears,
    defaultCollapsed: true,
    items: [
      { href: "/settings/general", label: "General", icon: faGear, module: "tenant_profile" },
      { href: "/settings/branding", label: "Branding", icon: faPalette, module: "tenant_profile" },
      { href: "/settings/theme", label: "Theme", icon: faPaintbrush, module: "theme" },
      { href: "/settings/numbering", label: "Numbering", icon: faHashtag, module: "tenant_profile" },
      // Both gated on `settings`, matching their APIs: issuer identity
      // and bill storage are tenant configuration.
      { href: "/settings/billing", label: "Billing Integration", icon: faCreditCard, module: "settings" },
      { href: "/settings/bill-production", label: "Bill Production", icon: faFileInvoice, module: "settings" },
      {
        href: "/settings/notifications",
        // Was "Notifications", which collided with Operations →
        // Notifications, the send log. This page is the sender address,
        // the SMS provider and the daily digest — how messages leave,
        // not which ones did.
        label: "Notification Delivery",
        icon: faBell,
        module: "tenant_profile",
      },
      { href: "/settings/automation", label: "Automation", icon: faRobot, module: "tenant_profile" },
    ],
  },
  {
    title: "Administration",
    icon: faShieldHalved,
    defaultCollapsed: true,
    items: [
      { href: "/users-roles", label: "Users & Roles", icon: faUserShield, module: "tenant_users" },
      { href: "/settings/api-keys", label: "API Keys & Webhooks", icon: faKey, module: "settings" },
      { href: "/settings/retention", label: "Retention & Audit", icon: faBoxArchive, module: "settings" },
      {
        href: "/audit-log",
        label: "Audit Log",
        icon: faClipboardList,
        // `settings`, not `audit_log`, and deliberately narrower than
        // the endpoint — the same divergence as Ledger Integrity below.
        //
        // This page reads the log unfiltered, which now requires
        // settings:VIEW server-side. `audit_log:VIEW` still serves the
        // Audit tab on account, premise, rate-schedule, agreement and
        // service-request pages, which pin the query to one entity. A
        // CSR or Field Technician holds that key for those tabs, so
        // gating this entry on it put a page in their menu that would
        // answer 403 — and made Administration a section of one for
        // them.
        module: "settings",
        tooltip: "Every recorded change across the tenant, filterable by entity, action, actor and date",
      },
      {
        href: "/settings/ledger-integrity",
        label: "Ledger Integrity",
        icon: faScaleBalanced,
        // Gated on `settings`, which no longer matches this section's
        // name — one of the inconsistencies the note at the top of this
        // file leaves open, kept as-is so the reorganization changes
        // nobody's access.
        //
        // The endpoint is accounts:VIEW, which every role but Portal
        // Customer holds -- so gating this on `accounts` put an admin
        // diagnostic in front of CSRs, Read-Only users and Field
        // Technicians, for whom it would be the only entry here they
        // could see and the only one they can do nothing about.
        //
        // The endpoint deliberately keeps accounts:VIEW: it was once
        // gated on tenant_profile and a tenant with the accounts module
        // but not that one lost the endpoint outright, which
        // ledger-routes.integration.test.ts still guards. So the two
        // differ on purpose. Today `settings` holders are a subset of
        // accounts:VIEW holders and nothing goes dead; a tenant that
        // grants `settings` without `accounts` would see a 403 here,
        // which is the lesser fault.
        module: "settings",
        tooltip: "Proves every account's cached balance still equals the sum of its open ledger entries",
      },
      { href: "/settings/danger-zone", label: "Danger Zone", icon: faBomb, module: "settings" },
    ],
  },
];

function NavItemWithPermission({
  item,
  collapsed,
  isActive,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  isActive: boolean;
  /** Closes the collapsed-rail flyout once a destination is chosen. */
  onNavigate?: () => void;
}) {
  const { canView } = usePermission(item.module);
  if (!canView) return null;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : item.tooltip}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: collapsed ? "10px 0" : "8px 13px",
        margin: collapsed ? "2px 8px" : "1px 8px",
        borderRadius: "var(--radius)",
        background: isActive ? "var(--accent-primary)" : "transparent",
        color: isActive ? "#ffffff" : "var(--text-secondary)",
        textDecoration: "none",
        fontSize: 13,
        fontWeight: isActive ? 600 : 400,
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
        overflow: "hidden",
        justifyContent: collapsed ? "center" : "flex-start",
        position: "relative",
        // 3px darker-indigo rail inside the active pill — gives the
        // anchor a subtle depth cue on the left edge. Unused when
        // inactive (transparent keeps layout steady between states).
        borderLeft: collapsed ? "none" : `3px solid ${isActive ? "var(--accent-primary-hover)" : "transparent"}`,
      }}
    >
      <FontAwesomeIcon
        icon={item.icon}
        style={{ width: 16, height: 16, flexShrink: 0, opacity: isActive ? 1 : 0.7 }}
      />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}

/** Accordion behaviour: only one section is open at a time. The
 *  open section is persisted in localStorage so the user's choice
 *  survives reloads. */
const OPEN_SECTION_KEY = "cis_nav_open_section";

function CollapsibleSection({
  section,
  pathname,
  sidebarCollapsed,
  sectionOpen,
  onToggle,
  flyoutOpen,
  onFlyoutToggle,
  onFlyoutClose,
}: {
  section: NavSection;
  pathname: string;
  sidebarCollapsed: boolean;
  sectionOpen: boolean;
  onToggle: () => void;
  /** Collapsed rail only: whether this section's item flyout is showing. */
  flyoutOpen: boolean;
  onFlyoutToggle: () => void;
  onFlyoutClose: () => void;
}) {
  const toggleSection = onToggle;
  const collapsedButtonRef = useRef<HTMLButtonElement>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);

  function openFlyout() {
    const rect = collapsedButtonRef.current?.getBoundingClientRect();
    if (rect) setFlyoutPos({ top: rect.top, left: rect.right + 8 });
    onFlyoutToggle();
  }

  function closeFlyout() {
    onFlyoutClose();
    setFlyoutPos(null);
  }

  // A section whose every entry is hidden renders nothing at all —
  // header included. Administration made this reachable: the CSR and
  // Field Technician presets hold no key in it, so without this they
  // would get a heading that opens onto an empty list.
  const { permissions, enabledModules } = useAuth();
  const items = visibleNavItems(section.items, permissions, enabledModules);

  /**
   * Longest-prefix wins, so `/delinquency/rules` does not also light up
   * `/delinquency`. Shared by the expanded list and the collapsed
   * flyout rather than duplicated — they must agree on what "here"
   * means.
   */
  function isItemActive(item: NavItem): boolean {
    const exactMatch = pathname === item.href;
    const prefixMatch = item.href !== "/" && pathname.startsWith(item.href + "/");
    const hasBetterMatch =
      !exactMatch &&
      prefixMatch &&
      items.some(
        (other) =>
          other.href !== item.href &&
          other.href.length > item.href.length &&
          (pathname === other.href || pathname.startsWith(other.href + "/")),
      );
    return exactMatch || (prefixMatch && !hasBetterMatch);
  }

  // On the collapsed rail the section icon is the only thing shown, so
  // it has to carry "you are in here" itself.
  const hasActiveItem = items.some(isItemActive);

  if (items.length === 0) return null;

  return (
    <div style={{ marginBottom: 4 }}>
      {!sidebarCollapsed && (
        <button
          onClick={toggleSection}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            padding: "8px 20px 4px",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              /*
               * `--text-secondary`, not `--text-muted`. In light mode
               * muted is indigo-500 (#6366f1) on an indigo-100 sidebar
               * (#e0e7ff) — about 3.4:1, under AA, and applied to the
               * smallest text in the app. Secondary is indigo-800
               * (#3730a3) and clears it comfortably. The open section
               * goes further, to primary, so the eye can find where it
               * is without reading every label.
               */
              color: sectionOpen ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              whiteSpace: "nowrap",
            }}
          >
            <FontAwesomeIcon
              icon={section.icon}
              style={{
                width: 13,
                height: 13,
                flexShrink: 0,
                // The open section's icon takes the accent; the rest sit
                // back so one thing leads at a time.
                color: sectionOpen ? "var(--accent-primary)" : "inherit",
                opacity: sectionOpen ? 1 : 0.65,
              }}
            />
            {section.title}
          </span>
          <FontAwesomeIcon
            icon={faChevronRight}
            style={{
              width: 9,
              height: 9,
              flexShrink: 0,
              color: "var(--text-muted)",
              transition: "transform 0.15s ease",
              transform: sectionOpen ? "rotate(90deg)" : "rotate(0deg)",
            }}
          />
        </button>
      )}
      {/*
        Collapsed: the seven section icons and nothing else. This used
        to render every section's items whenever the sidebar was
        collapsed — all 44 of them in one icon column, which is more
        than the expanded sidebar ever shows at once. The icon opens a
        flyout with that section's items instead.
      */}
      {sidebarCollapsed && (
        <button
          ref={collapsedButtonRef}
          onClick={openFlyout}
          title={section.title}
          aria-label={section.title}
          aria-expanded={flyoutOpen}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 36,
            margin: "2px 12px",
            borderRadius: "var(--radius)",
            border: "none",
            cursor: "pointer",
            background:
              flyoutOpen || hasActiveItem ? "var(--accent-primary)" : "transparent",
            color: flyoutOpen || hasActiveItem ? "#ffffff" : "var(--text-secondary)",
            transition: "background 0.15s ease, color 0.15s ease",
          }}
        >
          <FontAwesomeIcon icon={section.icon} style={{ width: 16, height: 16 }} />
        </button>
      )}

      {sidebarCollapsed && flyoutOpen && flyoutPos && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={closeFlyout} />
          {/*
            `position: fixed` from the button's own rect, because the
            sidebar clips its children: the <aside> is overflow hidden
            and the <nav> scrolls, so an absolutely positioned panel
            would be cut off at the 64px rail.
          */}
          <div
            style={{
              position: "fixed",
              top: flyoutPos.top,
              left: flyoutPos.left,
              zIndex: 60,
              minWidth: 196,
              maxHeight: `calc(100vh - ${flyoutPos.top + 16}px)`,
              overflowY: "auto",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              padding: "6px 0",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 14px 8px",
                color: "var(--text-secondary)",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                borderBottom: "1px solid var(--border-subtle)",
                marginBottom: 4,
              }}
            >
              <FontAwesomeIcon icon={section.icon} style={{ width: 12, height: 12 }} />
              {section.title}
            </div>
            {items.map((item) => (
              <NavItemWithPermission
                key={item.href}
                item={item}
                collapsed={false}
                isActive={isItemActive(item)}
                onNavigate={closeFlyout}
              />
            ))}
          </div>
        </>
      )}

      {!sidebarCollapsed &&
        sectionOpen &&
        items.map((item) => (
          <NavItemWithPermission
            key={item.href}
            item={item}
            collapsed={false}
            isActive={isItemActive(item)}
          />
        ))}
    </div>
  );
}

interface SidebarProps {
  defaultCollapsed?: boolean;
}

export function Sidebar({ defaultCollapsed = false }: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const width = collapsed ? 64 : 240;

  /**
   * Which collapsed-rail flyout is showing, if any. Held here rather
   * than per section so clicking a second icon switches straight to it
   * instead of needing the first one dismissed.
   *
   * Separate from `openSection` on purpose: that one is restored from
   * the route and localStorage, and a panel that opens by itself on
   * page load is not what a click-to-open flyout should do.
   */
  const [flyoutSection, setFlyoutSection] = useState<string | null>(null);

  // Section accordion: a single open section at a time. The active-
  // route's section is opened automatically on mount; user toggles
  // override and persist via localStorage. Server render uses null
  // (all closed) to avoid hydration mismatch — the mount effect picks
  // the right one immediately.
  const [openSection, setOpenSection] = useState<string | null>(null);
  useEffect(() => {
    const sectionForActive = navSections.find((s) =>
      s.items.some(
        (item) =>
          pathname === item.href ||
          (item.href !== "/" && pathname.startsWith(item.href + "/")),
      ),
    );
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(OPEN_SECTION_KEY);
    } catch {
      stored = null;
    }
    // Prefer the section containing the current route — otherwise the
    // user navigates into a section and finds it closed. If no active
    // route matches a section, fall back to the persisted choice, then
    // to the first non-default-collapsed section.
    if (sectionForActive) {
      setOpenSection(sectionForActive.title);
    } else if (stored && navSections.some((s) => s.title === stored)) {
      setOpenSection(stored);
    } else {
      const fallback = navSections.find((s) => !s.defaultCollapsed)?.title ?? null;
      setOpenSection(fallback);
    }
  }, [pathname]);

  const toggleOpenSection = (title: string) => {
    const next = openSection === title ? null : title;
    setOpenSection(next);
    try {
      if (next) window.localStorage.setItem(OPEN_SECTION_KEY, next);
      else window.localStorage.removeItem(OPEN_SECTION_KEY);
    } catch {
      /* best-effort persistence */
    }
  };

  return (
    <aside
      style={{
        width,
        minWidth: width,
        background: "var(--sidebar-bg)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        transition: "width 0.2s ease, min-width 0.2s ease",
        overflow: "hidden",
        height: "100vh",
        position: "relative",
      }}
    >
      {/* Brand + hamburger toggle. In expanded mode shows logo + name + toggle
          on the right. In collapsed mode only the hamburger remains so the
          user can always toggle back. */}
      <div
        style={{
          height: 56,
          padding: collapsed ? 0 : "0 8px 0 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          justifyContent: collapsed ? "center" : "flex-start",
          flexShrink: 0,
        }}
      >
        {!collapsed && (
          <>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--accent-primary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                color: "white",
                fontWeight: "bold",
                fontSize: 14,
              }}
            >
              U
            </div>
            <div style={{ overflow: "hidden", flex: 1 }}>
              <div style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 14, lineHeight: 1.2, whiteSpace: "nowrap" }}>
                Utility CIS
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>
                Admin Portal
              </div>
            </div>
          </>
        )}
        <button
          onClick={() => {
            // Any open flyout belongs to the collapsed rail; expanding
            // would otherwise leave it floating beside a 240px sidebar.
            setFlyoutSection(null);
            setCollapsed(!collapsed);
          }}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            width: 36,
            height: 36,
            borderRadius: "var(--radius)",
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            transition: "background 0.15s ease, color 0.15s ease",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)";
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)";
          }}
        >
          <FontAwesomeIcon icon={faBars} style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 0" }}>
        {navSections.map((section) => (
          <CollapsibleSection
            key={section.title}
            section={section}
            pathname={pathname}
            sidebarCollapsed={collapsed}
            sectionOpen={openSection === section.title}
            onToggle={() => toggleOpenSection(section.title)}
            flyoutOpen={flyoutSection === section.title}
            onFlyoutToggle={() =>
              setFlyoutSection((current) =>
                current === section.title ? null : section.title,
              )
            }
            onFlyoutClose={() => setFlyoutSection(null)}
          />
        ))}
      </nav>

    </aside>
  );
}
