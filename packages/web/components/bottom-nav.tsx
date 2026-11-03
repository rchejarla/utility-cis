"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBars, faXmark } from "@fortawesome/pro-solid-svg-icons";
import { useAuth } from "@/lib/auth-context";
import { visibleNavItems } from "@/lib/nav-visibility";
import { navSections, type NavItem } from "./sidebar";

/**
 * The mobile navigation, derived from `navSections` — the same
 * declaration the sidebar renders.
 *
 * It used to hold its own list of eleven entries against the sidebar's
 * forty-eight, and had drifted into a different product: no Meter
 * Reads, no Meter Events, no Service Requests, no Containers, which is
 * the entire job of a Field Technician — the role most likely to be
 * holding a phone. Nothing added in the year since appeared here
 * either. It also gated two destinations on different keys from the
 * sidebar, so Audit Log showed on a phone and not on a desktop.
 *
 * Deriving removes the possibility rather than fixing the instances: a
 * nav entry added anywhere now reaches both.
 *
 * **Primary tabs are the first four visible Operations entries**, which
 * makes the bar answer to the role rather than to a hard-coded four.
 * Everything else the operator may see goes in the More sheet, under its
 * section heading, in sidebar order — so the grouping that teaches a
 * desktop user where things live teaches a mobile user the same thing.
 */

const PRIMARY_TABS = 4;

function TabLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        textDecoration: "none",
        color: isActive ? "var(--accent-primary)" : "var(--text-muted)",
        fontSize: "10px",
        fontWeight: isActive ? 600 : 400,
        transition: "color 0.15s",
      }}
    >
      <FontAwesomeIcon icon={item.icon} style={{ width: 18, height: 18 }} />
      <span>{item.label}</span>
    </Link>
  );
}

function SheetLink({
  item,
  isActive,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 20px",
        textDecoration: "none",
        color: isActive ? "var(--accent-primary)" : "var(--text-secondary)",
        fontSize: 14,
        fontWeight: isActive ? 500 : 400,
      }}
    >
      <FontAwesomeIcon icon={item.icon} style={{ width: 16, height: 16 }} />
      {item.label}
    </Link>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const { permissions, enabledModules } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href));

  /*
   * One pass over the sidebar's sections, filtered by the same rule the
   * sidebar applies. A section whose every entry is hidden contributes
   * nothing and its heading never appears.
   */
  const sections = navSections
    .map((section) => ({
      title: section.title,
      items: visibleNavItems(section.items, permissions, enabledModules),
    }))
    .filter((section) => section.items.length > 0);

  const operations = sections[0]?.items ?? [];
  const tabs = operations.slice(0, PRIMARY_TABS);
  const tabHrefs = new Set(tabs.map((item) => item.href));
  const sheet = sections
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => !tabHrefs.has(item.href)),
    }))
    .filter((section) => section.items.length > 0);

  const moreIsActive = sheet.some((s) => s.items.some((item) => isActive(item.href)));

  return (
    <>
      <nav
        data-testid="bottom-nav"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: "56px",
          background: "var(--sidebar-bg)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "stretch",
          zIndex: 100,
        }}
      >
        {tabs.map((item) => (
          <div key={item.href} style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <TabLink item={item} isActive={isActive(item.href)} />
          </div>
        ))}

        <button
          onClick={() => setSheetOpen(true)}
          aria-label="More"
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

      {sheetOpen && (
        <>
          <div
            onClick={() => setSheetOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200 }}
          />

          <div
            data-testid="bottom-nav-sheet"
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              maxHeight: "80vh",
              overflowY: "auto",
              background: "var(--sidebar-bg)",
              borderTop: "1px solid var(--border)",
              borderRadius: "16px 16px 0 0",
              zIndex: 201,
              padding: "0 0 80px 0",
            }}
          >
            <div
              style={{
                position: "sticky",
                top: 0,
                background: "var(--sidebar-bg)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: "15px" }}>
                More
              </span>
              <button
                onClick={() => setSheetOpen(false)}
                aria-label="Close"
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

            <div style={{ padding: "8px 0" }}>
              {sheet.map((section) => (
                <div key={section.title}>
                  <div
                    style={{
                      padding: "10px 20px 4px",
                      fontSize: "11px",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-muted)",
                    }}
                  >
                    {section.title}
                  </div>
                  {section.items.map((item) => (
                    <SheetLink
                      key={item.href}
                      item={item}
                      isActive={isActive(item.href)}
                      onClick={() => setSheetOpen(false)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
