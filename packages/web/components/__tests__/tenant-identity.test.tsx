import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrandMark } from "../ui/brand-mark";
import { Topbar } from "../topbar";
import { useAuth } from "@/lib/auth-context";

/**
 * Which utility am I looking at?
 *
 * The admin chrome named the product — "Utility CIS" over "Admin
 * Portal" — and named the tenant nowhere. Every screen below it is one
 * tenant's data, and an operator with two tabs open had nothing on
 * screen to tell them which one they were about to charge. On a phone
 * there is no sidebar at all, so the compact header was the only chrome
 * and it was a hardcoded product name.
 *
 * The tenant comes from `/auth/me`, which every page already calls for
 * its permissions.
 */

vi.mock("@/lib/api-client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({}), post: vi.fn() },
  API_URL: "http://localhost:3001",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { name: "Pat", email: "pat@example.com" } },
    status: "authenticated",
  }),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({ useAuth: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);

function authWith(utility: { id: string; name: string; status: string } | null) {
  mockedUseAuth.mockReturnValue({
    user: null,
    utility,
    permissions: {},
    enabledModules: [],
    loading: false,
    refresh: async () => {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  authWith(null);
});

describe("the brand mark", () => {
  it("names the tenant under the product", () => {
    render(<BrandMark tenant="City of Bozeman" />);

    expect(screen.getByText("Utility CIS")).toBeInTheDocument();
    expect(screen.getByText("City of Bozeman")).toBeInTheDocument();
    // The tenant replaces the surface caption rather than joining it:
    // a 240px brand row has one line for it, and which tenant is the
    // sharper form of the same question "Admin Portal" was answering.
    expect(screen.queryByText("Admin Portal")).not.toBeInTheDocument();
  });

  it("falls back to the surface above the tenants, where there is none", () => {
    // The platform screens mount no AuthPermissionProvider, so there is
    // no tenant to name and "Platform" is the true answer.
    render(<BrandMark subtitle="Platform" tenant={null} />);

    expect(screen.getByText("Platform")).toBeInTheDocument();
  });

  it("falls back to the surface when auth/me could not be read", () => {
    // The provider's catch grants permissions and leaves the tenant
    // null. Naming no tenant is honest; naming the wrong one is not.
    render(<BrandMark tenant={null} />);

    expect(screen.getByText("Admin Portal")).toBeInTheDocument();
  });
});

describe("the compact header, which is the only chrome on a phone", () => {
  it("names the tenant instead of the product", () => {
    authWith({ id: "u1", name: "City of Bozeman", status: "ACTIVE" });

    render(<Topbar compact variant="tenant" />);

    expect(screen.getByText("City of Bozeman")).toBeInTheDocument();
  });

  it("names the product when there is no tenant to name", () => {
    render(<Topbar compact variant="platform" />);

    expect(screen.getByText("Utility CIS")).toBeInTheDocument();
  });
});
