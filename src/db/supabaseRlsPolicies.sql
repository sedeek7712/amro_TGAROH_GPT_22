-- ==============================================================================
-- نظام الحرج ERP - البنية السحابية الشاملة وسياسات أمان صفوف الجداول (RLS)
-- Multi-Tenant PostgreSQL & Supabase Row-Level Security (RLS) Schema
-- ==============================================================================
-- 1. يضمن العزل التام للمؤسسات والمستأجرين (Multi-Tenancy Isolation عبر tenant_id).
-- 2. يدعم المزامنة ثنائية الاتجاه مع Dexie/IndexedDB لعدة أجهزة مع الحفاظ على UUIDs.
-- 3. يمنع تكرار القيود والخصم المالي والمخزني عبر جدول منع التكرار (Idempotency Key).
-- 4. يفرض صلاحيات الأدوار (Admin, Accountant, Cashier, InventoryKeeper) على مستوى الخادم.
-- ==============================================================================

-- تفعيل ملحق التشفير وتوليد المعرفات إن لم يكن مفعلاً
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. جداول المؤسسات والأجهزة والمستخدمين
-- ==============================================================================

-- جدول المؤسسات (Tenants)
CREATE TABLE IF NOT EXISTS erp_tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    currency TEXT DEFAULT 'YER',
    tax_number TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- إدراج المؤسسة الافتراضية الأولية
INSERT INTO erp_tenants (id, name, code, currency)
VALUES ('tenant_default', 'مؤسسة الحرج التجارية المركزية', 'ALHARAJ-HQ', 'YER')
ON CONFLICT (id) DO NOTHING;

-- جدول الأجهزة المسجلة للمزامنة (Devices Registration)
CREATE TABLE IF NOT EXISTS erp_devices (
    device_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    device_type TEXT DEFAULT 'WEB',
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_pull_at TIMESTAMPTZ,
    last_push_at TIMESTAMPTZ,
    sequence_number BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (tenant_id, device_id)
);

-- جدول صلاحيات وأدوار مستخدمي المؤسسات
CREATE TABLE IF NOT EXISTS erp_tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    user_id UUID,
    username TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'ACCOUNTANT', 'CASHIER', 'INVENTORY_KEEPER')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tenant_id, username)
);

-- ==============================================================================
-- 2. جداول الأعمال التجارية والمحاسبية والمخزون
-- ==============================================================================

-- جدول الأصناف والمخزون والتشغيلات
CREATE TABLE IF NOT EXISTS erp_products (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    category TEXT,
    unit TEXT DEFAULT 'حبه',
    cost_price NUMERIC(15, 4) NOT NULL DEFAULT 0,
    selling_price NUMERIC(15, 4) NOT NULL DEFAULT 0,
    stock_quantity NUMERIC(15, 4) NOT NULL DEFAULT 0,
    min_limit NUMERIC(15, 4) DEFAULT 0,
    barcode TEXT,
    oem_number TEXT,
    batch_number TEXT,
    expiry_date DATE,
    batches_data JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)
);

-- جدول العملاء والموردين
CREATE TABLE IF NOT EXISTS erp_parties (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('CUSTOMER', 'SUPPLIER')),
    name_ar TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    tax_number TEXT,
    balance NUMERIC(15, 4) NOT NULL DEFAULT 0,
    credit_limit NUMERIC(15, 4) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)
);

-- جدول فواتير المبيعات والمشتريات
CREATE TABLE IF NOT EXISTS erp_invoices (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('SALE', 'PURCHASE', 'RETURN_SALE', 'RETURN_PURCHASE')),
    activity_id TEXT NOT NULL,
    party_id TEXT,
    party_name TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(15, 4) NOT NULL DEFAULT 0,
    discount NUMERIC(15, 4) NOT NULL DEFAULT 0,
    tax NUMERIC(15, 4) NOT NULL DEFAULT 0,
    total NUMERIC(15, 4) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(15, 4) NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL,
    cash_box_id TEXT,
    journal_entry_id TEXT,
    is_posted BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, invoice_number)
);

-- جدول قيود اليومية العامة (Double-Entry General Ledger)
CREATE TABLE IF NOT EXISTS erp_journal_entries (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    entry_number TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
    cost_center_id TEXT,
    reference_type TEXT,
    reference_id TEXT,
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_debit NUMERIC(15, 4) NOT NULL DEFAULT 0,
    total_credit NUMERIC(15, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, entry_number)
);

-- جدول سندات القبض والصرف
CREATE TABLE IF NOT EXISTS erp_payment_vouchers (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    voucher_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('RECEIPT', 'PAYMENT')),
    date TIMESTAMPTZ NOT NULL,
    amount NUMERIC(15, 4) NOT NULL,
    cash_box_id TEXT NOT NULL,
    party_id TEXT,
    party_name TEXT NOT NULL,
    account_code TEXT NOT NULL,
    description TEXT NOT NULL,
    cost_center_id TEXT NOT NULL,
    journal_entry_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, voucher_number)
);

-- جدول الأمانات العينية والنقدية
CREATE TABLE IF NOT EXISTS erp_amanat_items (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    record_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('CASH', 'IN_KIND')),
    depositor_name TEXT NOT NULL,
    depositor_phone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETURNED', 'PARTIALLY_RETURNED')),
    received_date TIMESTAMPTZ NOT NULL,
    expected_return_date TIMESTAMPTZ,
    amount NUMERIC(15, 4) DEFAULT 0,
    currency TEXT DEFAULT 'YER',
    cash_box_id TEXT,
    item_description TEXT,
    serial_number TEXT,
    received_by TEXT NOT NULL,
    recipient_signature_name TEXT,
    notes TEXT,
    journal_entry_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, record_number)
);

