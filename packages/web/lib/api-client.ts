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

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // 1. Token from localStorage (login page or dev impersonation)
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      headers["Authorization"] = `Bearer ${stored}`;
      return headers;
    }
  }

  // 2. NextAuth session token (production SSO path)
  const session = await getSession();
  if (session) {
    const token = (session as any).accessToken;
    if (token && typeof token === "string") {
      headers["Authorization"] = `Bearer ${token}`;
      return headers;
    }
  }

  // 3. No token — requests will get 401. The auth context fallback
  //    handles this gracefully by granting all perms in dev mode.
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
      throw new Error("Session expired — redirecting to login");
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
