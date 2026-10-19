import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "./json-store.js";
import type { AppState } from "../app-state.js";

describe("JsonStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ml-aos-"));
  });

  it("round-trips empty state", async () => {
    const store = new JsonStore(dir);
    const empty: AppState = {
      settings: {
        theme: "dark",
        defaultEngine: "claude",
        dataDir: dir,
        notifications: true,
      },
      bots: [],
      workspaces: [],
      topics: [],
      messages: [],
      pipelines: [],
    };
    await store.save(empty);
    const loaded = await store.load();
    expect(loaded.settings.theme).toBe("dark");
    expect(loaded.bots).toEqual([]);
  });

  it("moves a corrupt array file aside and loads it as empty", async () => {
    await writeFile(join(dir, "topics.json"), '[{"id":"t1",');
    const store = new JsonStore(dir);

    const loaded = await store.load();

    expect(loaded.topics).toEqual([]);
    const files = await readdir(dir);
    expect(files).not.toContain("topics.json");
    const backup = files.find((f) => f.startsWith("topics.json.corrupt-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(dir, backup!), "utf-8")).toBe('[{"id":"t1",');
  });

  it("falls back to default settings when settings.json is corrupt", async () => {
    await writeFile(join(dir, "settings.json"), "{not json");
    const store = new JsonStore(dir);

    const loaded = await store.load();

    expect(loaded.settings.defaultEngine).toBe("claude");
    expect(loaded.settings.dataDir).toBe(dir);
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("settings.json.corrupt-"))).toBe(true);
  });

  it("treats a blank settings.json as missing", async () => {
    await writeFile(join(dir, "settings.json"), "  \n");
    const store = new JsonStore(dir);

    const loaded = await store.load();

    expect(loaded.settings.defaultEngine).toBe("claude");
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  it("still rejects valid JSON that fails schema validation", async () => {
    await writeFile(join(dir, "bots.json"), JSON.stringify({ not: "an array" }));
    const store = new JsonStore(dir);

    await expect(store.load()).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["bots.json"]);
  });
});
