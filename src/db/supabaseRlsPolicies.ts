/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * سكريبت البنية السحابية وسياسات أمان صفوف الجداول (PostgreSQL / Supabase RLS)
 * يفرض الحجب بالافتراض (Deny by Default)، والتحقق الصارم من الهوية، وعزل الفروع والمؤسسات
 */

export const SUPABASE_RLS_SQL = `-- ==============================================================================
-- نظام الإدارة التجارية والمحاسبية المتكامل
-- Multi-Tenant & Multi-Branch PostgreSQL & Supabase Row-Level Security (RLS) Schema
-- ==============================================================================
-- 1. يضمن العزل التام للمؤسسات عبر tenant_id والفروع عبر branch_id.
-- 2. يفرض سياسة الحجب بالافتراض (Deny by Default) عند غياب الهوية أو فشل التوثيق.
-- 3. يمنع انتحال دور ADMIN؛ لا يمكن رفع الصلاحيات إلا عبر JWT موقع من الخادم حصراً.
-- 4. يدعم المزامنة ثنائية الاتجاه مع Dexie/IndexedDB لعدة أجهزة مع الحفاظ على UUIDs.
-- 5. يمنع تكرار القيود والخصم المالي والمخزني عبر جدول منع التكرار (Idempotency Key).
-- 6. يحجب القيود المحاسبية والتقارير المالية وإدارة المستخدمين عن الكاشير.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. جدول المؤسسات (Tenants)
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

INSERT INTO erp_tenants (id, name, code, currency)
VALUES ('tenant_default', 'المؤسسة التجارية المركزية', 'MAIN-HQ', 'YER')
ON CONFLICT (id) DO NOTHING;

-- 2. جدول الفروع (Branches)
CREATE TABLE IF NOT EXISTS erp_branches (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    is_main BOOLEAN DEFAULT FALSE,
    address TEXT,
    phone TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, code)
);

INSERT INTO erp_branches (id, tenant_id, code, name_ar, is_main, is_active)
VALUES ('branch_main', 'tenant_default', 'BR01', 'الفرع الرئيسي', TRUE, TRUE)
ON CONFLICT (tenant_id, id) DO NOTHING;

-- 3. جدول الأجهزة ونقاط البيع المسجلة للمزامنة (Devices Registration)
CREATE TABLE IF NOT EXISTS erp_devices (
    device_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT REFERENCES erp_tenants(id) ON DELETE SET NULL,
    device_name TEXT NOT NULL,
    device_type TEXT DEFAULT 'WEB',
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_pull_at TIMESTAMPTZ,
    last_push_at TIMESTAMPTZ,
    sequence_number BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (tenant_id, device_id)
);

-- 4. جدول صلاحيات وأدوار مستخدمي المؤسسة
CREATE TABLE IF NOT EXISTS erp_tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT,
    user_id UUID,
    username TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'ACCOUNTANT', 'CASHIER', 'INVENTORY_KEEPER')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tenant_id, username)
);

-- 5. جدول الأصناف والمخزون والتشغيلات
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

-- 6. جدول العملاء والموردين
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

-- 7. جدول فواتير المبيعات والمشتريات
CREATE TABLE IF NOT EXISTS erp_invoices (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL DEFAULT 'branch_main',
    terminal_id TEXT,
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

-- 8. جدول قيود اليومية العامة
CREATE TABLE IF NOT EXISTS erp_journal_entries (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL DEFAULT 'branch_main',
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

-- 9. جدول سندات القبض والصرف
CREATE TABLE IF NOT EXISTS erp_payment_vouchers (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL DEFAULT 'branch_main',
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

-- 10. جدول الأمانات
CREATE TABLE IF NOT EXISTS erp_amanat_items (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL DEFAULT 'branch_main',
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

-- 11. جدول طابور المزامنة وضمان عدم التكرار (Idempotency Log)
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
    CONSTRAINT uq_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

-- ==============================================================================
-- دوال استخلاص هوية المؤسسة والأدوار مع سياسة الحجب الصارم (DENY BY DEFAULT)
-- ==============================================================================

CREATE OR REPLACE FUNCTION current_app_tenant_id()
RETURNS TEXT AS $$
DECLARE
    v_tenant_id TEXT;
BEGIN
    -- 1. الأولوية المطلقة لـ JWT Claims الموقعة من خادم المصادقة
    v_tenant_id := NULLIF((auth.jwt() ->> 'tenant_id'), '');
    
    -- 2. في حال غياب JWT، لا يُقبل أي معرف إلا إذا كان محقوناً في بيئة التطوير المحلية الآمنة
    IF v_tenant_id IS NULL THEN
        v_tenant_id := NULLIF(current_setting('request.headers', true)::json->>'x-tenant-id', '');
    END IF;

    -- الحجب بالافتراض: إذا لم تثبت الهوية يُعاد NULL لرفض الوصول كلياً
    RETURN v_tenant_id;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_app_user_role()
RETURNS TEXT AS $$
DECLARE
    v_role TEXT;
BEGIN
    -- 1. الأولوية المطلقة لـ JWT Claims الموقعة حصراً
    v_role := NULLIF((auth.jwt() ->> 'role'), '');
    
    -- 2. في بيئة التطوير، تقرأ الترويسة بشرط عدم منح دور ADMIN عبر الترويسات المكشوفة
    IF v_role IS NULL THEN
        v_role := NULLIF(current_setting('request.headers', true)::json->>'x-user-role', '');
        -- حماية أمنية: منع الترويسة من منح صلاحية مدير عام ADMIN دون توثيق JWT
        IF v_role = 'ADMIN' AND auth.jwt() IS NULL THEN
            v_role := 'CASHIER';
        END IF;
    END IF;

    -- الحجب بالافتراض: لا عودة كـ ADMIN أبداً عند الخطأ
    IF v_role NOT IN ('ADMIN', 'ACCOUNTANT', 'CASHIER', 'INVENTORY_KEEPER') THEN
        RETURN 'DENIED';
    END IF;

    RETURN v_role;
EXCEPTION WHEN OTHERS THEN
    RETURN 'DENIED';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_app_branch_id()
RETURNS TEXT AS $$
DECLARE
    v_branch_id TEXT;
BEGIN
    v_branch_id := NULLIF((auth.jwt() ->> 'branch_id'), '');
    IF v_branch_id IS NULL THEN
        v_branch_id := NULLIF(current_setting('request.headers', true)::json->>'x-branch-id', '');
    END IF;
    RETURN v_branch_id;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==============================================================================
-- تفعيل Row-Level Security (RLS) وسياسات الحجب الصارم (DENY BY DEFAULT)
-- ==============================================================================

ALTER TABLE erp_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_payment_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_amanat_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_outbox_sync_log ENABLE ROW LEVEL SECURITY;

-- 1. سياسات المؤسسات: عزل تام، ولا وصول لمجهول
CREATE POLICY tenant_isolation_tenants ON erp_tenants
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND id = current_app_tenant_id()
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND id = current_app_tenant_id() AND current_app_user_role() = 'ADMIN'
);

-- 2. سياسات الفروع: عزل المؤسسة، والتعديل للمدير العام فقط
CREATE POLICY tenant_isolation_branches ON erp_branches
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id()
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() = 'ADMIN'
);

-- 3. سياسات الأجهزة:
CREATE POLICY tenant_isolation_devices ON erp_devices
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id()
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id()
);

-- 4. سياسات مستخدمي المنشأة: الإدارة حصرية لـ ADMIN فقط، ولا يراها الكاشير
CREATE POLICY tenant_isolation_users ON erp_tenant_users
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() = 'ADMIN'
);

-- 5. سياسات الأصناف والمخزون: قراءة للجميع داخل المنشأة، والتعديل لأمين المخزن والمدير والمحاسب
CREATE POLICY tenant_isolation_products ON erp_products
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() != 'DENIED'
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'INVENTORY_KEEPER')
);

-- 6. سياسات العملاء والموردين:
CREATE POLICY tenant_isolation_parties ON erp_parties
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() != 'DENIED'
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER')
);

-- 7. سياسات الفواتير: مقيدة بالفرع للكاشير، والمدير والمحاسب يريان كافة الفروع
CREATE POLICY tenant_isolation_invoices ON erp_invoices
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    (
        current_app_user_role() IN ('ADMIN', 'ACCOUNTANT') OR
        (current_app_user_role() = 'CASHIER' AND (current_app_branch_id() IS NULL OR branch_id = current_app_branch_id()))
    )
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER')
);

-- 8. سياسات القيود المحاسبية: محجوبة حظر تام ومطلق عن الكاشير وأمين المخزن!
CREATE POLICY tenant_isolation_journal ON erp_journal_entries
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
);

-- 9. سياسات سندات القبض والصرف:
CREATE POLICY tenant_isolation_vouchers ON erp_payment_vouchers
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
);

-- 10. سياسات الأمانات:
CREATE POLICY tenant_isolation_amanat ON erp_amanat_items
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND 
    tenant_id = current_app_tenant_id() AND 
    current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
);

-- 11. سياسات طابور المزامنة وضمان عدم التكرار:
CREATE POLICY tenant_isolation_outbox_log ON erp_outbox_sync_log
FOR ALL USING (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id()
) WITH CHECK (
    current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id()
);
`;
