"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  faXmark,
} from "@fortawesome/pro-solid-svg-icons";

const primaryNav = [
  { href: "/customers", label: "Customers", icon: faUsers },
  { href: "/premises", label: "Premises", icon: faLocationDot },
  { href: "/meters", label: "Meters", icon: faGauge },
  { href: "/service-agreements", label: "Agreements", icon: faFileContract },
];

const moreNav = [
  { href: "/accounts", label: "Accounts", icon: faUser },
  { href: "/rate-schedules", label: "Rate Schedules", icon: faMoneyBill },
  { href: "/billing-cycles", label: "Billing Cycles", icon: faCalendarDays },
  { href: "/commodities", label: "Commodities", icon: faDroplet },
  { href: "/audit-log", label: "Audit Log", icon: faClipboardList },
  { href: "/theme", label: "Theme", icon: faPalette },
  { href: "/settings", label: "Settings", icon: faGear },
];

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
        {primaryNav.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "3px",
                textDecoration: "none",
                color: active ? "var(--accent-primary)" : "var(--text-muted)",
                fontSize: "10px",
                fontWeight: active ? 600 : 400,
                transition: "color 0.15s ease",
              }}
            >
              <FontAwesomeIcon icon={item.icon} style={{ width: 18, height: 18 }} />
              <span>{item.label}</span>
            </Link>
          );
        })}

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
              {moreNav.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSheetOpen(false)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "14px",
                      padding: "14px 20px",
                      textDecoration: "none",
                      color: active ? "var(--accent-primary)" : "var(--text-secondary)",
                      background: active ? "var(--bg-hover)" : "transparent",
                      fontSize: "14px",
                      fontWeight: active ? 500 : 400,
                      transition: "background 0.1s ease",
                    }}
                  >
                    <FontAwesomeIcon
                      icon={item.icon}
                      style={{ width: 18, height: 18, opacity: active ? 1 : 0.7 }}
                    />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
