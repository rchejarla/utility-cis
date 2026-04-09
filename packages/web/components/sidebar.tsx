"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession } from "next-auth/react";
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
  faChevronLeft,
  faChevronRight,
} from "@fortawesome/pro-solid-svg-icons";

interface NavItem {
  href: string;
  label: string;
  icon: IconDefinition;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "Operations",
    items: [
      { href: "/customers", label: "Customers", icon: faUsers },
      { href: "/premises", label: "Premises", icon: faLocationDot },
      { href: "/meters", label: "Meters", icon: faGauge },
      { href: "/accounts", label: "Accounts", icon: faUser },
      { href: "/service-agreements", label: "Agreements", icon: faFileContract },
    ],
  },
  {
    title: "Configuration",
    items: [
      { href: "/commodities", label: "Commodities & UOM", icon: faDroplet },
      { href: "/rate-schedules", label: "Rate Schedules", icon: faMoneyBill },
      { href: "/billing-cycles", label: "Billing Cycles", icon: faCalendarDays },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/audit-log", label: "Audit Log", icon: faClipboardList },
      { href: "/theme", label: "Theme Editor", icon: faPalette },
      { href: "/settings", label: "Settings", icon: faGear },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(false);

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
      {/* Brand */}
      <div
        style={{
          padding: collapsed ? "16px 0" : "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          minHeight: 56,
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
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
        {!collapsed && (
          <div style={{ overflow: "hidden" }}>
            <div style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 14, lineHeight: 1.2, whiteSpace: "nowrap" }}>
              Utility CIS
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>
              Admin Portal
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 0" }}>
        {navSections.map((section) => (
          <div key={section.title} style={{ marginBottom: 4 }}>
            {!collapsed && (
              <div
                style={{
                  padding: "8px 20px 4px",
                  color: "var(--text-muted)",
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  whiteSpace: "nowrap",
                }}
              >
                {section.title}
              </div>
            )}
            {collapsed && section !== navSections[0] && (
              <div style={{ height: 1, background: "var(--border)", margin: "6px 12px" }} />
            )}
            {section.items.map((item) => {
              const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
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
                    style={{
                      width: 16,
                      height: 16,
                      flexShrink: 0,
                      opacity: isActive ? 1 : 0.7,
                    }}
                  />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User + Collapse toggle */}
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {/* User */}
        <div
          style={{
            padding: collapsed ? "10px 0" : "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            overflow: "hidden",
            justifyContent: collapsed ? "center" : "flex-start",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: "var(--text-secondary)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {session?.user?.name?.[0] ?? "A"}
          </div>
          {!collapsed && (
            <div style={{ overflow: "hidden", flex: 1 }}>
              <div style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {session?.user?.name ?? "Admin User"}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {session?.user?.email ?? "admin@utility.com"}
              </div>
            </div>
          )}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={{
            width: "100%",
            padding: "10px 0",
            background: "none",
            border: "none",
            borderTop: "1px solid var(--border)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--text-muted)",
            fontSize: 12,
            fontFamily: "inherit",
            transition: "color 0.15s ease",
          }}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <FontAwesomeIcon
            icon={collapsed ? faChevronRight : faChevronLeft}
            style={{ width: 10, height: 10 }}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
