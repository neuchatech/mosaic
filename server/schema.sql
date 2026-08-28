CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'shop',
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL,
  original_price REAL,
  currency TEXT NOT NULL DEFAULT 'CHF',
  category TEXT NOT NULL DEFAULT 'Autre',
  color TEXT NOT NULL DEFAULT 'Inconnue',
  color_family TEXT NOT NULL DEFAULT 'unknown',
  fit TEXT NOT NULL DEFAULT 'unknown',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  materials_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  sizes_json TEXT NOT NULL DEFAULT '[]',
  images_json TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 1,
  decision TEXT NOT NULL DEFAULT 'unseen',
  x REAL NOT NULL DEFAULT .5,
  y REAL NOT NULL DEFAULT .5,
  scores_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, source_id)
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  max_inspections INTEGER NOT NULL,
  target_count INTEGER NOT NULL,
  threshold REAL NOT NULL DEFAULT 0.5,
  analysis_mode TEXT NOT NULL DEFAULT 'sequential',
  reference_images_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_products_source_category ON products(source, category);
CREATE INDEX IF NOT EXISTS idx_products_decision ON products(decision);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_color_fit ON products(color_family, fit);
CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_visual_assessments_job_score ON visual_assessments(job_id, score DESC);
