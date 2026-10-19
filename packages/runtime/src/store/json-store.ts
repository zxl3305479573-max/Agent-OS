import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AppSettingsSchema,
  BotConfigSchema,
  WorkspaceSchema,
  TopicSchema,
  ChatMessageSchema,
  PipelineTaskSchema,
  StoredUserSchema,
} from "@ml-aos/shared";
import type { AppState } from "../app-state.js";

const FILES = {
  settings: "settings.json",
  bots: "bots.json",
  workspaces: "workspaces.json",
  topics: "topics.json",
  messages: "messages.json",
  pipelines: "pipelines.json",
  users: "users.json",
} as const;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class JsonStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  /** Absolute data directory (bots.json, gitee-dispatches.json, …). */
  getDir(): string {
    return this.dataDir;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async save(state: AppState): Promise<void> {
    return this.enqueue(() => this.saveUnlocked(state));
  }

  async load(): Promise<AppState> {
    return this.enqueue(() => this.loadUnlocked());
  }

  /** Atomic read-modify-write to avoid lost updates under concurrent bot streams. */
  async transact(
    fn: (state: AppState) => void | Promise<void>,
  ): Promise<AppState> {
    return this.enqueue(async () => {
      const state = await this.loadUnlocked();
      await fn(state);
      await this.saveUnlocked(state);
      return state;
    });
  }

  private async saveUnlocked(state: AppState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await Promise.all([
      this.writeJson(FILES.settings, state.settings),
      this.writeJson(FILES.bots, state.bots),
      this.writeJson(FILES.workspaces, state.workspaces),
      this.writeJson(FILES.topics, state.topics),
      this.writeJson(FILES.messages, state.messages),
      this.writeJson(FILES.pipelines, state.pipelines),
      this.writeJson(FILES.users, state.users ?? []),
    ]);
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const target = join(this.dataDir, file);
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(temp, target);
        return;
      } catch (err: any) {
        if (attempt === 4 || (err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "EACCES")) {
          // fallback to direct write
          await writeFile(target, JSON.stringify(value, null, 2));
          try {
            await unlink(temp);
          } catch {
            // ignore temp unlink error
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  }

  private async loadUnlocked(): Promise<AppState> {
    return {
      settings: await this.loadSettings(),
      bots: await this.loadArray(FILES.bots, BotConfigSchema),
      workspaces: await this.loadArray(FILES.workspaces, WorkspaceSchema),
      topics: await this.loadArray(FILES.topics, TopicSchema),
      messages: await this.loadArray(FILES.messages, ChatMessageSchema),
      pipelines: await this.loadArray(FILES.pipelines, PipelineTaskSchema),
      users: await this.loadArray(FILES.users, StoredUserSchema),
    };
  }

  /**
   * Reads and parses one data file. Returns `undefined` when the file is
   * missing or blank. A file that is not valid JSON (e.g. truncated by a crash
   * during the non-atomic fallback write) is renamed to
   * `<file>.corrupt-<timestamp>` and treated as missing, so one bad file does
   * not keep the whole runtime from starting and its contents stay on disk.
   */
  private async readJsonFile(file: string): Promise<unknown> {
    const target = join(this.dataDir, file);
    let raw: string;
    try {
      raw = await readFile(target, "utf-8");
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    if (!raw.trim()) return undefined;
    try {
      return JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${target}.corrupt-${stamp}`;
      await rename(target, backup);
      console.error(
        `[json-store] ${file} is not valid JSON (${error.message}); moved to ${backup} and starting with an empty value.`,
      );
      return undefined;
    }
  }

  private async loadSettings() {
    const parsed = await this.readJsonFile(FILES.settings);
    if (parsed === undefined) {
      return AppSettingsSchema.parse({
        theme: "warm",
        defaultEngine: "claude",
        dataDir: this.dataDir,
        notifications: true,
      });
    }
    return AppSettingsSchema.parse(parsed);
  }

  private async loadArray<T>(
    file: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const parsed = await this.readJsonFile(file);
    if (parsed === undefined) return [];
    return z.array(schema).parse(parsed);
  }
}
