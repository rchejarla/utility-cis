"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { usePermission } from "@/lib/use-permission";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faLocationDot,
  faGauge,
  faUser,
  faUsers,
  faFileContract,
  faMoneyBill,
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
  items: NavItem[];
  /**
   * Collapse this section on first visit. Daily-use sections default
   * to open; rarely-visited groups (Settings) default to closed so
   * the sidebar stays calm. Applied only when the user hasn't
   * explicitly toggled the section — their choice persists after.
   */
  defaultCollapsed?: boolean;
}

const navSections: NavSection[] = [
  {
    title: "Operations",
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
    ],
  },
  {
    title: "Solid Waste",
    items: [
      { href: "/containers", label: "Containers", icon: faDumpster, module: "containers" },
      { href: "/service-suspensions", label: "Service Holds", icon: faPauseCircle, module: "service_suspensions" },
      { href: "/service-events", label: "RAMS Events", icon: faTruck, module: "service_events", tooltip: "Route and Asset Management System — field events from solid-waste collection crews" },
    ],
  },
  {
    title: "Collections",
    items: [
      { href: "/delinquency", label: "Delinquency", icon: faScaleUnbalanced, module: "delinquency" },
      { href: "/delinquency/shutoff-eligible", label: "Shut-Off Queue", icon: faPlugCircleXmark, module: "delinquency" },
      { href: "/delinquency/rules", label: "Rules", icon: faGear, module: "delinquency" },
    ],
  },
  {
    title: "Configuration",
    items: [
      { href: "/commodities", label: "Commodities & UOM", icon: faDroplet, module: "commodities" },
      { href: "/measure-types", label: "Measure Types", icon: faRulerHorizontal, module: "commodities" },
      { href: "/premise-types", label: "Premise Types", icon: faHouse, module: "premises" },
      { href: "/account-types", label: "Account Types", icon: faIdCard, module: "accounts" },
      { href: "/rate-schedules", label: "Rate Schedules", icon: faMoneyBill, module: "rate_schedules" },
      { href: "/billing-cycles", label: "Billing Cycles", icon: faCalendarDays, module: "billing_cycles" },
    ],
  },
  {
    title: "Settings",
    defaultCollapsed: true,
    items: [
      { href: "/settings/general", label: "General", icon: faGear, module: "tenant_profile" },
      { href: "/settings/branding", label: "Branding", icon: faPalette, module: "tenant_profile" },
      { href: "/settings/theme", label: "Theme", icon: faPaintbrush, module: "theme" },
      { href: "/settings/numbering", label: "Numbering", icon: faHashtag, module: "tenant_profile" },
      { href: "/settings/custom-fields", label: "Custom Fields", icon: faListCheck, module: "tenant_profile" },
      { href: "/settings/billing", label: "Billing Integration", icon: faCreditCard, module: "settings" },
      { href: "/settings/notifications", label: "Notifications", icon: faBell, module: "tenant_profile" },
      { href: "/settings/slas", label: "Service Request SLAs", icon: faStopwatch, module: "service_request_slas" },
      { href: "/settings/retention", label: "Retention & Audit", icon: faBoxArchive, module: "settings" },
      { href: "/settings/automation", label: "Automation", icon: faRobot, module: "tenant_profile" },
      { href: "/settings/api-keys", label: "API Keys & Webhooks", icon: faKey, module: "settings" },
      { href: "/users-roles", label: "Users & Roles", icon: faUserShield, module: "tenant_users" },
      { href: "/audit-log", label: "Audit Log", icon: faClipboardList, module: "audit_log" },
      { href: "/imports", label: "Imports", icon: faFileImport, module: "imports" },
      { href: "/settings/danger-zone", label: "Danger Zone", icon: faBomb, module: "settings" },
    ],
  },
];

function NavItemWithPermission({ item, collapsed, isActive }: { item: NavItem; collapsed: boolean; isActive: boolean }) {
  const { canView } = usePermission(item.module);
  if (!canView) return null;

  return (
    <Link
      href={item.href}
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
}: {
  section: NavSection;
  pathname: string;
  sidebarCollapsed: boolean;
  sectionOpen: boolean;
  onToggle: () => void;
}) {
  const toggleSection = onToggle;

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
              color: "var(--text-muted)",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              whiteSpace: "nowrap",
            }}
          >
            {section.title}
          </span>
          <span
            style={{
              fontSize: 8,
              color: "var(--text-muted)",
              transition: "transform 0.15s",
              transform: sectionOpen ? "rotate(0deg)" : "rotate(-90deg)",
            }}
          >
            ▼
          </span>
        </button>
      )}
      {sidebarCollapsed && section !== navSections[0] && (
        <div style={{ height: 1, background: "var(--border)", margin: "6px 12px" }} />
      )}
      {(sidebarCollapsed || sectionOpen) &&
        section.items.map((item) => {
          const exactMatch = pathname === item.href;
          const prefixMatch = item.href !== "/" && pathname.startsWith(item.href + "/");
          const hasBetterMatch = !exactMatch && prefixMatch && section.items.some(
            (other) => other.href !== item.href && other.href.length > item.href.length &&
              (pathname === other.href || pathname.startsWith(other.href + "/")),
          );
          const isActive = exactMatch || (prefixMatch && !hasBetterMatch);
          return (
            <NavItemWithPermission
              key={item.href}
              item={item}
              collapsed={sidebarCollapsed}
              isActive={isActive}
            />
          );
        })}
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
          onClick={() => setCollapsed(!collapsed)}
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
          />
        ))}
      </nav>

    </aside>
  );
}
