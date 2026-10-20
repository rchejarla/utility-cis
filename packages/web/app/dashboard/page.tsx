"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { usePermission } from "@/lib/use-permission";
import { ReadinessPanel, type Readiness } from "@/components/readiness/readiness-panel";
import { TENANT_FIXES } from "@/components/readiness/tenant-fixes";

/**
 * Where a utility's own staff land.
 *
 * It exists because readiness had nowhere to live: the platform operator
 * could see that a tenant cannot bill anything, the tenant could not,
 * and every remedy is theirs. `/` sent staff to Premises — a working
 * screen, not a place to be told something is unfinished.
 *
 * One widget today, and the shape is the point: what a dashboard shows
 * is decided per widget by the key that widget needs, not per page. The
 * setup check-list answers to `settings`, which is what its endpoint
 * requires; the next widget answers to its own. That is why the sidebar
 * entry carries no module at all — gating the page would hide the
 * landing screen from whoever lacks whichever key came first.
 *
 * No widget registry. One widget does not need a framework for widgets,
 * and the second one can be an `&&` beside this one.
 */
export default function DashboardPage() {
  const { canView: canViewSettings } = usePermission("settings");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canViewSettings) return;
    let live = true;
    apiClient
      .get<Readiness>("/api/v1/readiness")
      .then((data) => {
        if (live) setReadiness(data);
      })
      .catch(() => {
        // A dashboard showing an error where a status belongs is worse
        // than one showing nothing: this is not why anyone came here.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [canViewSettings]);

  return (
    <div>
      {/* No "signed in as": the topbar says who you are on every
          screen, and repeating it here would be the dashboard's first
          widget being a fact nobody came for. */}
      <PageHeader title="Dashboard" />

      {readiness ? (
        <ReadinessPanel
          readiness={readiness}
          guidance={TENANT_FIXES}
          /* Open while there is something to do, closed once there is
             not: the same panel is a to-do list in one state and a
             reassurance in the other, and only one of those earns the
             space. */
          defaultOpen={!readiness.ready}
        />
      ) : failed ? (
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Setup status could not be loaded.
        </div>
      ) : canViewSettings ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Checking setup…</div>
      ) : (
        /* Said plainly rather than left blank: an empty page reads as
           something that failed to load. A CSR is not being kept from
           anything here — the check-list names configuration, which
           they cannot change. */
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Nothing to show here yet — the widgets for your role are still to come.
        </div>
      )}
    </div>
  );
}
