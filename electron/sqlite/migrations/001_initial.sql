-- SQLite schema migration 001
-- Exact source values are retained in JSON payloads and decimal TEXT columns.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'YER',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
);
CREATE TABLE IF NOT EXISTS branches (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, code TEXT NOT NULL, name_ar TEXT NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,code),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS activities (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, code TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,code),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS accounts (
  tenant_id TEXT NOT NULL, code TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  parent_code TEXT, is_leaf INTEGER NOT NULL DEFAULT 1 CHECK (is_leaf IN (0,1)),
  balance_decimal TEXT NOT NULL DEFAULT '0', data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,code),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,parent_code) REFERENCES accounts(tenant_id,code) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS products (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, activity_id TEXT NOT NULL, code TEXT NOT NULL,
  barcode TEXT, category TEXT NOT NULL DEFAULT '', current_stock_decimal TEXT NOT NULL DEFAULT '0',
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,activity_id) REFERENCES activities(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS product_batches (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, product_id TEXT NOT NULL, batch_number TEXT NOT NULL,
  expiry_date TEXT NOT NULL DEFAULT '', quantity_decimal TEXT NOT NULL DEFAULT '0',
  cost_price_decimal TEXT NOT NULL DEFAULT '0', data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS parties (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER','SUPPLIER')),
  name_ar TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', balance_decimal TEXT NOT NULL DEFAULT '0',
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS invoices (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, invoice_number TEXT NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('SALE','PURCHASE','RETURN_SALE','RETURN_PURCHASE')),
  activity_id TEXT NOT NULL, party_id TEXT, invoice_date TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH','CREDIT','BANK_TRANSFER')),
  total_decimal TEXT NOT NULL, paid_amount_decimal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'POSTED',
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS invoice_items (
  tenant_id TEXT NOT NULL, invoice_id TEXT NOT NULL, id TEXT NOT NULL, product_id TEXT NOT NULL,
  quantity_decimal TEXT NOT NULL, unit_price_decimal TEXT NOT NULL, total_decimal TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,invoice_id,id),
  FOREIGN KEY (tenant_id,invoice_id) REFERENCES invoices(tenant_id,id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS invoice_stock_deductions (
  tenant_id TEXT NOT NULL, invoice_id TEXT NOT NULL, line_number INTEGER NOT NULL CHECK (line_number >= 0),
  product_id TEXT NOT NULL, batch_number TEXT, quantity_decimal TEXT NOT NULL, unit_cost_decimal TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,invoice_id,line_number),
  FOREIGN KEY (tenant_id,invoice_id) REFERENCES invoices(tenant_id,id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS journal_entries (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, entry_number TEXT NOT NULL,
  entry_date TEXT NOT NULL, cost_center_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  reference_type TEXT, reference_id TEXT, data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  tenant_id TEXT NOT NULL, entry_id TEXT NOT NULL, id TEXT NOT NULL, account_code TEXT NOT NULL,
  debit_decimal TEXT NOT NULL DEFAULT '0', credit_decimal TEXT NOT NULL DEFAULT '0',
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,entry_id,id),
  FOREIGN KEY (tenant_id,entry_id) REFERENCES journal_entries(tenant_id,id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (debit_decimal <> '' AND credit_decimal <> '')
);
CREATE TABLE IF NOT EXISTS cash_boxes (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, code TEXT NOT NULL,
  account_code TEXT NOT NULL, balance_decimal TEXT NOT NULL DEFAULT '0',
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS vouchers (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, voucher_number TEXT NOT NULL,
  voucher_type TEXT NOT NULL CHECK (voucher_type IN ('RECEIPT','PAYMENT')),
  voucher_date TEXT NOT NULL, amount_decimal TEXT NOT NULL, cash_box_id TEXT NOT NULL,
  party_id TEXT, data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS amanat_records (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, record_number TEXT NOT NULL,
  amanat_type TEXT NOT NULL CHECK (amanat_type IN ('CASH','ITEM')),
  status TEXT NOT NULL CHECK (status IN ('HELD','RETURNED','CANCELLED')),
  amount_decimal TEXT NOT NULL DEFAULT '0', received_date TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS users (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','ACCOUNTANT','CASHIER','INVENTORY_KEEPER')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), password_hash TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, timestamp TEXT NOT NULL,
  user_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS outbox_queue (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('CREATE','UPDATE','DELETE')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','SYNCING','SYNCED','FAILED')),
  idempotency_key TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  priority INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL, next_retry_at TEXT,
  lease_owner TEXT, lease_expires_at TEXT, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','RESOLVED_LOCAL','RESOLVED_REMOTE','RESOLVED_MERGED')),
  detected_at TEXT NOT NULL, local_payload_json TEXT NOT NULL CHECK (json_valid(local_payload_json)),
  remote_payload_json TEXT NOT NULL CHECK (json_valid(remote_payload_json)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS document_sequences (
  tenant_id TEXT NOT NULL, sequence_key TEXT NOT NULL, last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id,sequence_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS pos_terminals (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT NOT NULL, code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS device_registrations (
  tenant_id TEXT NOT NULL, device_id TEXT NOT NULL, branch_id TEXT, device_name TEXT NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN ('DESKTOP','MOBILE','TABLET','WEB')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,device_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS app_settings (
  tenant_id TEXT NOT NULL, setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)), updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,setting_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_products_activity_code ON products(tenant_id,activity_id,code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(tenant_id,barcode);
CREATE INDEX IF NOT EXISTS idx_batches_product_expiry ON product_batches(tenant_id,product_id,expiry_date);
CREATE INDEX IF NOT EXISTS idx_parties_type_name ON parties(tenant_id,party_type,name_ar);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(tenant_id,invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_branch_date ON invoices(tenant_id,branch_id,invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_party ON invoices(tenant_id,party_id,invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items(tenant_id,product_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(tenant_id,entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reference ON journal_entries(tenant_id,reference_type,reference_id);
CREATE INDEX IF NOT EXISTS idx_cash_boxes_branch ON cash_boxes(tenant_id,branch_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(tenant_id,voucher_date DESC);
CREATE INDEX IF NOT EXISTS idx_amanat_status_date ON amanat_records(tenant_id,status,received_date DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(tenant_id,username);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(tenant_id,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status_retry ON outbox_queue(tenant_id,status,next_retry_at,priority);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON sync_conflicts(tenant_id,status,detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminals_branch ON pos_terminals(tenant_id,branch_id);
INSERT OR IGNORE INTO tenants (id,name,code,currency,is_active,data_json)
VALUES ('tenant_main','المنشأة الرئيسية','MAIN','YER',1,
'{"id":"tenant_main","name":"المنشأة الرئيسية","code":"MAIN","currency":"YER","isActive":true}');
INSERT OR IGNORE INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json)
VALUES ('tenant_main','branch_main','BR01','الفرع الرئيسي',1,1,
'{"id":"branch_main","code":"BR01","nameAr":"الفرع الرئيسي","isMain":true,"active":true}');
