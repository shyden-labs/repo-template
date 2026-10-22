/**
 * Reads a zip in process (issue #35): the GitHub API serves each trace
 * artifact as one, and unit tests start no process, so no `unzip`. It reads
 * the central directory, where GitHub's zips keep the sizes (their local
 * headers defer them to a data descriptor), and checks each entry's size and
 * crc32. Anything it does not read (zip64, encryption, a method other than
 * stored or deflate, text that is not UTF-8) fails closed, naming it.
 */
import { crc32, inflateRawSync } from 'node:zlib';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_SIZE = 22;
const ZIP64 = 0xffffffff;

function fail(message: string): never {
  throw new Error(`zip: ${message}`);
}

/** Every entry of a zip, by its path, as UTF-8 text. */
export function readZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  // The end record sits last, before a comment of at most 65535 bytes.
  let end = -1;
  for (let at = bytes.length - END_SIZE; at >= Math.max(0, bytes.length - END_SIZE - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end === -1) fail('no end-of-central-directory record: not a zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === ZIP64) fail('zip64 is not read');
  const entries = new Map<string, string>();
  for (let n = 1; n <= count; n += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_SIGNATURE) fail(`entry ${n} has no central directory signature`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (packed === ZIP64 || size === ZIP64 || local === ZIP64) fail('zip64 is not read');
    if ((flags & 1) !== 0) fail(`${name} is encrypted`);
    if (method !== 0 && method !== 8) fail(`${name} uses compression method ${method}`);
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) fail(`${name} has no local header signature`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > bytes.length) fail(`${name} runs past the end of the archive`);
    const data = bytes.subarray(start, start + packed);
    const content = method === 0 ? data : new Uint8Array(inflateRawSync(data));
    if (content.length !== size) fail(`${name} is ${content.length} bytes; the directory says ${size}`);
    if (crc32(content) !== crc) fail(`${name} fails its crc32 check`);
    try {
      entries.set(name, utf8.decode(content));
    } catch {
      fail(`${name} is not UTF-8 text`);
    }
  }
  return entries;
}