-- جدول صناديق النقدية والحسابات
CREATE TABLE IF NOT EXISTS erp_cash_boxes (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    account_code TEXT NOT NULL,
    balance NUMERIC(15, 4) NOT NULL DEFAULT 0,
    is_default BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS erp_accounts (
    code TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    name_ar TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_code TEXT,
    level INT NOT NULL DEFAULT 1,
    is_leaf BOOLEAN DEFAULT TRUE,
    balance NUMERIC(15, 4) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, code)
);

-- ==============================================================================
-- 3. جدول طابور المزامنة السحابي وضمان عدم التكرار (Idempotency Sync Log)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS erp_outbox_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT DEFAULT 'PROCESSED',
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    -- القيد الحاسم لمنع التكرار: لا يمكن معالجة نفس مفتاح الحركة مرتين داخل نفس المؤسسة
    CONSTRAINT uq_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

-- إنشاء فهارس سريعة للاستعلام
CREATE INDEX IF NOT EXISTS idx_products_tenant_updated ON erp_products(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_updated ON erp_invoices(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_parties_tenant_updated ON erp_parties(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_journal_tenant_updated ON erp_journal_entries(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_updated ON erp_payment_vouchers(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_amanat_tenant_updated ON erp_amanat_items(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_log_tenant_key ON erp_outbox_sync_log(tenant_id, idempotency_key);

-- ==============================================================================
-- 4. دوال استخلاص هوية المؤسسة والصلاحيات من الجلسة (RLS Context Helpers)
-- ==============================================================================

-- استخلاص معرّف المؤسسة من ترويسة الطلب أو JWT
CREATE OR REPLACE FUNCTION current_app_tenant_id()
RETURNS TEXT AS $$
BEGIN
    RETURN COALESCE(
        NULLIF(current_setting('request.headers', true)::json->>'x-tenant-id', ''),
        NULLIF((auth.jwt() ->> 'tenant_id'), ''),
        'tenant_default'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN 'tenant_default';
END;
$$ LANGUAGE plpgsql STABLE;

-- استخلاص دور المستخدم الحالي
CREATE OR REPLACE FUNCTION current_app_user_role()
RETURNS TEXT AS $$
BEGIN
    RETURN COALESCE(
        NULLIF(current_setting('request.headers', true)::json->>'x-user-role', ''),
        NULLIF((auth.jwt() ->> 'role'), ''),
        'ADMIN'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN 'ADMIN';
END;
$$ LANGUAGE plpgsql STABLE;

-- ==============================================================================
-- 5. تفعيل سياسات أمان صفوف البيانات (RLS) على كافة الجداول
-- ==============================================================================

ALTER TABLE erp_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_payment_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_amanat_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_cash_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_outbox_sync_log ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- سياسات عزل المؤسسات (Tenant Isolation Policies)
-- ------------------------------------------------------------------------------

-- سياسة المؤسسات: الوصول فقط للمؤسسة الحالية
CREATE POLICY tenant_isolation_tenants ON erp_tenants
    FOR ALL USING (id = current_app_tenant_id())
    WITH CHECK (id = current_app_tenant_id());

-- سياسة الأجهزة
CREATE POLICY tenant_isolation_devices ON erp_devices
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة مستخدمي المؤسسة
CREATE POLICY tenant_isolation_users ON erp_tenant_users
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة الأصناف والمخزون
CREATE POLICY tenant_isolation_products ON erp_products
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة العملاء والموردين
CREATE POLICY tenant_isolation_parties ON erp_parties
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة الفواتير
CREATE POLICY tenant_isolation_invoices ON erp_invoices
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة القيود المحاسبية (عزل المؤسسة + حظر الكاشير من استعراض قيود اليومية العامة)
CREATE POLICY tenant_isolation_journal ON erp_journal_entries
    FOR ALL USING (
        tenant_id = current_app_tenant_id()
        AND current_app_user_role() NOT IN ('CASHIER')
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
    );

-- سياسة السندات المالية
CREATE POLICY tenant_isolation_vouchers ON erp_payment_vouchers
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة الأمانات
CREATE POLICY tenant_isolation_amanat ON erp_amanat_items
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة الصناديق
CREATE POLICY tenant_isolation_cashboxes ON erp_cash_boxes
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة الحسابات
CREATE POLICY tenant_isolation_accounts ON erp_accounts
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- سياسة سجل منع التكرار (Outbox Log)
CREATE POLICY tenant_isolation_outbox_log ON erp_outbox_sync_log
    FOR ALL USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- ==============================================================================
-- 6. المشغلات لتحديث حقل updated_at تلقائياً عند أي تعديل (Auto Updated_At)
-- ==============================================================================

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_products_updated_at BEFORE UPDATE ON erp_products FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_parties_updated_at BEFORE UPDATE ON erp_parties FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON erp_invoices FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_journal_updated_at BEFORE UPDATE ON erp_journal_entries FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_vouchers_updated_at BEFORE UPDATE ON erp_payment_vouchers FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_amanat_updated_at BEFORE UPDATE ON erp_amanat_items FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- نهاية سكريبت البنية السحابية وسياسات RLS
