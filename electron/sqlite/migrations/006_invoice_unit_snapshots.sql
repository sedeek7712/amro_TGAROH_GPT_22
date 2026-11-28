-- SQLite schema migration 006: nullable historical unit snapshots on invoice items & deduction line attribution.
-- Existing rows intentionally remain NULL (never silently backfilled).
PRAGMA foreign_keys = ON;

ALTER TABLE invoice_items ADD COLUMN base_quantity_decimal TEXT;
ALTER TABLE invoice_stock_deductions ADD COLUMN invoice_item_id TEXT;
