import type Database from "better-sqlite3";
import { DEFAULT_CLOTHING_WORKSPACE_ID } from "../src/domain/workspace";

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

/**
 * Research runs are generic Activity records, not a replacement for the
 * specialized legacy job tables. Keeping this migration here also makes a
 * directly constructed CatalogRepository safe when its database predates the
 * research runtime.
 */
export function migrateResearchRunSchema(db: Database.Database): void {
  if (!tableExists(db, "workspaces")) {
    throw new Error("Workspace tables are missing; research runs require a workspace owner.");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL DEFAULT 'medium',
      input_json TEXT NOT NULL DEFAULT '{}',
      budget_json TEXT NOT NULL DEFAULT '{}',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      message TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS research_run_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence),
      FOREIGN KEY(run_id) REFERENCES research_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      research_run_id TEXT,
      context_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(research_run_id, role),
      FOREIGN KEY(conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(research_run_id) REFERENCES research_runs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_runs_workspace_updated
      ON research_runs(workspace_id, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_research_runs_workspace_status
      ON research_runs(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_run_events_sequence
      ON research_run_events(run_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_assistant_conversations_workspace_updated
      ON assistant_conversations(workspace_id, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation_created
      ON assistant_messages(conversation_id, created_at, id);
  `);
}

function hasLegacyGlobalProductIdentity(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'
  `).get() as { sql?: string } | undefined;
  return /UNIQUE\s*\(\s*source\s*,\s*source_id\s*\)/i.test(row?.sql ?? "");
}

function recreateProductIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_source_category ON products(source, category);
    CREATE INDEX IF NOT EXISTS idx_products_decision ON products(decision);
    CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
    CREATE INDEX IF NOT EXISTS idx_products_color_fit ON products(color_family, fit);
    CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_stock_status
      ON products(stock_status, stock_checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_workspace_updated
      ON products(workspace_id, updated_at DESC);
  `);
}

/** Remove the legacy global shop-identity constraint without changing a row ID. */
function migrateProductIdentityScope(db: Database.Database): void {
  if (!hasLegacyGlobalProductIdentity(db)) {
    recreateProductIndexes(db);
    return;
  }
  if (db.inTransaction) {
    throw new Error("Product identity migration cannot run inside another SQLite transaction.");
  }
  const foreignKeysEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  const auxiliarySql = db.prepare(`
    SELECT type, sql FROM sqlite_master
    WHERE tbl_name = 'products' AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `).all() as Array<{ type: "index" | "trigger"; sql: string }>;
  if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      DROP TABLE IF EXISTS products__workspace_identity_v1;
      CREATE TABLE products__workspace_identity_v1 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_CLOTHING_WORKSPACE_ID}',
        kind TEXT NOT NULL DEFAULT 'shop', source TEXT NOT NULL, source_id TEXT NOT NULL,
        url TEXT NOT NULL, brand TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', price REAL, original_price REAL,
        currency TEXT NOT NULL DEFAULT 'XXX', category TEXT NOT NULL DEFAULT 'Other',
        color TEXT NOT NULL DEFAULT 'Unknown', color_family TEXT NOT NULL DEFAULT 'unknown',
        fit TEXT NOT NULL DEFAULT 'unknown', attributes_json TEXT NOT NULL DEFAULT '{}',
        materials_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]',
        annotations_json TEXT NOT NULL DEFAULT '{}', sizes_json TEXT NOT NULL DEFAULT '[]',
        images_json TEXT NOT NULL DEFAULT '[]', available INTEGER NOT NULL DEFAULT 1,
        stock_status TEXT NOT NULL DEFAULT 'unknown', stock_checked_at TEXT,
        price_checked_at TEXT, sizes_checked_at TEXT,
        decision TEXT NOT NULL DEFAULT 'unseen', x REAL NOT NULL DEFAULT .5,
        y REAL NOT NULL DEFAULT .5, embedding_revision TEXT,
        scores_json TEXT NOT NULL DEFAULT '{}', imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, source, source_id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
      );
      INSERT INTO products__workspace_identity_v1 (
        id, workspace_id, kind, source, source_id, url, brand, name, description,
        price, original_price, currency, category, color, color_family, fit,
        attributes_json, materials_json, tags_json, annotations_json, sizes_json,
        images_json, available, stock_status, stock_checked_at, price_checked_at,
        sizes_checked_at, decision, x, y, embedding_revision, scores_json,
        imported_at, updated_at
      ) SELECT
        id, workspace_id, kind, source, source_id, url, brand, name, description,
        price, original_price, currency, category, color, color_family, fit,
        attributes_json, materials_json, tags_json, annotations_json, sizes_json,
        images_json, available, stock_status, stock_checked_at, price_checked_at,
        sizes_checked_at, decision, x, y, embedding_revision, scores_json,
        imported_at, updated_at
      FROM products;
      DROP TABLE products;
      ALTER TABLE products__workspace_identity_v1 RENAME TO products;
    `);
    for (const object of auxiliarySql) {
      if (object.type === "index" && /UNIQUE\s+INDEX[\s\S]*\(\s*source\s*,\s*source_id\s*\)/i.test(object.sql)) {
        continue;
      }
      db.exec(object.sql);
    }
    recreateProductIndexes(db);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`Product identity migration left ${violations.length} foreign-key violation(s).`);
  }
}

export function favoritesCollectionId(workspaceId: string): string {
  return workspaceId === DEFAULT_CLOTHING_WORKSPACE_ID
    ? "favorites-default-clothing"
    : `favorites:${workspaceId}`;
}

function ensureFavoritesCollection(db: Database.Database, workspaceId: string, now: string): string {
  const id = favoritesCollectionId(workspaceId);
  db.prepare(`
    INSERT INTO collections (
      id, workspace_id, collection_type, name, color, icon, description,
      smart_filter_json, system_key, created_at, updated_at
    ) VALUES (?, ?, 'manual', 'Favorites', '#df705f', 'heart',
      'Synchronized with the saved decision.', NULL, 'favorites', ?, ?)
    ON CONFLICT(workspace_id, system_key) DO NOTHING
  `).run(id, workspaceId, now, now);
  const row = db.prepare(`
    SELECT id FROM collections WHERE workspace_id = ? AND system_key = 'favorites'
  `).get(workspaceId) as { id: string };
  return row.id;
}

/** Decision is the compatibility source of truth; this never changes it. */
export function syncFavoritesCompatibility(
  db: Database.Database,
  workspaceId: string,
): string {
  const now = new Date().toISOString();
  const collectionId = ensureFavoritesCollection(db, workspaceId, now);
  const desired = db.prepare(`
    SELECT id FROM products
    WHERE workspace_id = ? AND decision = 'saved'
    ORDER BY updated_at DESC, id
  `).all(workspaceId) as { id: string }[];
  const current = db.prepare(`
    SELECT product_id AS id FROM collection_items
    WHERE collection_id = ? ORDER BY position, created_at, product_id
  `).all(collectionId) as { id: string }[];
  if (desired.length === current.length && desired.every((item, index) => item.id === current[index]?.id)) {
    return collectionId;
  }
  const created = new Map((db.prepare(`
    SELECT product_id, created_at FROM collection_items WHERE collection_id = ?
  `).all(collectionId) as Array<{ product_id: string; created_at: string }>).map(
    (item) => [item.product_id, item.created_at],
  ));
  db.transaction(() => {
    db.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(collectionId);
    const insert = db.prepare(`
      INSERT INTO collection_items (
        collection_id, product_id, position, role, notes, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, '', ?, ?)
    `);
    desired.forEach((item, position) => {
      insert.run(collectionId, item.id, position, created.get(item.id) ?? now, now);
    });
    db.prepare("UPDATE collections SET updated_at = ? WHERE id = ?").run(now, collectionId);
  })();
  return collectionId;
}

export function legacyOutfitCollectionId(boardId: string): string {
  return `legacy-outfit:${boardId}`;
}

/** Keep the old outfit-board API as a compatibility writer over collections. */
export function syncOutfitBoardCompatibility(db: Database.Database, boardId: string): string | null {
  if (!tableExists(db, "outfit_boards") || !tableExists(db, "outfit_board_items")) return null;
  const board = db.prepare("SELECT * FROM outfit_boards WHERE id = ?").get(boardId) as
    | Record<string, unknown>
    | undefined;
  if (!board) return null;
  const items = db.prepare(`
    SELECT i.product_id, i.role, i.position, i.notes, i.created_at, p.workspace_id
    FROM outfit_board_items i
    JOIN products p ON p.id = i.product_id
    WHERE i.board_id = ? ORDER BY i.position, i.created_at, i.product_id
  `).all(boardId) as Array<Record<string, unknown>>;
  const workspaceId = String(board.workspace_id ?? DEFAULT_CLOTHING_WORKSPACE_ID);
  const workspaceIds = [...new Set(items.map((item) => String(item.workspace_id)))];
  if (workspaceIds.some((candidate) => candidate !== workspaceId)) {
    throw new Error(`Legacy outfit ${boardId} contains products from multiple workspaces.`);
  }
  const id = legacyOutfitCollectionId(boardId);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO collections (
        id, workspace_id, collection_type, name, color, icon, description,
        smart_filter_json, system_key, created_at, updated_at
      ) VALUES (?, ?, 'manual', ?, NULL, 'layers', ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,
        name=excluded.name, description=excluded.description,
        system_key=excluded.system_key, updated_at=excluded.updated_at
    `).run(
      id,
      workspaceId,
      String(board.name),
      String(board.description ?? ""),
      `legacy-outfit:${boardId}`,
      String(board.created_at ?? now),
      now,
    );
    db.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(id);
    const insert = db.prepare(`
      INSERT INTO collection_items (
        collection_id, product_id, position, role, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insert.run(
        id,
        item.product_id,
        Number(item.position),
        String(item.role || "item"),
        String(item.notes ?? ""),
        String(item.created_at ?? now),
        now,
      );
    }
  })();
  return id;
}

