"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * Topbar bell that pulls the signed-in user's unread `InAppNotification`
 * rows. Polling is intentionally crude — every 30s while the tab is
 * focused, paused otherwise. The query is cheap (an indexed scan +
 * count narrowed by utility_id+user_id+is_read), so polling is
 * acceptable until WebSockets earn their keep elsewhere in the app.
 */

const POLL_INTERVAL_MS = 30_000;

interface InboxItem {
  id: string;
  kind: string;
  severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
}

interface InboxResponse {
  data: InboxItem[];
  unreadCount: number;
}

function severityAccent(severity: string): string {
  switch (severity) {
    case "SUCCESS":
      return "var(--success)";
    case "WARNING":
      return "var(--warning)";
    case "ERROR":
      return "var(--danger)";
    default:
      return "var(--accent-primary)";
  }
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function BellIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  async function poll() {
    try {
      const res = await apiClient.get<InboxResponse>("/api/v1/inbox/unread");
      setItems(res.data ?? []);
      setUnreadCount(res.unreadCount ?? 0);
    } catch {
      // silent — bell shouldn't break the topbar if the endpoint hiccups
    }
  }

  // Poll on mount and on window focus; pause on blur.
  useEffect(() => {
    poll();
    const interval = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        poll();
      }
    }, POLL_INTERVAL_MS);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Click-outside to close.
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  async function handleItemClick(item: InboxItem) {
    setOpen(false);
    // Optimistic update — mark read locally, then fire and forget.
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await apiClient.post(`/api/v1/inbox/${item.id}/read`, {});
    } catch {
      // Re-fetch on failure to avoid drifting from server state.
      poll();
    }
  }

  async function handleMarkAllRead() {
    setItems([]);
    setUnreadCount(0);
    try {
      await apiClient.post("/api/v1/inbox/read-all", {});
    } catch {
      poll();
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "var(--radius)",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
          position: "relative",
          flexShrink: 0,
        }}
      >
        <BellIcon filled={unreadCount > 0} />
        {unreadCount > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              minWidth: "16px",
              height: "16px",
              padding: "0 4px",
              borderRadius: "8px",
              background: "var(--danger)",
              color: "#fff",
              fontSize: "10px",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: "360px",
            maxHeight: "480px",
            overflowY: "auto",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
            zIndex: 50,
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              Notifications
            </span>
            {items.length > 0 && (
              <button
                onClick={handleMarkAllRead}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--accent-primary)",
                  fontSize: "12px",
                  fontFamily: "inherit",
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div
              style={{
                padding: "32px 14px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: "13px",
              }}
            >
              No unread notifications.
            </div>
          ) : (
            items.map((item) => {
              const accent = severityAccent(item.severity);
              const inner = (
                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--border-subtle)",
                    cursor: "pointer",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      width: "3px",
                      borderRadius: "2px",
                      background: accent,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        marginBottom: "2px",
                      }}
                    >
                      {item.title}
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                        lineHeight: 1.4,
                        marginBottom: "4px",
                        wordBreak: "break-word",
                      }}
                    >
                      {item.body}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {timeAgo(item.createdAt)}
                    </div>
                  </div>
                </div>
              );
              return item.link ? (
                <Link
                  key={item.id}
                  href={item.link}
                  onClick={() => handleItemClick(item)}
                  style={{ display: "block", textDecoration: "none", color: "inherit" }}
                >
                  {inner}
                </Link>
              ) : (
                <div key={item.id} onClick={() => handleItemClick(item)}>
                  {inner}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
