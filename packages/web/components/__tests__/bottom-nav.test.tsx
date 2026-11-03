import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { navSections } from "../sidebar";

/**
 * The mobile menu is derived from the sidebar's own declaration, so what
 * matters is that nothing can be reachable on one and missing on the
 * other.
 *
 * It used to hold its own eleven entries against the sidebar's
 * forty-eight. The consequence was specific: a Field Technician — the
 * role most likely to be holding a phone — had no Meter Reads, no Meter
 * Events, no Service Requests and no Containers, which is the whole of
 * the job. Two destinations were also gated on different keys from the
 * sidebar, so Audit Log appeared on a phone and not on a desktop.
 */

const MODULES = Array.from(
  new Set(navSections.flatMap((s) => s.items.map((i) => i.module)).filter(Boolean)),
) as string[];

function mockAuth(permissions: Record<string, string[]>, enabled: string[] = MODULES) {
  vi.doMock("@/lib/auth-context", () => ({
    useAuth: () => ({ permissions, enabledModules: enabled }),
  }));
}

/** Every module, every verb. */
const everything = Object.fromEntries(MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]]));

/** The Field Technician preset, which is the case that was broken. */
const fieldTech = {
  customers: ["VIEW"],
  premises: ["VIEW", "EDIT"],
  meters: ["VIEW", "EDIT"],
  meter_reads: ["VIEW", "CREATE", "EDIT"],
  meter_events: ["VIEW", "CREATE", "EDIT"],
  accounts: ["VIEW"],
  agreements: ["VIEW"],
  commodities: ["VIEW"],
  containers: ["VIEW", "EDIT"],
  service_requests: ["VIEW", "EDIT"],
  workflows: ["VIEW"],
  search: ["VIEW"],
  audit_log: ["VIEW"],
  attachments: ["VIEW", "CREATE", "EDIT"],
};

async function renderWith(permissions: Record<string, string[]>) {
  vi.resetModules();
  mockAuth(permissions);
  vi.doMock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
  const { BottomNav: Fresh } = await import("../bottom-nav");
  return render(<Fresh />);
}

/** Every label the mobile menu offers, tabs plus the More sheet. */
async function mobileLabels(permissions: Record<string, string[]>): Promise<string[]> {
  await renderWith(permissions);
  const tabs = Array.from(screen.getByTestId("bottom-nav").querySelectorAll("a")).map(
    (a) => a.textContent ?? "",
  );
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  const sheet = Array.from(
    screen.getByTestId("bottom-nav-sheet").querySelectorAll("a"),
  ).map((a) => a.textContent ?? "");
  return [...tabs, ...sheet];
}

describe("the mobile menu", () => {
  it("reaches everything the sidebar reaches, for an admin", async () => {
    const labels = await mobileLabels(everything);
    const sidebarLabels = navSections.flatMap((s) => s.items.map((i) => i.label));
    expect([...labels].sort()).toEqual([...sidebarLabels].sort());
  });

  it("offers a Field Technician the screens their job runs on", async () => {
    // The four that were missing entirely before it was derived.
    const labels = await mobileLabels(fieldTech);
    expect(labels).toContain("Meter Reads");
    expect(labels).toContain("Meter Events");
    expect(labels).toContain("Service Requests");
    expect(labels).toContain("Containers");
  });

  it("hides from a Field Technician what the sidebar hides", async () => {
    const labels = await mobileLabels(fieldTech);
    // No billing key, no tenant_profile, no tenant_users, no settings.
    expect(labels).not.toContain("Billing Runs");
    expect(labels).not.toContain("Premise Types");
    expect(labels).not.toContain("Users & Roles");
    expect(labels).not.toContain("Rate Schedules");
  });

  it("gates on the same keys as the sidebar, not its own", async () => {
    /*
     * Audit Log is the case: the mobile list gated it on `audit_log`
     * while the sidebar gated it on `settings` — and the API refuses an
     * unfiltered read without `settings` — so the phone offered a link
     * that would 403.
     */
    const auditOnly = { audit_log: ["VIEW"], customers: ["VIEW"] };
    const labels = await mobileLabels(auditOnly);
    expect(labels).not.toContain("Audit Log");
  });

  it("gives the primary tabs to the operator's daily work", async () => {
    await renderWith(everything);
    const tabs = Array.from(screen.getByTestId("bottom-nav").querySelectorAll("a")).map(
      (a) => a.textContent ?? "",
    );
    expect(tabs).toHaveLength(4);
    // The first four visible Operations entries, so the bar follows the
    // role rather than a hard-coded list.
    expect(tabs).toEqual(navSections[0].items.slice(0, 4).map((i) => i.label));
  });

  it("does not repeat a primary tab inside the sheet", async () => {
    const labels = await mobileLabels(everything);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("groups the sheet under the section headings the sidebar uses", async () => {
    await renderWith(everything);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByTestId("bottom-nav-sheet");
    for (const title of ["Billing", "Collections", "Tariffs", "Configuration", "Administration"]) {
      expect(sheet.textContent).toContain(title);
    }
  });

  it("renders no heading for a section whose every entry is hidden", async () => {
    await renderWith(fieldTech);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByTestId("bottom-nav-sheet");
    expect(sheet.textContent).not.toContain("Tariffs");
    expect(sheet.textContent).not.toContain("Administration");
  });
});
