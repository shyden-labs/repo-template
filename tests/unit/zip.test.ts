import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { readZip } from '../../scripts/zip.ts';

/**
 * Trace artifacts come from the GitHub API as zips (issue #35), read here in
 * process. `deploy-dev-traces.zip` is the real artifact of run 39693590892
 * (dc5302f): deflate entries whose sizes sit only in the central directory.
 * `stored.zip` was made with `zip -0 -X` (entries j/a "one\n", j/b "two\n").
 */

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/workflow-coverage/${name}`, import.meta.url)));

/** The offset of the central directory's first entry, read from the end record. */
const centralAt = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint32(bytes.length - 22 + 16, true);

/** A copy of `bytes` with `write` applied to a DataView over it. */
function mutated(bytes: Uint8Array, write: (view: DataView, bytes: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice();
  write(new DataView(copy.buffer), copy);
  return copy;
}

/** A copy of `bytes` with one little-endian 16- or 32-bit field at `at` set to `value`. */
function withUint(bytes: Uint8Array, width: 16 | 32, at: number, value: number): Uint8Array {
  return mutated(bytes, (view) => {
    if (width === 16) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
  });
}

describe('readZip', () => {
  it('reads the real trace artifact: deflate entries sized in the central directory', () => {
    const entries = readZip(fixture('deploy-dev-traces.zip'));
    expect([...entries.keys()]).toEqual(['deploy-dev/__run', 'deploy-dev/__run_2']);
    expect(entries.get('deploy-dev/__run_2')).toBe(
      '3a1bf8d78c36935b96b3ca654b31523b810921913abc79f2644ea886df6c2da3  /home/runner/work/_temp/00bc56b3-8193-4076-86a5-0f22cec2ad6f.sh\n2\n1\n2\n',
    );
    expect(entries.get('deploy-dev/__run')?.split('\n').slice(1)).toEqual(['11', '1', '1', '2', '7', '8', '9', '10', '']);
  });

  it('reads stored entries', () => {
    expect(readZip(fixture('stored.zip'))).toEqual(
      new Map([
        ['j/a', 'one\n'],
        ['j/b', 'two\n'],
      ]),
    );
  });

  it('refuses bytes with no end record', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(bytes.slice(0, bytes.length - 22))).toThrow('zip: no end-of-central-directory record: not a zip');
  });

  it('refuses a zip64 archive', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(withUint(bytes, 32, bytes.length - 22 + 16, 0xffffffff))).toThrow('zip: zip64 is not read');
    expect(() => readZip(withUint(bytes, 32, centralAt(bytes) + 20, 0xffffffff))).toThrow('zip: zip64 is not read');
  });

  it('refuses a broken central directory entry', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(withUint(bytes, 32, centralAt(bytes), 0))).toThrow('zip: entry 1 has no central directory signature');
  });

  it('refuses an encrypted entry', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(withUint(bytes, 16, centralAt(bytes) + 8, 1))).toThrow('zip: j/a is encrypted');
  });

  it('refuses a compression method other than stored or deflate', () => {
    const bytes = fixture('deploy-dev-traces.zip');
    expect(() => readZip(withUint(bytes, 16, centralAt(bytes) + 10, 9))).toThrow('zip: deploy-dev/__run uses compression method 9');
  });

  it('refuses an entry whose local header is not where the directory says', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(withUint(bytes, 32, 0, 0))).toThrow('zip: j/a has no local header signature');
  });

  it('refuses an entry whose data runs past the end', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(withUint(bytes, 32, centralAt(bytes) + 20, 100000))).toThrow('zip: j/a runs past the end of the archive');
  });

  it('refuses an entry whose size does not match the directory', () => {
    const bytes = fixture('deploy-dev-traces.zip');
    expect(() => readZip(withUint(bytes, 32, centralAt(bytes) + 24, 1))).toThrow(
      'zip: deploy-dev/__run is 148 bytes; the directory says 1',
    );
  });

  it('refuses an entry whose crc does not match', () => {
    const bytes = fixture('stored.zip');
    expect(() => readZip(withUint(bytes, 32, centralAt(bytes) + 16, 0))).toThrow('zip: j/a fails its crc32 check');
  });

  it('refuses an entry that is not UTF-8', () => {
    const bytes = fixture('stored.zip');
    // j/a's data starts after its 30-byte local header and 3-byte name; its crc is fixed up so only the text is wrong.
    const bad = mutated(bytes, (v, b) => {
      b[33] = 0xff;
      v.setUint32(centralAt(bytes) + 16, crc32(b.subarray(33, 37)), true);
    });
    expect(() => readZip(bad)).toThrow('zip: j/a is not UTF-8 text');
  });
});
