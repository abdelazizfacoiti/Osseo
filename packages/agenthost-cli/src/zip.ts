import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/*
 * A small zip reader and writer on node:zlib, so the Windows release can be
 * built on Linux and unpacked on Windows without any external tool. It
 * supports stored and deflated entries only: no zip64, no encryption, no
 * symbolic links. The reader refuses anything that could write outside the
 * target folder.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  name: string;
  data: Buffer;
  /** Unix mode, for example 0o644. Defaults to 0o644. */
  mode?: number;
}

export class ZipError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00 in DOS date/time, so equal input gives equal bytes.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8_FLAG = 0x0800;
const VERSION_MADE_BY = (3 << 8) | 20;

/** Rejects names that could escape the target folder or mean something else on Windows. */
export function isSafeZipName(name: string): boolean {
  if (name === "" || name.length > 1024 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.includes(":")) return false;
  return name.split("/").every((part, index, parts) => (part !== ".." && part !== ".") && (part !== "" || index === parts.length - 1));
}

export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (!isSafeZipName(entry.name) || entry.name.endsWith("/")) throw new ZipError(`zip_name_invalid:${entry.name.slice(0, 80)}`);
    if (seen.has(entry.name)) throw new ZipError(`zip_name_duplicate:${entry.name.slice(0, 80)}`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const deflated = entry.data.length === 0 ? Buffer.alloc(0) : deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length > 0 && deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    if (body.length > 0xfffffffe || offset > 0xfffffffe) throw new ZipError("zip_too_large");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | ((entry.mode ?? 0o644) & 0o7777)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  if (sorted.length > 0xfffe) throw new ZipError("zip_too_many_entries");
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface ZipListing {
  name: string;
  isDirectory: boolean;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  localOffset: number;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 * 1024 };

/** Reads the central directory. Throws a ZipError for anything unsafe or unsupported. */
export function listZip(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipListing[] {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 0xffff); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new ZipError("zip_invalid");
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipError("zip_zip64_unsupported");
  if (count > limits.maxEntries) throw new ZipError("zip_too_many_entries");
  if (directoryOffset + directorySize > end) throw new ZipError("zip_invalid");
  const listing: ZipListing[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new ZipError("zip_invalid");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0) throw new ZipError("zip_encrypted_unsupported");
    if (method !== 0 && method !== 8) throw new ZipError("zip_method_unsupported");
    if (compressedSize === 0xffffffff || size === 0xffffffff) throw new ZipError("zip_zip64_unsupported");
    if (!isSafeZipName(name)) throw new ZipError(`zip_unsafe_path:${name.slice(0, 80)}`);
    // A Unix symbolic link (mode 0o120000 in the high bits) would be written as a plain file; refuse it.
    if (((external >>> 16) & 0o170000) === 0o120000) throw new ZipError(`zip_symlink_unsupported:${name.slice(0, 80)}`);
    if (seen.has(name)) throw new ZipError(`zip_name_duplicate:${name.slice(0, 80)}`);
    seen.add(name);
    if (size > limits.maxEntryBytes) throw new ZipError("zip_entry_too_large");
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError("zip_too_large");
    listing.push({ name, isDirectory: name.endsWith("/"), size, compressedSize, method, crc, localOffset });
  }
  return listing;
}

/** Returns one entry's bytes after a size and CRC-32 check. */
export function readZipEntry(buffer: Buffer, entry: ZipListing): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) throw new ZipError("zip_invalid");
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  if (start + entry.compressedSize > buffer.length) throw new ZipError("zip_invalid");
  const raw = buffer.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  try {
    data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
  } catch {
    throw new ZipError(`zip_entry_corrupt:${entry.name.slice(0, 80)}`);
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError(`zip_entry_corrupt:${entry.name.slice(0, 80)}`);
  return data;
}

/** Unpacks every file under `destination` (which must already be an empty folder of your own). */
export async function extractZip(buffer: Buffer, destination: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<string[]> {
  const listing = listZip(buffer, limits);
  const root = path.resolve(destination);
  const written: string[] = [];
  for (const entry of listing) {
    const target = path.resolve(root, ...entry.name.split("/"));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new ZipError(`zip_unsafe_path:${entry.name.slice(0, 80)}`);
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const data = readZipEntry(buffer, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    written.push(entry.name);
  }
  return written;
}
