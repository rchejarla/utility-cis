"use client";

import { useAuth } from "@/lib/auth-context";

/**
 * Shown by a page whose module the signed-in user cannot view.
 *
 * **It says nothing until the permissions have arrived.** `auth-context`
 * starts at `loading: true` with no permissions and no enabled modules,
 * and `usePermission` reads those directly — so for the width of the
 * `/auth/me` round trip, every one of the 47 pages that does
 * `if (!canView) return <AccessDenied />` is asking a question whose
 * answer is not known yet, and getting "no". That is what flashed a
 * lock and "Access Denied" on every login before the real page appeared.
 *
 * Fixing it here rather than in `usePermission` is deliberate: the 47
 * call sites all read the same way, and the claim is this component's to
 * make. A page cannot render "denied" too early if the thing that
 * renders "denied" refuses to do so without the facts.
 *
 * The placeholder keeps the page's height so the layout does not jump
 * when the answer arrives.
 */
export function AccessDenied() {
  const { loading } = useAuth();

  if (loading) {
    return <div style={{ minHeight: "400px" }} aria-busy="true" />;
  }

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "400px",
      color: "var(--text-muted)",
      gap: "12px",
    }}>
      <div style={{ fontSize: "48px" }}>🔒</div>
      <div style={{ fontSize: "18px", fontWeight: 600, color: "var(--text-primary)" }}>Access Denied</div>
      <div style={{ fontSize: "14px" }}>You don&apos;t have permission to view this page.</div>
    </div>
  );
}
