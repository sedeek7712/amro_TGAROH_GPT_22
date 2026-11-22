-- SQLite schema migration 002
-- Payment allocations (FIFO + Manual override), Party advance balances & ledger (2103 / 1105),
-- Voucher lifecycle statuses, invoice due_date & advance_applied_decimal, and Allocation audit trail.
PRAGMA foreign_keys = ON;

ALTER TABLE parties ADD COLUMN advance_balance_decimal TEXT NOT NULL DEFAULT '0';
ALTER TABLE invoices ADD COLUMN due_date TEXT;
ALTER TABLE invoices ADD COLUMN advance_applied_decimal TEXT NOT NULL DEFAULT '0';

CREATE TABLE IF NOT EXISTS payment_allocations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  branch_id TEXT,
  voucher_id TEXT,
  advance_transaction_id TEXT,
  party_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  allocated_decimal TEXT NOT NULL,
  allocation_method TEXT NOT NULL CHECK (allocation_method IN ('FIFO','MANUAL','ADVANCE_SETTLEMENT')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVERSED')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS party_advance_transactions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  branch_id TEXT,
  party_id TEXT NOT NULL,
  party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER','SUPPLIER')),
  tx_type TEXT NOT NULL CHECK (tx_type IN ('OVERPAYMENT_DEPOSIT','PREPAYMENT_DEPOSIT','APPLY_TO_INVOICE','REFUND','REVERSAL')),
  amount_decimal TEXT NOT NULL,
  balance_after_decimal TEXT NOT NULL,
  voucher_id TEXT,
  invoice_id TEXT,
  journal_entry_id TEXT,
  tx_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS allocation_audits (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  branch_id TEXT,
  voucher_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  audit_timestamp TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payment_alloc_party_invoice ON payment_allocations(tenant_id,party_id,invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_alloc_voucher ON payment_allocations(tenant_id,voucher_id);
CREATE INDEX IF NOT EXISTS idx_party_advances_party_date ON party_advance_transactions(tenant_id,party_id,tx_date DESC);
CREATE INDEX IF NOT EXISTS idx_party_advances_voucher ON party_advance_transactions(tenant_id,voucher_id);
CREATE INDEX IF NOT EXISTS idx_alloc_audits_voucher ON allocation_audits(tenant_id,voucher_id,audit_timestamp DESC);

-- Conditional COA backfill: ONLY on tenants that already have seeded accounts,
-- preserving completely empty fresh databases for legacy JSON backup import.
INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'1105','ASSET','11',1,'0.00',
  json_object('code','1105','nameAr','سلف الموردين (دفعات مقدمة للموردين)','type','ASSET','parentCode','11','isLeaf',json('true'),'balance',0,'tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '11');

INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'2103','LIABILITY','21',1,'0.00',
  json_object('code','2103','nameAr','دفعات مقدمة من العملاء','type','LIABILITY','parentCode','21','isLeaf',json('true'),'balance',0,'tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '21');

INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'42','REVENUE','4',0,'0.00',
  json_object('code','42','nameAr','مردودات ومسموحات المبيعات','type','REVENUE','parentCode','4','isLeaf',json('false'),'balance',0,'tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '4');

INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'4201','REVENUE','42',1,'0.00',
  json_object('code','4201','nameAr','مردودات مبيعات الصيدلية','type','REVENUE','parentCode','42','isLeaf',json('true'),'balance',0,'costCenterId','pharmacy','tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '42');

INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'4202','REVENUE','42',1,'0.00',
  json_object('code','4202','nameAr','مردودات مبيعات المواد الغذائية والبقالة','type','REVENUE','parentCode','42','isLeaf',json('true'),'balance',0,'costCenterId','grocery','tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '42');

INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'4203','REVENUE','42',1,'0.00',
  json_object('code','4203','nameAr','مردودات مبيعات قطع غيار الدراجات','type','REVENUE','parentCode','42','isLeaf',json('true'),'balance',0,'costCenterId','bike_parts','tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '42');

INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json)
SELECT t.id,'4204','REVENUE','42',1,'0.00',
  json_object('code','4204','nameAr','مردودات مبيعات قطع غيار المعدات','type','REVENUE','parentCode','42','isLeaf',json('true'),'balance',0,'costCenterId','equipment_parts','tenantId',t.id)
FROM tenants t
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = '42');

UPDATE parties
SET data_json = json_set(data_json, '$.advanceBalance', 0)
WHERE json_extract(data_json, '$.advanceBalance') IS NULL;

UPDATE vouchers
SET data_json = json_set(data_json, '$.status', 'POSTED')
WHERE json_extract(data_json, '$.status') IS NULL;
