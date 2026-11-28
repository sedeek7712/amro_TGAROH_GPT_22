-- SQLite schema migration 007
-- Protect product codes from new normalized duplicates without failing on legacy duplicates
-- and without blocking non-code updates on historical duplicate rows.
PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_products_tenant_normalized_code
  ON products(tenant_id, lower(trim(code)));

CREATE TRIGGER IF NOT EXISTS trg_products_prevent_duplicate_code_insert
BEFORE INSERT ON products
WHEN length(trim(NEW.code)) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM products self
    WHERE self.tenant_id = NEW.tenant_id
      AND self.id = NEW.id
      AND lower(trim(self.code)) = lower(trim(NEW.code))
  )
  AND EXISTS (
    SELECT 1
    FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND lower(trim(p.code)) = lower(trim(NEW.code))
      AND p.id <> NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'كود الصنف مستخدم بالفعل.');
END;

CREATE TRIGGER IF NOT EXISTS trg_products_prevent_duplicate_code_update
BEFORE UPDATE OF code, tenant_id ON products
WHEN (
    NEW.tenant_id <> OLD.tenant_id
    OR lower(trim(NEW.code)) <> lower(trim(OLD.code))
  )
  AND length(trim(NEW.code)) > 0
  AND EXISTS (
    SELECT 1
    FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND lower(trim(p.code)) = lower(trim(NEW.code))
      AND p.id <> OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'كود الصنف مستخدم بالفعل.');
END;
