import { getSession } from "next-auth/react";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const TOKEN_KEY = "cis_token";
const USER_KEY = "cis_user";

/**
 * Store auth credentials after a successful login. Called by the
 * /login page after POST /api/v1/auth/dev-login returns a token.
 */
export function setAuthToken(token: string, user?: Record<string, unknown>) {
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
}

/**
 * Clear stored credentials and redirect to /login.
 */
export function logout() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("portal_token");
    localStorage.removeItem("portal_user");
    window.location.href = "/login";
  }
}

/**
 * Read the stored user object (or null if not logged in).
 */
export function getStoredUser(): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Legacy compat for the /dev page impersonation flow.
// setDevUser now writes to localStorage so the token persists across
// refreshes, and the old in-memory state is gone.
export function setDevUser(id: string, email: string, name: string) {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({
    sub: id,
    utility_id: "00000000-0000-4000-8000-000000000001",
    email,
    name,
    role: "admin",
  }));
  const token = `${header}.${payload}.dev`;
  setAuthToken(token, { id, email, name });
}

/**
 * Resolve the bearer token for the current session. Tries
 * localStorage first (login page / dev impersonation), then falls
 * back to a NextAuth session for production SSO. Exposed publicly so
 * non-JSON request paths (multipart uploads, manual fetch calls) can
 * attach auth without going through the JSON wrapper.
 */
export async function getAuthToken(): Promise<string | null> {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
  }
  const session = await getSession();
  const sessionToken = (session as { accessToken?: string } | null)?.accessToken;
  if (typeof sessionToken === "string" && sessionToken.length > 0) {
    return sessionToken;
  }
  return null;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = await getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      // Only treat 401 as "session expired" when we're NOT already on
      // /login. The login page's AuthPermissionProvider fires auth/me on
      // mount without a token and gets a 401 — clearing localStorage
      // from that response races against a quick-login click that may
      // have just written a fresh token.
      if (!window.location.pathname.startsWith("/login")) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        window.location.href = "/login";
      }
      throw new Error("Session expired — redirecting to login");
    }
    if (response.status === 403 && typeof window !== "undefined") {
      try {
        const u = JSON.parse(localStorage.getItem(USER_KEY) ?? "{}");
        if (u.customerId && !window.location.pathname.startsWith("/portal")) {
          window.location.href = "/portal/dashboard";
          throw new Error("Portal user on admin page — redirecting");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("redirecting")) throw e;
      }
    }
    let errorDetails: string;
    try {
      const errorBody = await response.json();
      errorDetails = errorBody.error?.message || errorBody.message || JSON.stringify(errorBody);
    } catch {
      errorDetails = await response.text();
    }
    throw new Error(`API error ${response.status}: ${errorDetails}`);
  }
  // 204 No Content — return empty
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const apiClient = {
  async getAuthHeadersOnly(): Promise<Record<string, string>> {
    const h = await getAuthHeaders();
    const out: Record<string, string> = {};
    if (h["Authorization"]) out["Authorization"] = h["Authorization"];
    return out;
  },

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const headers = await getAuthHeaders();
    const url = new URL(`${API_URL}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
    });
    return handleResponse<T>(response);
  },

  async post<T>(path: string, body: unknown): Promise<T> {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return handleResponse<T>(response);
  },

  async patch<T>(path: string, body: unknown): Promise<T> {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_URL}${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return handleResponse<T>(response);
  },

  async put<T>(path: string, body: unknown): Promise<T> {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_URL}${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    return handleResponse<T>(response);
  },

  async delete<T>(path: string): Promise<T> {
    const headers = await getAuthHeaders();
    // Remove Content-Type for DELETE — no body to send
    delete headers["Content-Type"];
    const response = await fetch(`${API_URL}${path}`, {
      method: "DELETE",
      headers,
    });
    return handleResponse<T>(response);
  },

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const authOnly = await this.getAuthHeadersOnly();
    const response = await fetch(`${API_URL}${path}`, { method: "POST", headers: authOnly, body: formData });
    return handleResponse<T>(response);
  },
};
