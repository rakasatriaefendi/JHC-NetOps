/** Enforce actual bytes, not just an optional caller-controlled Content-Length. */
export async function boundedRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 11 * 1024 * 1024) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes || request.signal.aborted) { await reader.cancel(); return null; }
      bytes.set(value, size - value.byteLength);
    }
    return bytes.subarray(0, size);
  } catch { await reader.cancel().catch(() => undefined); return null; }
  finally { reader.releaseLock(); }
}
