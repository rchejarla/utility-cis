"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import { logout } from "@/lib/api-client";
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
  faPalette,
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
} from "@fortawesome/pro-solid-svg-icons";

interface NavItem {
  href: string;
  label: string;
  icon: IconDefinition;
  module: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
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
      { href: "/service-events", label: "RAMS Events", icon: faTruck, module: "service_events" },
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
      { href: "/rate-schedules", label: "Rate Schedules", icon: faMoneyBill, module: "rate_schedules" },
      { href: "/billing-cycles", label: "Billing Cycles", icon: faCalendarDays, module: "billing_cycles" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/audit-log", label: "Audit Log", icon: faClipboardList, module: "audit_log" },
      { href: "/theme", label: "Theme Editor", icon: faPalette, module: "theme" },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "/users-roles", label: "Users & Roles", icon: faUserShield, module: "settings" },
      { href: "/settings", label: "Settings", icon: faGear, module: "settings" },
    ],
  },
];

function NavItemWithPermission({ item, collapsed, isActive }: { item: NavItem; collapsed: boolean; isActive: boolean }) {
  const { canView } = usePermission(item.module);
  if (!canView) return null;

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: collapsed ? "10px 0" : "8px 16px",
        margin: collapsed ? "2px 8px" : "1px 8px",
        borderRadius: "var(--radius)",
        background: isActive ? "var(--bg-hover)" : "transparent",
        color: isActive ? "var(--accent-primary)" : "var(--text-secondary)",
        textDecoration: "none",
        fontSize: 13,
        fontWeight: isActive ? 500 : 400,
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
        overflow: "hidden",
        justifyContent: collapsed ? "center" : "flex-start",
        position: "relative",
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

const SECTION_COLLAPSE_KEY = "cis_nav_collapsed_sections";

function getCollapsedSections(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedSections(set: Set<string>) {
  if (typeof window !== "undefined") {
    localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify([...set]));
  }
}

function CollapsibleSection({
  section,
  pathname,
  sidebarCollapsed,
}: {
  section: NavSection;
  pathname: string;
  sidebarCollapsed: boolean;
}) {
  const hasActiveItem = section.items.some(
    (item) => pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/")),
  );

  const [sectionOpen, setSectionOpen] = useState(() => {
    if (hasActiveItem) return true;
    return !getCollapsedSections().has(section.title);
  });

  useEffect(() => {
    if (hasActiveItem && !sectionOpen) setSectionOpen(true);
  }, [hasActiveItem]);

  const toggleSection = () => {
    const next = !sectionOpen;
    setSectionOpen(next);
    const set = getCollapsedSections();
    if (next) set.delete(section.title);
    else set.add(section.title);
    saveCollapsedSections(set);
  };

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
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const width = collapsed ? 64 : 240;

  return (
    <aside
      style={{
        width,
        minWidth: width,
        background: "var(--bg-surface)",
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
          />
        ))}
      </nav>

      {/* User avatar with dropdown menu */}
      <AdminAvatarMenu collapsed={collapsed} session={session} />
    </aside>
  );
}

function AdminAvatarMenu({ collapsed, session }: { collapsed: boolean; session: ReturnType<typeof useSession>["data"] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = session?.user?.name ?? "Admin User";
  const email = session?.user?.email ?? "admin@utility.com";
  const initial = name[0]?.toUpperCase() ?? "A";

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} style={{ borderTop: "1px solid var(--border)", position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: collapsed ? "10px 0" : "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          overflow: "hidden",
          justifyContent: collapsed ? "center" : "flex-start",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <div
          style={{
            width: 32, height: 32, borderRadius: "50%",
            background: "var(--bg-elevated)", border: "1px solid var(--border)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600,
          }}
        >
          {initial}
        </div>
        {!collapsed && (
          <div style={{ overflow: "hidden", flex: 1 }}>
            <div style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {name}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {email}
            </div>
          </div>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: collapsed ? 4 : 8,
            right: collapsed ? 4 : 8,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 -4px 16px rgba(0,0,0,0.4)",
            zIndex: 200,
            overflow: "hidden",
            minWidth: collapsed ? 180 : undefined,
          }}
        >
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{name}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{email}</div>
          </div>
          <div style={{ padding: "4px 0" }}>
            <Link
              href="/settings/general"
              onClick={() => setOpen(false)}
              style={{
                display: "block", padding: "8px 14px", fontSize: 13,
                color: "var(--text-secondary)", textDecoration: "none",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              Settings
            </Link>
            <button
              onClick={logout}
              style={{
                display: "block", width: "100%", padding: "8px 14px", fontSize: 13,
                color: "var(--danger)", background: "none", border: "none",
                textAlign: "left", cursor: "pointer", fontFamily: "inherit",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
