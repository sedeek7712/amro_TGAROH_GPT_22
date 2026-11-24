-- SQLite schema migration 003: isolated product media metadata.
-- Binary assets are stored under the stable Electron userData/ProductMedia folder.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_images (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  thumbnail_storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp','image/jpeg','image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  thumbnail_size_bytes INTEGER NOT NULL CHECK (thumbnail_size_bytes > 0 AND thumbnail_size_bytes <= 1048576),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'PENDING_UPLOAD'
    CHECK (sync_status IN ('LOCAL_ONLY','PENDING_UPLOAD','UPLOADING','SYNCED','FAILED')),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,storage_key),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_product_images_product
  ON product_images(tenant_id, product_id, is_deleted, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_images_activity
  ON product_images(tenant_id, activity_id, is_deleted);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_images_single_primary
  ON product_images(tenant_id, product_id)
  WHERE is_primary = 1 AND is_deleted = 0;
