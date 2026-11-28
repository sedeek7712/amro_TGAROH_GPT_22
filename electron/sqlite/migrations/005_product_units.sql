-- SQLite schema migration 005: alternate units only; no price fields or operational conversion.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_units (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  code TEXT NOT NULL CHECK (length(trim(code)) > 0),
  name_ar TEXT NOT NULL CHECK (length(trim(name_ar)) > 0),
  name_en TEXT,
  base_units_numerator INTEGER NOT NULL CHECK (typeof(base_units_numerator) = 'integer' AND base_units_numerator > 0),
  base_units_denominator INTEGER NOT NULL CHECK (typeof(base_units_denominator) = 'integer' AND base_units_denominator > 0),
  barcode TEXT,
  normalized_barcode TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, code),
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES products(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_product_units_product
  ON product_units(tenant_id, product_id, is_active, name_ar);

CREATE INDEX IF NOT EXISTS idx_product_units_barcode
  ON product_units(tenant_id, normalized_barcode)
  WHERE normalized_barcode IS NOT NULL;
