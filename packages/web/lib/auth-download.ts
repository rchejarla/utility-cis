import { API_URL, apiClient } from "./api-client";

/**
 * Fetching a file from an authenticated endpoint, and either handing it
 * to the browser as a download or opening it for the viewer to read.
 *
 * A browser `<a href download>` issues the GET without our
 * `Authorization` header, so the API answers 401. The bytes have to be
 * fetched with the token attached and materialised as a blob URL before
 * anything can be done with them.
 *
 * `path` is API-relative; the base URL is added here, so no caller
 * assembles it. The error path reads the response body on purpose: these
 * endpoints answer a refusal with a reason an operator can act on —
 * which issuer fields are missing, which storage integration refused —
 * and a bare status line would throw that away.
 */

/**
 * Carries the HTTP status, because callers branch on it: a bill's PDF
 * answers 404 when none has been generated yet, and that is a cue to
 * generate one rather than an error to report.
 */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/** The file's bytes, with the token attached. */
export async function authFetchFile(path: string): Promise<Blob> {
  const headers = await apiClient.getAuthHeadersOnly();
  const res = await fetch(`${API_URL}${path}`, { headers });

  if (!res.ok) {
    throw new DownloadError(await failureMessage(res), res.status);
  }

  return res.blob();
}

/** Save the file, naming it. */
export async function authDownload(path: string, fileName: string): Promise<void> {
  const blobUrl = window.URL.createObjectURL(await authFetchFile(path));
  try {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    a.click();
  } finally {
    window.URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Hand an already-fetched file to a tab the caller opened, so the
 * browser's own viewer displays it.
 *
 * The tab has to be opened by the caller, synchronously inside the click
 * handler, and passed in here. Opening it after the `await` puts the
 * call outside the user gesture, which is exactly what popup blockers
 * stop — the window would simply not appear, with no error to report.
 *
 * The blob URL is deliberately not revoked straight away: the tab is
 * still reading from it. It is released on a timer long enough for the
 * viewer to have loaded, and the browser reclaims anything left when the
 * opener goes away.
 */
export function handToViewer(tab: Window, file: Blob): void {
  const blobUrl = window.URL.createObjectURL(file);
  tab.location.href = blobUrl;
  window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 60_000);
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
