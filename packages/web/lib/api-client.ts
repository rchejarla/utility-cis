import { getSession } from "next-auth/react";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Cache the token so we don't call getSession() on every request
let cachedToken: string | null = null;
let cacheExpiry = 0;

// Dev user identity — can be changed via setDevUser()
let devUserId = "00000000-0000-4000-8000-000000000091";
let devUserEmail = "sysadmin@utility.com";
let devUserName = "Sarah Mitchell";

export function setDevUser(id: string, email: string, name: string) {
  devUserId = id;
  devUserEmail = email;
  devUserName = name;
  // Clear cached token so next request uses the new identity
  cachedToken = null;
  cacheExpiry = 0;
}

function createDevToken(): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({
    sub: devUserId,
    utility_id: "00000000-0000-4000-8000-000000000001",
    email: devUserEmail,
    name: devUserName,
    role: "admin",
  }));
  return `${header}.${payload}.dev`;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Use cached token if still valid (cache for 5 minutes)
  if (cachedToken && Date.now() < cacheExpiry) {
    headers["Authorization"] = `Bearer ${cachedToken}`;
    return headers;
  }

  // Try to get session token
  const session = await getSession();
  if (session) {
    const token = (session as any).accessToken;
    if (token && typeof token === "string") {
      cachedToken = token;
      cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 min cache
      headers["Authorization"] = `Bearer ${token}`;
      return headers;
    }
  }

  // Dev fallback
  cachedToken = createDevToken();
  cacheExpiry = Date.now() + 5 * 60 * 1000;
  headers["Authorization"] = `Bearer ${cachedToken}`;
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
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
    const headers: Record<string, string> = {};
    if (cachedToken && Date.now() < cacheExpiry) {
      headers["Authorization"] = `Bearer ${cachedToken}`;
    } else {
      const session = await getSession();
      if (session) {
        const token = (session as any).accessToken;
        if (token && typeof token === "string") {
          cachedToken = token;
          cacheExpiry = Date.now() + 5 * 60 * 1000;
          headers["Authorization"] = `Bearer ${token}`;
        }
      }
      if (!headers["Authorization"]) {
        cachedToken = createDevToken();
        cacheExpiry = Date.now() + 5 * 60 * 1000;
        headers["Authorization"] = `Bearer ${cachedToken}`;
      }
    }
    return headers;
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
    // Build auth header only — DO NOT set Content-Type; browser sets multipart boundary automatically
    const headers: Record<string, string> = {};
    if (cachedToken && Date.now() < cacheExpiry) {
      headers["Authorization"] = `Bearer ${cachedToken}`;
    } else {
      const session = await getSession();
      if (session) {
        const token = (session as any).accessToken;
        if (token && typeof token === "string") {
          cachedToken = token;
          cacheExpiry = Date.now() + 5 * 60 * 1000;
          headers["Authorization"] = `Bearer ${token}`;
        }
      }
      if (!headers["Authorization"]) {
        cachedToken = createDevToken();
        cacheExpiry = Date.now() + 5 * 60 * 1000;
        headers["Authorization"] = `Bearer ${cachedToken}`;
      }
    }
    const response = await fetch(`${API_URL}${path}`, { method: "POST", headers, body: formData });
    return handleResponse<T>(response);
  },
};
