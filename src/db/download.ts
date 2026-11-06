/**
 * Download a large file in full, picking up where it left off when the
 * connection drops. On mobile data a ~72 MB download often breaks part way
 * (a weak signal, a cell handover, the browser pausing a background tab), and
 * a plain fetch() then fails with "Failed to fetch" and starts again from zero.
 * Here a dropped connection is retried with a Range request for the bytes still
 * missing, after a short wait and once the page is visible again.
 */

/** A response that can't be the file (an error status, or a host's HTML fallback page). */
export class NotTheFile extends Error {}

export interface DownloadOptions {
  /** Tries in all, the first request included. */
  attempts?: number;
  fetchImpl?: typeof fetch;
  /** Waits before a retry; by default a backoff that also waits for the page to be visible. */
  wait?: (attempt: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 1 s, 2 s, 4 s … up to 15 s, and not while the tab is in the background. */
async function defaultWait(attempt: number): Promise<void> {
  await sleep(Math.min(1000 * 2 ** attempt, 15_000));
  if (typeof document !== "undefined" && document.hidden) {
    await new Promise<void>((resolve) => {
      const onChange = () => {
        if (!document.hidden) { document.removeEventListener("visibilitychange", onChange); resolve(); }
      };
      document.addEventListener("visibilitychange", onChange);
    });
  }
}

export async function downloadWithResume(url: string, options: DownloadOptions = {}): Promise<Uint8Array> {
  const { attempts = 6, fetchImpl = fetch, wait = defaultWait } = options;
  let buf = new Uint8Array(0);
  let received = 0;
  let total = 0;   // 0 = unknown

  const append = (chunk: Uint8Array) => {
    if (received + chunk.length > buf.length) {
      const grown = new Uint8Array(Math.max(buf.length * 2, received + chunk.length, 1 << 20));
      grown.set(buf.subarray(0, received));
      buf = grown;
    }
    buf.set(chunk, received);
    received += chunk.length;
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const resuming = received > 0;
      const response = await fetchImpl(url, resuming ? { headers: { Range: `bytes=${received}-` } } : undefined);
      if (!(resuming && response.status === 206)) {
        // A fresh start (or a server that ignored the Range and sent everything again).
        const type = response.headers.get("content-type");
        if (!response.ok || type === "text/html") {
          throw new NotTheFile(`${url} → ${response.status} ${type ?? ""}`.trim());
        }
        received = 0;
        total = Number(response.headers.get("content-length")) || 0;
        if (buf.length < total) buf = new Uint8Array(total);
      }
      if (!response.body) {
        append(new Uint8Array(await response.arrayBuffer()));
      } else {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          append(value);
        }
      }
      if (total && received < total) throw new Error(`connection closed after ${received} of ${total} bytes`);
      return received === buf.length ? buf : buf.slice(0, received);
    } catch (e) {
      if (e instanceof NotTheFile || attempt + 1 >= attempts) throw e;
      await wait(attempt);
    }
  }
}
