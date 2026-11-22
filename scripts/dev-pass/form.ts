// Reading a small urlencoded form at a public door (shyden-labs/repo-template#207):
// no multipart parsing, and a body over 4 KiB is never decoded. A body of no
// declared length is counted as it streams in and cancelled once it passes the
// cap, so it is never held whole (shyden-labs/repo-template#211).

export const MAX_FORM_BYTES = 4_096;

/** The form, or the status to refuse it with: 415 for another type, 413 for a body over 4 KiB. */
export async function readForm(request: Request): Promise<URLSearchParams | 413 | 415> {
  if (!/^\s*application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return 415;
  // A declared length is refused before reading.
  if (Number(request.headers.get('content-length')) > MAX_FORM_BYTES) return 413;
  const bytes = request.body === null ? new Uint8Array(0) : await readUpToCap(request.body);
  if (bytes === 413) return 413;
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/** The stream's bytes, or 413 with the stream cancelled as soon as they pass `MAX_FORM_BYTES`. */
async function readUpToCap(body: ReadableStream<Uint8Array>): Promise<Uint8Array | 413> {
  const reader = body.getReader();
  const bytes = new Uint8Array(MAX_FORM_BYTES);
  let length = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    if (length + chunk.value.byteLength > MAX_FORM_BYTES) {
      await reader.cancel();
      return 413;
    }
    bytes.set(chunk.value, length);
    length += chunk.value.byteLength;
  }
  return bytes.subarray(0, length);
}