/**
 * Idempotent V1 migration. The one table rebuild removes SQLite's legacy
 * global shop-identity constraint; every product row and ID is copied verbatim.
 */
export function migrateWorkspaceSchema(db: Database.Database): void {
  if (!tableExists(db, "workspaces")) {
    throw new Error("Workspace tables are missing; execute server/schema.sql before the V1 migration.");
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspaces (
      id, name, description, profile, schema_version, settings_json, created_at, updated_at
    ) VALUES (?, 'My workspace', 'Default Neuchatech MosAIc workspace', 'clothing', 1, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    DEFAULT_CLOTHING_WORKSPACE_ID,
    JSON.stringify({}),
    now,
    now,
  );
  migrateResearchRunSchema(db);

  addColumnIfMissing(
    db,
    "products",
    "workspace_id",
    `TEXT NOT NULL DEFAULT '${DEFAULT_CLOTHING_WORKSPACE_ID}'`,
  );
  addColumnIfMissing(db, "products", "embedding_revision", "TEXT");
  for (const table of ["decision_actions", "visual_jobs", "acquisition_jobs", "outfit_boards"]) {
    addColumnIfMissing(
      db,
      table,
      "workspace_id",
      `TEXT NOT NULL DEFAULT '${DEFAULT_CLOTHING_WORKSPACE_ID}'`,
    );
  }
  addColumnIfMissing(
    db,
    "saved_filters",
    "workspace_id",
    `TEXT NOT NULL DEFAULT '${DEFAULT_CLOTHING_WORKSPACE_ID}'`,
  );
  addColumnIfMissing(
    db,
    "saved_views",
    "workspace_id",
    `TEXT NOT NULL DEFAULT '${DEFAULT_CLOTHING_WORKSPACE_ID}'`,
  );
  db.prepare(`
    UPDATE products SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''
  `).run(DEFAULT_CLOTHING_WORKSPACE_ID);
  migrateProductIdentityScope(db);
  if (tableExists(db, "saved_filters")) {
    db.prepare(`
      UPDATE saved_filters SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''
    `).run(DEFAULT_CLOTHING_WORKSPACE_ID);
  }
  if (tableExists(db, "saved_views")) {
    db.prepare(`
      UPDATE saved_views SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''
    `).run(DEFAULT_CLOTHING_WORKSPACE_ID);
  }
  const ownerBackfills = [
    { owner: "decision_actions", membership: "decision_action_items", ownerKey: "action_id" },
    { owner: "visual_jobs", membership: "visual_job_candidates", ownerKey: "job_id" },
    { owner: "acquisition_jobs", membership: "acquisition_job_items", ownerKey: "job_id" },
    { owner: "outfit_boards", membership: "outfit_board_items", ownerKey: "board_id" },
  ];
  for (const { owner, membership, ownerKey } of ownerBackfills) {
    if (!tableExists(db, owner) || !tableExists(db, membership)) continue;
    db.exec(`
      UPDATE ${owner} SET workspace_id = (
        SELECT MIN(p.workspace_id) FROM ${membership} membership
        JOIN products p ON p.id = membership.product_id
        WHERE membership.${ownerKey} = ${owner}.id
      )
      WHERE 1 = (
        SELECT COUNT(DISTINCT p.workspace_id) FROM ${membership} membership
        JOIN products p ON p.id = membership.product_id
        WHERE membership.${ownerKey} = ${owner}.id
      );
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_workspace_updated
      ON products(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_saved_filters_workspace_updated
      ON saved_filters(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_saved_views_workspace_updated
      ON saved_views(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_actions_workspace_created
      ON decision_actions(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visual_jobs_workspace_updated
      ON visual_jobs(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_workspace_updated
      ON acquisition_jobs(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outfit_boards_workspace_updated
      ON outfit_boards(workspace_id, updated_at DESC);
  `);

  const workspaces = db.prepare("SELECT id FROM workspaces").all() as { id: string }[];
  for (const workspace of workspaces) syncFavoritesCompatibility(db, workspace.id);

  if (tableExists(db, "outfit_boards")) {
    const boards = db.prepare("SELECT id FROM outfit_boards").all() as { id: string }[];
    for (const board of boards) {
      const alreadyMigrated = db.prepare(`
        SELECT 1 FROM collections WHERE system_key = ?
      `).get(`legacy-outfit:${board.id}`);
      if (!alreadyMigrated) syncOutfitBoardCompatibility(db, board.id);
    }
  }
}
