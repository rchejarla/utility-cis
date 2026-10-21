import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AccessDenied } from "../access-denied";

/**
 * "Access Denied" is a claim, and this is the component that makes it.
 *
 * `auth-context` starts at `loading: true` with no permissions and no
 * enabled modules, and `usePermission` reads those directly — so for the
 * width of the `/auth/me` round trip, all 47 pages that do
 * `if (!canView) return <AccessDenied />` ask a question whose answer is
 * not known and get "no". That is what flashed a lock and a refusal on
 * every login, before the page the person was entitled to appeared.
 */

let loading = true;

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ loading, user: null, permissions: {}, enabledModules: [] }),
}));

describe("AccessDenied", () => {
  it("says nothing while the permissions are still being fetched", () => {
    loading = true;

    render(<AccessDenied />);

    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it("refuses once the permissions have arrived and say so", () => {
    loading = false;

    render(<AccessDenied />);

    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });

  it("holds the page height either way, so the layout does not jump", () => {
    // The answer arriving should not move everything below it.
    loading = true;
    const { container: whileLoading } = render(<AccessDenied />);
    loading = false;
    const { container: once } = render(<AccessDenied />);

    expect((whileLoading.firstChild as HTMLElement).style.minHeight).toBe("400px");
    expect((once.firstChild as HTMLElement).style.minHeight).toBe("400px");
  });
});
