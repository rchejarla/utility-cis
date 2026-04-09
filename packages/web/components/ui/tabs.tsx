"use client";

import React from "react";

interface Tab {
  key: string;
  label: string;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export function Tabs({ tabs, activeTab, onTabChange, action, children }: TabsProps) {
  return (
    <div>
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2px",
          borderBottom: "1px solid var(--border)",
          marginBottom: "20px",
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: isActive ? "600" : "400",
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                background: "transparent",
                border: "none",
                borderBottom: isActive
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
                marginBottom: "-1px",
                cursor: "pointer",
                transition: "all 0.15s ease",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)";
                }
              }}
            >
              {tab.label}
            </button>
          );
        })}
        {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
      </div>

      {/* Tab content */}
      <div>{children}</div>
    </div>
  );
}
