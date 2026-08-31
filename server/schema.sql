CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT 'generic',
  schema_version INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO workspaces (
  id, name, description, profile, schema_version, settings_json, created_at, updated_at
) VALUES (
  'default-clothing', 'My workspace', 'Default Neuchatech MosAIc workspace', 'clothing', 1,
  '{}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  kind TEXT NOT NULL DEFAULT 'shop',
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL,
  original_price REAL,
  currency TEXT NOT NULL DEFAULT 'XXX',
  category TEXT NOT NULL DEFAULT 'Other',
  color TEXT NOT NULL DEFAULT 'Unknown',
  color_family TEXT NOT NULL DEFAULT 'unknown',
  fit TEXT NOT NULL DEFAULT 'unknown',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  materials_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  annotations_json TEXT NOT NULL DEFAULT '{}',
  sizes_json TEXT NOT NULL DEFAULT '[]',
  images_json TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 1,
  stock_status TEXT NOT NULL DEFAULT 'unknown',
  stock_checked_at TEXT,
  price_checked_at TEXT,
  sizes_checked_at TEXT,
  decision TEXT NOT NULL DEFAULT 'unseen',
  x REAL NOT NULL DEFAULT .5,
  y REAL NOT NULL DEFAULT .5,
  embedding_revision TEXT,
  scores_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, source, source_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filter_json TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  created_at TEXT NOT NULL,
  undone_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS decision_action_items (
  action_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  before_decision TEXT NOT NULL,
  after_decision TEXT NOT NULL,
  PRIMARY KEY(action_id, product_id),
  FOREIGN KEY(action_id) REFERENCES decision_actions(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  start_url TEXT NOT NULL,
  status TEXT NOT NULL,
  products_seen INTEGER NOT NULL DEFAULT 0,
  products_saved INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS visual_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  max_inspections INTEGER NOT NULL,
  target_count INTEGER NOT NULL,
  threshold REAL NOT NULL DEFAULT 0.5,
  analysis_mode TEXT NOT NULL DEFAULT 'sequential',
  reference_images_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  candidates_frozen_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS visual_job_candidates (
  job_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, product_id),
  FOREIGN KEY(job_id) REFERENCES visual_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS visual_assessments (
  job_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  score REAL NOT NULL,
  rejected INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  signals_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, product_id),
  FOREIGN KEY(job_id) REFERENCES visual_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS acquisition_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'enrichment',
  status TEXT NOT NULL DEFAULT 'queued',
  total_items INTEGER NOT NULL DEFAULT 0,
  succeeded_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  blocked_items INTEGER NOT NULL DEFAULT 0,
  cancelled_items INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS acquisition_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  product_id TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(job_id, url),
  FOREIGN KEY(job_id) REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS outfit_boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default-clothing',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS outfit_board_items (
  board_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'item',
  position INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(board_id, product_id),
  FOREIGN KEY(board_id) REFERENCES outfit_boards(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_field_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  primitive_type TEXT NOT NULL,
  unit TEXT,
  semantic_role TEXT,
  facetable INTEGER NOT NULL DEFAULT 0,
  sortable INTEGER NOT NULL DEFAULT 0,
  display_enabled INTEGER NOT NULL DEFAULT 1,
  coverage REAL NOT NULL DEFAULT 0,
  cardinality INTEGER NOT NULL DEFAULT 0,
  source_aliases_json TEXT NOT NULL DEFAULT '[]',
  normalizer TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  inferred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, field_key),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  collection_type TEXT NOT NULL DEFAULT 'manual',
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  description TEXT NOT NULL DEFAULT '',
  smart_filter_json TEXT,
  system_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, system_key),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(collection_id, product_id),
  FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL DEFAULT 'other',
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  local_files_json TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL DEFAULT '',
  input_item_ids_json TEXT NOT NULL DEFAULT '[]',
  input_collection_ids_json TEXT NOT NULL DEFAULT '[]',
  generator TEXT,
  error TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_products_source_category ON products(source, category);
CREATE INDEX IF NOT EXISTS idx_products_decision ON products(decision);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_color_fit ON products(color_family, fit);
CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_stock_status ON products(stock_status, stock_checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_views_updated_at ON saved_views(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_actions_created_at ON decision_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visual_assessments_job_score ON visual_assessments(job_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_visual_candidates_job_ordinal ON visual_job_candidates(job_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_status_updated ON acquisition_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_items_job_status ON acquisition_job_items(job_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_outfit_boards_updated_at ON outfit_boards(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outfit_items_board_position ON outfit_board_items(board_id, position);
CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_fields_order ON workspace_field_definitions(workspace_id, display_order, field_key);
CREATE INDEX IF NOT EXISTS idx_workspace_fields_facets ON workspace_field_definitions(workspace_id, facetable, display_order);
CREATE INDEX IF NOT EXISTS idx_collections_workspace_updated ON collections(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_items_order ON collection_items(collection_id, position, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_updated ON artifacts(workspace_id, updated_at DESC);
