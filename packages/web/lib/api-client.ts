import { getSession } from "next-auth/react";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

function createDevToken(): string {
  // Dev-mode fallback token when no session exists
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify({
    sub: "dev-user-001",
    utility_id: "mwa-001-uuid",
    email: "dev@example.com",
    role: "admin",
  }));
  return `${header}.${payload}.dev`;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await getSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session) {
    const token = (session as any).accessToken;
    if (token && typeof token === "string") {
      // Signed JWT string from NextAuth — pass directly to the API
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  if (!headers["Authorization"]) {
    // Dev fallback — create a proper JWT-like token
    headers["Authorization"] = `Bearer ${createDevToken()}`;
  }
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorDetails: string;
    try {
      const errorBody = await response.json();
      errorDetails = errorBody.message || errorBody.error || JSON.stringify(errorBody);
    } catch {
      errorDetails = await response.text();
    }
    throw new Error(`API error ${response.status}: ${errorDetails}`);
  }
  return response.json() as Promise<T>;
}

export const apiClient = {
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
};
