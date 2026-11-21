import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crc32, extractZip, isSafeZipName, listZip, readZipEntry, writeZip, ZipError } from "../zip.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temp(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-zip-")); roots.push(dir); return dir; }

const sample = () => writeZip([
  { name: "top/b.txt", data: Buffer.from("hello hello hello hello hello hello") },
  { name: "top/a/empty.txt", data: Buffer.alloc(0) },
  { name: "top/bin/run.mjs", data: Buffer.from("x"), mode: 0o755 }
]);

describe("zip reader and writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips entries, sorted, and gives the same bytes twice", async () => {
    const zip = sample();
    expect(sample().equals(zip)).toBe(true);
    expect(listZip(zip).map((entry) => entry.name)).toEqual(["top/a/empty.txt", "top/b.txt", "top/bin/run.mjs"]);
    const dir = await temp();
    expect(await extractZip(zip, dir)).toHaveLength(3);
    expect(await readFile(path.join(dir, "top", "b.txt"), "utf8")).toBe("hello hello hello hello hello hello");
    expect((await readFile(path.join(dir, "top", "a", "empty.txt"))).length).toBe(0);
  });

  it("rejects unsafe names when writing and when reading", () => {
    for (const name of ["../x", "a/../x", "/abs", "C:/x", "a\\b", "a//b", "", "a:b"]) expect(isSafeZipName(name)).toBe(false);
    expect(() => writeZip([{ name: "../x", data: Buffer.from("x") }])).toThrow(ZipError);
    // Same length name, patched in both headers: "aa/evil" -> "../evil".
    const zip = writeZip([{ name: "aa/evil", data: Buffer.from("x") }]);
    const patched = Buffer.from(zip.toString("latin1").replaceAll("aa/evil", "../evil"), "latin1");
    expect(() => listZip(patched)).toThrow(/zip_unsafe_path/);
  });

  it("rejects symbolic links, encryption, zip64 and duplicate names", () => {
    const zip = writeZip([{ name: "t/link", data: Buffer.from("target") }]);
    const link = Buffer.from(zip);
    const central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    link.writeUInt32LE(((0o120777) << 16) >>> 0, central + 38);
    expect(() => listZip(link)).toThrow(/zip_symlink_unsupported/);
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(1, central + 8);
    expect(() => listZip(encrypted)).toThrow(/zip_encrypted_unsupported/);
    const big = Buffer.from(zip);
    big.writeUInt16LE(0xffff, big.length - 22 + 10);
    expect(() => listZip(big)).toThrow(/zip_zip64_unsupported/);
    expect(() => writeZip([{ name: "a", data: Buffer.alloc(0) }, { name: "a", data: Buffer.alloc(0) }])).toThrow(/zip_name_duplicate/);
    expect(() => listZip(Buffer.from("not a zip"))).toThrow(/zip_invalid/);
  });

  it("detects a corrupted entry by its CRC", () => {
    const zip = writeZip([{ name: "t/f", data: Buffer.from("abcdefgh") }]);
    const bad = Buffer.from(zip);
    const at = bad.indexOf(Buffer.from("abcdefgh"));
    bad[at] = 0x7a;
    const [entry] = listZip(bad);
    expect(() => readZipEntry(bad, entry!)).toThrow(/zip_entry_corrupt/);
  });

  it("enforces the entry and size limits", () => {
    const zip = sample();
    expect(() => listZip(zip, { maxEntries: 2, maxEntryBytes: 1e9, maxTotalBytes: 1e9 })).toThrow(/zip_too_many_entries/);
    expect(() => listZip(zip, { maxEntries: 9, maxEntryBytes: 5, maxTotalBytes: 1e9 })).toThrow(/zip_entry_too_large/);
    expect(() => listZip(zip, { maxEntries: 9, maxEntryBytes: 1e9, maxTotalBytes: 10 })).toThrow(/zip_too_large/);
  });
});
