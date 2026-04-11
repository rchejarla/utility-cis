"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePermission } from "@/lib/use-permission";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faUsers,
  faLocationDot,
  faGauge,
  faFileContract,
  faBars,
  faUser,
  faMoneyBill,
  faCalendarDays,
  faDroplet,
  faClipboardList,
  faPalette,
  faGear,
  faUserShield,
  faXmark,
} from "@fortawesome/pro-solid-svg-icons";

const primaryNav = [
  { href: "/customers", label: "Customers", icon: faUsers, module: "customers" },
  { href: "/premises", label: "Premises", icon: faLocationDot, module: "premises" },
  { href: "/meters", label: "Meters", icon: faGauge, module: "meters" },
  { href: "/service-agreements", label: "Agreements", icon: faFileContract, module: "agreements" },
];

const moreNav = [
  { href: "/accounts", label: "Accounts", icon: faUser, module: "accounts" },
  { href: "/rate-schedules", label: "Rate Schedules", icon: faMoneyBill, module: "rate_schedules" },
  { href: "/billing-cycles", label: "Billing Cycles", icon: faCalendarDays, module: "billing_cycles" },
  { href: "/commodities", label: "Commodities", icon: faDroplet, module: "commodities" },
  { href: "/audit-log", label: "Audit Log", icon: faClipboardList, module: "audit_log" },
  { href: "/theme", label: "Theme", icon: faPalette, module: "theme" },
  { href: "/users-roles", label: "Users & Roles", icon: faUserShield, module: "settings" },
  { href: "/settings", label: "Settings", icon: faGear, module: "settings" },
];

function BottomNavItem({ item, isActive }: { item: typeof primaryNav[number]; isActive: boolean }) {
  const { canView } = usePermission(item.module);
  if (!canView) return null;

  return (
    <Link href={item.href} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", textDecoration: "none", color: isActive ? "var(--accent-primary)" : "var(--text-muted)", fontSize: "10px", fontWeight: isActive ? 600 : 400, transition: "color 0.15s" }}>
      <FontAwesomeIcon icon={item.icon} style={{ width: 18, height: 18 }} />
      <span>{item.label}</span>
    </Link>
  );
}

function MoreNavItem({ item, isActive, onClick }: { item: typeof moreNav[number]; isActive: boolean; onClick: () => void }) {
  const { canView } = usePermission(item.module);
  if (!canView) return null;

  return (
    <Link href={item.href} onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", textDecoration: "none", color: isActive ? "var(--accent-primary)" : "var(--text-secondary)", fontSize: 14, fontWeight: isActive ? 500 : 400 }}>
      <FontAwesomeIcon icon={item.icon} style={{ width: 16, height: 16, opacity: 0.7 }} />
      {item.label}
    </Link>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href));

  const moreIsActive = moreNav.some((item) => isActive(item.href));

  return (
    <>
      {/* Bottom Nav Bar */}
      <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: "56px",
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "stretch",
          zIndex: 100,
        }}
      >
        {primaryNav.map((item) => (
          <div key={item.href} style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <BottomNavItem item={item} isActive={isActive(item.href)} />
          </div>
        ))}

        {/* More button */}
        <button
          onClick={() => setSheetOpen(true)}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "3px",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: moreIsActive ? "var(--accent-primary)" : "var(--text-muted)",
            fontSize: "10px",
            fontWeight: moreIsActive ? 600 : 400,
            fontFamily: "inherit",
            transition: "color 0.15s ease",
          }}
        >
          <FontAwesomeIcon icon={faBars} style={{ width: 18, height: 18 }} />
          <span>More</span>
        </button>
      </nav>

      {/* Sheet overlay */}
      {sheetOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSheetOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 200,
            }}
          />

          {/* Slide-up sheet */}
          <div
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              background: "var(--bg-surface)",
              borderTop: "1px solid var(--border)",
              borderRadius: "16px 16px 0 0",
              zIndex: 201,
              padding: "0 0 80px 0",
            }}
          >
            {/* Sheet header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  color: "var(--text-primary)",
                  fontWeight: 600,
                  fontSize: "15px",
                }}
              >
                More
              </span>
              <button
                onClick={() => setSheetOpen(false)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-secondary)",
                }}
              >
                <FontAwesomeIcon icon={faXmark} style={{ width: 14, height: 14 }} />
              </button>
            </div>

            {/* Sheet items */}
            <div style={{ padding: "8px 0" }}>
              {moreNav.map((item) => (
                <MoreNavItem
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                  onClick={() => setSheetOpen(false)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
