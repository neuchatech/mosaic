import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPath = resolve(projectRoot, "data/wardrobe-atlas.sqlite");

let database: Database.Database | undefined;

export function getDatabase(): Database.Database {
  if (database) return database;
  const path = process.env.WARDROBE_DB_PATH
    ? resolve(process.env.WARDROBE_DB_PATH)
    : defaultPath;
  mkdirSync(dirname(path), { recursive: true });
  database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(readFileSync(resolve(projectRoot, "server/schema.sql"), "utf8"));
  const visualJobColumns = database.pragma("table_info(visual_jobs)") as { name: string }[];
  if (!visualJobColumns.some((column) => column.name === "analysis_mode")) {
    database.exec("ALTER TABLE visual_jobs ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'sequential'");
  }
  if (!visualJobColumns.some((column) => column.name === "reference_images_json")) {
    database.exec("ALTER TABLE visual_jobs ADD COLUMN reference_images_json TEXT NOT NULL DEFAULT '[]'");
  }
  database.pragma("optimize");
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
}
