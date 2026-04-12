"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { apiClient } from "./api-client";
import { MODULES } from "@utility-cis/shared";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleId: string | null;
  roleName: string;
  customerId: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  permissions: Record<string, string[]>;
  enabledModules: string[];
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  permissions: {},
  enabledModules: [],
  loading: true,
  refresh: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthPermissionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<Record<string, string[]>>({});
  const [enabledModules, setEnabledModules] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAuth = async () => {
    try {
      const data = await apiClient.get<{
        user: AuthUser;
        permissions: Record<string, string[]>;
        enabledModules: string[];
      }>("/api/v1/auth/me");
      setUser(data.user);
      setPermissions(data.permissions);
      setEnabledModules(data.enabledModules);
    } catch (err) {
      // Fallback: grant all permissions from the canonical MODULES list in
      // shared/. Previously this had its own hardcoded 12-entry list which
      // silently drifted whenever new Phase 2 modules were added — keeping
      // the source of truth in shared/ means the sidebar can never miss a
      // module just because auth/me had a transient failure.
      console.warn("Failed to fetch auth/me — falling back to full permissions", err);
      const allPerms = ["VIEW", "CREATE", "EDIT", "DELETE"];
      setPermissions(
        Object.fromEntries(MODULES.map((m) => [m, allPerms])),
      );
      setEnabledModules([...MODULES]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuth();
  }, []);

  return (
    <AuthContext.Provider value={{ user, permissions, enabledModules, loading, refresh: fetchAuth }}>
      {children}
    </AuthContext.Provider>
  );
}
