"use client";

import { useMemo } from "react";
import { StatCard } from "@/components/ui/stat-card";
import { CustomerBillsTab } from "@/components/billing/customer-bills-tab";

/**
 * Portal bills page. Reuses the same CustomerBillsTab component
 * from the admin side with mock data. When the invoice mirror API
 * lands in Phase 3, this will call /portal/api/accounts/:id/bills
 * instead.
 */
export default function PortalBillsPage() {
  const portalUser = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("portal_user") ?? "{}");
    } catch {
      return {};
    }
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--text-primary)",
            margin: "0 0 4px",
          }}
        >
          Bills
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
          Your billing history and invoice details
        </p>
      </div>

      <CustomerBillsTab
        customerId={portalUser.customerId ?? "portal-mock"}
        primaryPremiseLabel="Your primary address"
      />
    </div>
  );
}
