import { describe, expect, it } from "vitest";
import { NotTheFile, downloadWithResume } from "../db/download";

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const noWait = async () => {};

/** A body that sends `bytes` and then, if `breakAfter` is set, fails like a dropped connection. */
function body(bytes: Uint8Array, breakAfter?: number) {
  const upTo = breakAfter ?? bytes.length;
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at < upTo) { c.enqueue(bytes.slice(at, Math.min(at + 100, upTo))); at += 100; return; }
      if (breakAfter !== undefined) c.error(new TypeError("Failed to fetch"));
      else c.close();
    },
  });
}

/** A fake CDN that honours Range requests; `breaks` lists, per request, where its body drops. */
function cdn(breaks: (number | undefined)[]) {
  const requests: (string | null)[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    requests.push(range);
    const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const rest = FILE.slice(from);
    const brk = breaks[requests.length - 1];
    return new Response(body(rest, brk), {
      status: range ? 206 : 200,
      headers: { "content-type": "application/gzip", "content-length": String(rest.length) },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("downloadWithResume", () => {
  it("downloads a file in one go", async () => {
    const { fetchImpl, requests } = cdn([undefined]);
    expect(await downloadWithResume("/f", { fetchImpl, wait: noWait })).toEqual(FILE);
    expect(requests).toEqual([null]);
  });

  it("resumes with a Range request after the connection drops, more than once", async () => {
    const { fetchImpl, requests } = cdn([300, 200, undefined]);
    expect(await downloadWithResume("/f", { fetchImpl, wait: noWait })).toEqual(FILE);
    expect(requests).toEqual([null, "bytes=300-", "bytes=500-"]);
  });

  it("starts again if the server ignores the Range and sends the whole file", async () => {
    let n = 0;
    const fetchImpl = (async () => new Response(body(FILE, n++ === 0 ? 400 : undefined), {
      status: 200, headers: { "content-type": "application/gzip", "content-length": "1000" },
    })) as typeof fetch;
    expect(await downloadWithResume("/f", { fetchImpl, wait: noWait })).toEqual(FILE);
  });

  it("retries a request that fails outright, then gives up after the last attempt", async () => {
    let calls = 0;
    const failing = (async () => { calls++; throw new TypeError("Failed to fetch"); }) as typeof fetch;
    await expect(downloadWithResume("/f", { fetchImpl: failing, wait: noWait, attempts: 3 })).rejects.toThrow("Failed to fetch");
    expect(calls).toBe(3);
  });

  it("doesn't retry a host's HTML fallback page", async () => {
    let calls = 0;
    const html = (async () => { calls++; return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    await expect(downloadWithResume("/f", { fetchImpl: html, wait: noWait })).rejects.toBeInstanceOf(NotTheFile);
    expect(calls).toBe(1);
  });
});
