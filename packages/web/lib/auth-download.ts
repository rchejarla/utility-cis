import { API_URL, apiClient } from "./api-client";

/**
 * Fetch a file from an authenticated endpoint and hand it to the browser
 * as a download.
 *
 * Our file endpoints need an `Authorization` header, so a plain
 * `<a href>` cannot reach them: the bytes have to be fetched with the
 * token attached, wrapped in a blob URL, and clicked.
 *
 * The error path reads the response body on purpose. These endpoints
 * answer a failed download with a reason an operator can act on — which
 * issuer fields are missing, which storage integration refused — and a
 * bare "Download failed (422)" would throw that away.
 */
export async function authDownload(path: string, fileName: string): Promise<void> {
  const headers = await apiClient.getAuthHeadersOnly();
  const res = await fetch(`${API_URL}${path}`, { headers });

  if (!res.ok) {
    throw new Error(await failureMessage(res));
  }

  const blobUrl = window.URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    a.click();
  } finally {
    window.URL.revokeObjectURL(blobUrl);
  }
}

async function failureMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string; missing?: string[] };
    };
    const message = body.error?.message;
    const missing = body.error?.missing;
    if (message && missing && missing.length > 0) {
      return `${message} (${missing.join(", ")})`;
    }
    if (message) return message;
  } catch {
    // Not every failure carries a JSON body — fall through to the status.
  }
  return `Download failed (${res.status})`;
}
