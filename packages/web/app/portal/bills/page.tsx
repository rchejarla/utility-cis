"use client";

import { BillsList } from "@/components/portal/bills-list";

/**
 * Portal bills page.
 *
 * Reads the customer's own accounts and their posted bills. Until
 * 2026-10-22 it rendered `lib/mock-billing` through the admin side's
 * CustomerBillsTab, waiting on an "invoice mirror API" that was
 * cancelled on 2026-10-09 — the real source, `Bill`, had existed since
 * rate-model slice 5b.
 */
export default function PortalBillsPage() {
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
          Your billing history and what you currently owe
        </p>
      </div>

      <BillsList />
    </div>
  );
}
