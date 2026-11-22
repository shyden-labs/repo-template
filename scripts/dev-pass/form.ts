// Reading a small urlencoded form at a public door (shyden-labs/repo-template#207):
// no multipart parsing, and a body over 4 KiB is never decoded.

export const MAX_FORM_BYTES = 4_096;

/** The form, or the status to refuse it with: 415 for another type, 413 for a body over 4 KiB. */
export async function readForm(request: Request): Promise<URLSearchParams | 413 | 415> {
  if (!/^\s*application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return 415;
  // A declared length is refused before reading; a chunked body is measured after.
  if (Number(request.headers.get('content-length')) > MAX_FORM_BYTES) return 413;
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_FORM_BYTES) return 413;
  return new URLSearchParams(new TextDecoder().decode(body));
}
