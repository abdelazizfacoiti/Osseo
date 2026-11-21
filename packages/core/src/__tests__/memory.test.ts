import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LESSON_CHARS, clearMemory, deleteMemory, listMemory, saveMemory, searchMemory } from "../memory.js";

const directories: string[] = [];
async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osseo-memory-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("agent memory", () => {
  it("stores privately, dedupes, searches, deletes, and clears", async () => {
    const dir = await home();
    const first = await saveMemory(dir, { topic: "Firefox", lesson: "Wait for the title before clicking the toolbar." });
    expect(first.topic).toBe("firefox");
    expect((await stat(path.join(dir, "memory", "lessons.json"))).mode & 0o777).toBe(0o600);
    expect((await saveMemory(dir, { topic: "firefox", lesson: "wait for the title before clicking the toolbar." })).id).toBe(first.id);
    await saveMemory(dir, { topic: "gimp", lesson: "The export dialog opens behind the main window." });
    expect((await searchMemory(dir, { query: "export" })).map((entry) => entry.topic)).toEqual(["gimp"]);
    expect((await searchMemory(dir, { topic: "firefox" }))).toHaveLength(1);
    expect((await searchMemory(dir, {})).map((entry) => entry.topic)).toEqual(["gimp", "firefox"]);
    await deleteMemory(dir, first.id);
    await expect(deleteMemory(dir, first.id)).rejects.toThrow(/No lesson/);
    await clearMemory(dir);
    expect(await listMemory(dir)).toEqual([]);
  });

  it("refuses secrets, long content, and bad topics", async () => {
    const dir = await home();
    await expect(saveMemory(dir, { topic: "site", lesson: "login with api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789" })).rejects.toThrow(/secret/);
    await expect(saveMemory(dir, { topic: "site", lesson: "x".repeat(MAX_LESSON_CHARS + 1) })).rejects.toThrow(/how to work/);
    await expect(saveMemory(dir, { topic: "../up", lesson: "A valid lesson body." })).rejects.toThrow(/Topics/);
    expect(await listMemory(dir)).toEqual([]);
  });
});
