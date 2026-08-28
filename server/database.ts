import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPath = resolve(projectRoot, "data/wardrobe-atlas.sqlite");
const schemaPath = resolve(projectRoot, "server/schema.sql");

let database: Database.Database | undefined;

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableExists(db, table)) return;
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function addBackwardCompatibleColumns(db: Database.Database): void {
  addColumnIfMissing(db, "products", "annotations_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "products", "stock_status", "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, "products", "stock_checked_at", "TEXT");
  addColumnIfMissing(db, "products", "price_checked_at", "TEXT");
  addColumnIfMissing(db, "products", "sizes_checked_at", "TEXT");
  addColumnIfMissing(db, "visual_jobs", "analysis_mode", "TEXT NOT NULL DEFAULT 'sequential'");
  addColumnIfMissing(db, "visual_jobs", "reference_images_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "visual_jobs", "constraints_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "visual_jobs", "candidates_frozen_at", "TEXT");
}

/** Apply every storage migration safely to both fresh and legacy databases. */
export function migrateDatabase(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Index declarations in schema.sql reference the new columns, so legacy tables
  // must receive those columns before the full idempotent schema is evaluated.
  addBackwardCompatibleColumns(db);
  db.exec(readFileSync(schemaPath, "utf8"));
  addBackwardCompatibleColumns(db);
}

export function getDatabase(): Database.Database {
  if (database) return database;
  const path = process.env.WARDROBE_DB_PATH
    ? resolve(process.env.WARDROBE_DB_PATH)
    : defaultPath;
  mkdirSync(dirname(path), { recursive: true });
  database = new Database(path);
  database.pragma("journal_mode = WAL");
  migrateDatabase(database);
  database.pragma("optimize");
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
}
