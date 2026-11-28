-- SQLite schema migration 004: optional product catalog metadata.
-- Existing products remain independent SKUs; no stock, invoice, or accounting rows are changed.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brands (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name_ar TEXT NOT NULL CHECK (length(trim(name_ar)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, normalized_name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS product_families (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  name_ar TEXT NOT NULL CHECK (length(trim(name_ar)) > 0),
  category_snapshot TEXT NOT NULL DEFAULT '',
  brand_id TEXT,
  option_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(option_schema_json) AND json_type(option_schema_json) = 'array'),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, activity_id) REFERENCES activities(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_product_families_activity
  ON product_families(tenant_id, activity_id, is_active, name_ar);

CREATE TABLE IF NOT EXISTS product_catalog_meta (
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  family_id TEXT,
  brand_id TEXT,
  variant_key TEXT,
  variant_attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(variant_attributes_json) AND json_type(variant_attributes_json) = 'object'),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id, product_id),
  CHECK (
    (family_id IS NULL AND variant_key IS NULL AND brand_id IS NOT NULL)
    OR
    (family_id IS NOT NULL AND length(trim(variant_key)) > 0 AND brand_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, family_id) REFERENCES product_families(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_catalog_meta_family_variant
  ON product_catalog_meta(tenant_id, family_id, variant_key)
  WHERE family_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_catalog_meta_brand
  ON product_catalog_meta(tenant_id, brand_id)
  WHERE brand_id IS NOT NULL;
