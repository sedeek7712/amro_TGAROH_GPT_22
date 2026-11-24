-- ==============================================================================
-- نظام الإدارة التجارية والمحاسبية المتكامل (multi_activity_erp)
-- المخطط السحابي الموحد وسياسات أمان صفوف الجداول (PostgreSQL / Supabase RLS)
-- المرجع الوحيد للحقيقة (Single Source of Truth) - يعالج SEC-03, SEC-04, SEC-05, DB-04, CFG-01
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. جداول المؤسسات والفروع والأجهزة والمستخدمين
-- ==============================================================================

CREATE TABLE IF NOT EXISTS erp_tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    currency TEXT NOT NULL DEFAULT 'SAR',
    tax_number TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS erp_branches (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    is_main BOOLEAN DEFAULT FALSE,
    address TEXT,
    phone TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, code)
);

-- SEC-05: ربط branch_id بمفتاح أجنبي مركب مع جدول الفروع داخل نفس المؤسسة (tenant_id, branch_id)
CREATE TABLE IF NOT EXISTS erp_devices (
    device_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    device_type TEXT DEFAULT 'WEB',
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_pull_at TIMESTAMPTZ,
    last_push_at TIMESTAMPTZ,
    sequence_number BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (tenant_id, device_id),
    CONSTRAINT fk_devices_tenant_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    user_id UUID,
    username TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'ACCOUNTANT', 'CASHIER', 'INVENTORY_KEEPER')),
    allowed_branches JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tenant_id, username),
    CONSTRAINT fk_tenant_users_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

-- ==============================================================================
-- 2. جداول الحسابات والصناديق والأعمال والمخزون
-- ==============================================================================

CREATE TABLE IF NOT EXISTS erp_accounts (
    code TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    name_ar TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    parent_code TEXT,
    level INT NOT NULL DEFAULT 1,
    is_leaf BOOLEAN DEFAULT TRUE,
    cost_center_id TEXT,
    balance NUMERIC(15, 4) NOT NULL DEFAULT 0,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS erp_cash_boxes (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    account_code TEXT NOT NULL,
    balance NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, code),
    CONSTRAINT fk_cash_boxes_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_products (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    category TEXT,
    unit TEXT DEFAULT 'حبه',
    cost_price NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    selling_price NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
    stock_quantity NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    min_limit NUMERIC(15, 4) DEFAULT 0,
    barcode TEXT,
    oem_number TEXT,
    batch_number TEXT,
    expiry_date DATE,
    batches_data JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS erp_product_images (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    thumbnail_storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp','image/jpeg','image/png')),
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    thumbnail_size_bytes BIGINT NOT NULL CHECK (thumbnail_size_bytes BETWEEN 1 AND 1048576),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
    checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, storage_key),
    UNIQUE (tenant_id, thumbnail_storage_key),
    CONSTRAINT fk_product_images_product FOREIGN KEY (tenant_id, product_id)
        REFERENCES erp_products(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_images_tenant_product
    ON erp_product_images(tenant_id, product_id, is_deleted, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_images_tenant_updated
    ON erp_product_images(tenant_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_images_single_primary
    ON erp_product_images(tenant_id, product_id)
    WHERE is_primary = TRUE AND is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS erp_parties (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('CUSTOMER', 'SUPPLIER')),
    name_ar TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    tax_number TEXT,
    balance NUMERIC(15, 4) NOT NULL DEFAULT 0,
    advance_balance NUMERIC(15, 4) NOT NULL DEFAULT 0,
    credit_limit NUMERIC(15, 4) DEFAULT 0,
    notes TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS erp_invoices (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    terminal_id TEXT,
    invoice_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('SALE', 'PURCHASE', 'RETURN_SALE', 'RETURN_PURCHASE')),
    activity_id TEXT NOT NULL,
    party_id TEXT,
    party_name TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    due_date TEXT,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    discount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    tax NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    total NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (total >= 0),
    paid_amount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    returned_amount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (returned_amount >= 0),
    advance_applied_amount NUMERIC(15, 4) NOT NULL DEFAULT 0 CHECK (advance_applied_amount >= 0),
    payment_method TEXT NOT NULL,
    cash_box_id TEXT,
    journal_entry_id TEXT,
    status TEXT NOT NULL DEFAULT 'POSTED',
    is_posted BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, invoice_number),
    CONSTRAINT fk_invoices_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_journal_entries (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    entry_number TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
    cost_center_id TEXT,
    reference_type TEXT,
    reference_id TEXT,
    reversed_entry_id TEXT,
    reversal_reason TEXT,
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_debit NUMERIC(15, 4) NOT NULL DEFAULT 0,
    total_credit NUMERIC(15, 4) NOT NULL DEFAULT 0,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, entry_number),
    CONSTRAINT fk_journal_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_journal_balanced CHECK (ABS(total_debit - total_credit) <= 0.01)
);

CREATE TABLE IF NOT EXISTS erp_payment_vouchers (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    voucher_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('RECEIPT', 'PAYMENT')),
    date TIMESTAMPTZ NOT NULL,
    amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
    cash_box_id TEXT NOT NULL,
    party_id TEXT,
    party_name TEXT NOT NULL,
    account_code TEXT NOT NULL,
    description TEXT NOT NULL,
    cost_center_id TEXT NOT NULL,
    journal_entry_id TEXT,
    status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED')),
    applied_to_debt_amount NUMERIC(15, 4) NOT NULL DEFAULT 0,
    advance_amount NUMERIC(15, 4) NOT NULL DEFAULT 0,
    manual_override BOOLEAN DEFAULT FALSE,
    override_reason TEXT,
    manual_allocations JSONB,
    allocations JSONB,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, voucher_number),
    CONSTRAINT fk_vouchers_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_payment_allocations (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    voucher_id TEXT,
    advance_transaction_id TEXT,
    party_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    invoice_number TEXT,
    invoice_date TEXT,
    allocated_amount NUMERIC(15, 4) NOT NULL CHECK (allocated_amount > 0),
    allocation_method TEXT NOT NULL CHECK (allocation_method IN ('FIFO', 'MANUAL', 'ADVANCE_SETTLEMENT')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_allocations_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_allocations_party FOREIGN KEY (tenant_id, party_id)
        REFERENCES erp_parties(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_allocations_invoice FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES erp_invoices(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_party_advances (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    party_id TEXT NOT NULL,
    party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
    tx_type TEXT NOT NULL CHECK (tx_type IN ('OVERPAYMENT_DEPOSIT', 'PREPAYMENT_DEPOSIT', 'APPLY_TO_INVOICE', 'REFUND', 'REVERSAL')),
    amount NUMERIC(15, 4) NOT NULL,
    balance_after NUMERIC(15, 4) NOT NULL CHECK (balance_after >= 0),
    voucher_id TEXT,
    invoice_id TEXT,
    journal_entry_id TEXT,
    tx_date TIMESTAMPTZ NOT NULL,
    description TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_party_advances_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_party_advances_party FOREIGN KEY (tenant_id, party_id)
        REFERENCES erp_parties(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_allocation_audits (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    voucher_id TEXT NOT NULL,
    party_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_allocations JSONB NOT NULL DEFAULT '[]'::jsonb,
    new_allocations JSONB NOT NULL DEFAULT '[]'::jsonb,
    audit_timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_allocation_audits_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS erp_amanat_items (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL,
    record_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('CASH', 'ITEM', 'IN_KIND')),
    depositor_name TEXT NOT NULL,
    depositor_phone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('HELD', 'ACTIVE', 'RETURNED', 'CANCELLED')),
    received_date TIMESTAMPTZ NOT NULL,
    expected_return_date TIMESTAMPTZ,
    returned_date TIMESTAMPTZ,
    amount NUMERIC(15, 4) DEFAULT 0 CHECK (amount >= 0),
    currency TEXT NOT NULL DEFAULT 'SAR',
    cash_box_id TEXT,
    item_description TEXT,
    serial_number TEXT,
    received_by TEXT NOT NULL,
    recipient_signature_name TEXT,
    notes TEXT,
    journal_entry_id TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, record_number),
    CONSTRAINT fk_amanat_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES erp_branches(tenant_id, id) ON DELETE RESTRICT
);

-- ==============================================================================
-- 3. جدول طابور المزامنة وضمان عدم التكرار الذري (Idempotency Sync Log)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS erp_outbox_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL REFERENCES erp_tenants(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
    status TEXT DEFAULT 'PROCESSED',
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_products_tenant_updated ON erp_products(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_parties_tenant_updated ON erp_parties(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_updated ON erp_invoices(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_journal_tenant_updated ON erp_journal_entries(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_updated ON erp_payment_vouchers(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_amanat_tenant_updated ON erp_amanat_items(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_updated ON erp_accounts(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cash_boxes_tenant_updated ON erp_cash_boxes(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_tenant_updated ON erp_payment_allocations(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_tenant_voucher ON erp_payment_allocations(tenant_id, voucher_id);
CREATE INDEX IF NOT EXISTS idx_party_advances_tenant_updated ON erp_party_advances(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_party_advances_tenant_party ON erp_party_advances(tenant_id, party_id);
CREATE INDEX IF NOT EXISTS idx_allocation_audits_tenant_updated ON erp_allocation_audits(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_allocation_audits_tenant_voucher ON erp_allocation_audits(tenant_id, voucher_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_tenant_key ON erp_outbox_sync_log(tenant_id, idempotency_key);

-- ==============================================================================
-- 4. دوال استخلاص الهوية الصارمة من JWT الموقع فقط (DENY BY DEFAULT - SEC-03 & SEC-04)
--    يُحظر تماماً قراءة الترويسات غير الموقعة (request.headers) أو إرجاع قيم افتراضية مثل ADMIN/tenant_default
-- ==============================================================================

CREATE OR REPLACE FUNCTION current_app_tenant_id()
RETURNS TEXT AS $$
DECLARE
    v_claims JSONB;
    v_tenant_id TEXT;
BEGIN
    v_claims := auth.jwt();
    IF v_claims IS NULL THEN
        RETURN NULL;
    END IF;
    v_tenant_id := NULLIF(COALESCE(v_claims ->> 'tenant_id', v_claims -> 'app_metadata' ->> 'tenant_id'), '');
    RETURN v_tenant_id;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_app_user_role()
RETURNS TEXT AS $$
DECLARE
    v_claims JSONB;
    v_role TEXT;
BEGIN
    v_claims := auth.jwt();
    IF v_claims IS NULL THEN
        RETURN 'DENIED';
    END IF;
    v_role := NULLIF(COALESCE(v_claims ->> 'erp_role', v_claims -> 'app_metadata' ->> 'role', v_claims ->> 'role'), '');
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
    v_claims JSONB;
    v_branch_id TEXT;
BEGIN
    v_claims := auth.jwt();
    IF v_claims IS NULL THEN
        RETURN NULL;
    END IF;
    v_branch_id := NULLIF(COALESCE(v_claims ->> 'branch_id', v_claims -> 'app_metadata' ->> 'branch_id'), '');
    RETURN v_branch_id;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- التحقق من عضوية المستخدم الفعلي داخل المؤسسة والفرع
CREATE OR REPLACE FUNCTION has_verified_tenant_branch_access(p_tenant_id TEXT, p_branch_id TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    IF current_app_tenant_id() IS NULL OR p_tenant_id IS DISTINCT FROM current_app_tenant_id() THEN
        RETURN FALSE;
    END IF;
    IF current_app_user_role() = 'DENIED' THEN
        RETURN FALSE;
    END IF;
    IF current_app_user_role() IN ('ADMIN', 'ACCOUNTANT') THEN
        RETURN TRUE;
    END IF;
    -- الكاشير وأمين المستودع يجب أن يملكا معرف فرع صريح ومطابق
    IF current_app_branch_id() IS NULL OR p_branch_id IS DISTINCT FROM current_app_branch_id() THEN
        RETURN FALSE;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==============================================================================
-- 5. تفعيل Row-Level Security (RLS) على كافة الجداول الـ 16
-- ==============================================================================

ALTER TABLE erp_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_cash_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_payment_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_party_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_allocation_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_amanat_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_outbox_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tenants ON erp_tenants
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND id = current_app_tenant_id() AND current_app_user_role() != 'DENIED')
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND id = current_app_tenant_id() AND current_app_user_role() = 'ADMIN');

CREATE POLICY tenant_isolation_branches ON erp_branches
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() != 'DENIED')
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() = 'ADMIN');

CREATE POLICY tenant_isolation_devices ON erp_devices
    FOR ALL USING (has_verified_tenant_branch_access(tenant_id, branch_id))
    WITH CHECK (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER'));

CREATE POLICY tenant_isolation_users ON erp_tenant_users
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() = 'ADMIN');

CREATE POLICY tenant_isolation_accounts ON erp_accounts
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

CREATE POLICY tenant_isolation_cashboxes ON erp_cash_boxes
    FOR SELECT USING (
        current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND (
            current_app_user_role() IN ('ADMIN', 'ACCOUNTANT') OR
            (current_app_user_role() = 'CASHIER' AND current_app_branch_id() IS NOT NULL AND branch_id = current_app_branch_id())
        )
    );
CREATE POLICY tenant_isolation_cashboxes_write ON erp_cash_boxes
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

CREATE POLICY tenant_isolation_products ON erp_products
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() != 'DENIED')
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'INVENTORY_KEEPER'));

CREATE POLICY tenant_isolation_product_images ON erp_product_images
    FOR ALL USING (
        current_app_tenant_id() IS NOT NULL
        AND tenant_id = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = erp_product_images.tenant_id
              AND product.id = erp_product_images.product_id
              AND product.activity_id = erp_product_images.activity_id
        )
        AND current_app_user_role() != 'DENIED'
    )
    WITH CHECK (
        current_app_tenant_id() IS NOT NULL
        AND tenant_id = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = erp_product_images.tenant_id
              AND product.id = erp_product_images.product_id
              AND product.activity_id = erp_product_images.activity_id
        )
        AND current_app_user_role() IN ('ADMIN','ACCOUNTANT','INVENTORY_KEEPER')
    );

CREATE POLICY tenant_isolation_parties ON erp_parties
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

-- SEC-04: غياب current_app_branch_id() يرفض الوصول للكاشير تماماً بدلاً من فتح جميع الفروع
CREATE POLICY tenant_isolation_invoices ON erp_invoices
    FOR ALL USING (
        current_app_tenant_id() IS NOT NULL
        AND tenant_id = current_app_tenant_id()
        AND (
            current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
            OR (current_app_user_role() = 'CASHIER' AND current_app_branch_id() IS NOT NULL AND branch_id = current_app_branch_id())
        )
    )
    WITH CHECK (
        current_app_tenant_id() IS NOT NULL
        AND tenant_id = current_app_tenant_id()
        AND (
            current_app_user_role() IN ('ADMIN', 'ACCOUNTANT')
            OR (current_app_user_role() = 'CASHIER' AND current_app_branch_id() IS NOT NULL AND branch_id = current_app_branch_id())
        )
    );

CREATE POLICY tenant_isolation_journal ON erp_journal_entries
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

CREATE POLICY tenant_isolation_vouchers ON erp_payment_vouchers
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

CREATE POLICY tenant_isolation_payment_allocations ON erp_payment_allocations
    FOR ALL USING (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER'))
    WITH CHECK (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER'));

CREATE POLICY tenant_isolation_party_advances ON erp_party_advances
    FOR ALL USING (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER'))
    WITH CHECK (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT', 'CASHIER'));

CREATE POLICY tenant_isolation_allocation_audits ON erp_allocation_audits
    FOR ALL USING (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (has_verified_tenant_branch_access(tenant_id, branch_id) AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

CREATE POLICY tenant_isolation_amanat ON erp_amanat_items
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'))
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() IN ('ADMIN', 'ACCOUNTANT'));

CREATE POLICY tenant_isolation_outbox_log ON erp_outbox_sync_log
    FOR ALL USING (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() != 'DENIED')
    WITH CHECK (current_app_tenant_id() IS NOT NULL AND tenant_id = current_app_tenant_id() AND current_app_user_role() != 'DENIED');

-- ==============================================================================
-- 6. مشغلات تحديث updated_at تلقائياً ودالة المزامنة الذرية (Idempotent RPC)
-- ==============================================================================

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_branches_updated_at BEFORE UPDATE ON erp_branches FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON erp_accounts FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_cash_boxes_updated_at BEFORE UPDATE ON erp_cash_boxes FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_products_updated_at BEFORE UPDATE ON erp_products FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_product_images_updated_at BEFORE UPDATE ON erp_product_images FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_parties_updated_at BEFORE UPDATE ON erp_parties FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON erp_invoices FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_journal_updated_at BEFORE UPDATE ON erp_journal_entries FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_vouchers_updated_at BEFORE UPDATE ON erp_payment_vouchers FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_payment_allocations_updated_at BEFORE UPDATE ON erp_payment_allocations FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_party_advances_updated_at BEFORE UPDATE ON erp_party_advances FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_allocation_audits_updated_at BEFORE UPDATE ON erp_allocation_audits FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
CREATE OR REPLACE TRIGGER trg_amanat_updated_at BEFORE UPDATE ON erp_amanat_items FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- Product binaries live in private Storage, never in PostgreSQL rows or invoice payloads.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('erp-product-media', 'erp-product-media', FALSE, 10485760, ARRAY['image/webp','image/jpeg','image/png'])
ON CONFLICT (id) DO UPDATE SET
    public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS product_media_tenant_read ON storage.objects;
DROP POLICY IF EXISTS product_media_tenant_insert ON storage.objects;
DROP POLICY IF EXISTS product_media_tenant_update ON storage.objects;
DROP POLICY IF EXISTS product_media_tenant_delete ON storage.objects;

CREATE POLICY product_media_tenant_read ON storage.objects
    FOR SELECT USING (
        bucket_id = 'erp-product-media'
        AND (storage.foldername(name))[1] = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = current_app_tenant_id()
              AND product.activity_id = (storage.foldername(name))[2]
              AND product.id = (storage.foldername(name))[3]
        )
        AND current_app_user_role() != 'DENIED'
    );
CREATE POLICY product_media_tenant_insert ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'erp-product-media'
        AND (storage.foldername(name))[1] = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = current_app_tenant_id()
              AND product.activity_id = (storage.foldername(name))[2]
              AND product.id = (storage.foldername(name))[3]
        )
        AND current_app_user_role() IN ('ADMIN','ACCOUNTANT','INVENTORY_KEEPER')
    );
CREATE POLICY product_media_tenant_update ON storage.objects
    FOR UPDATE USING (
        bucket_id = 'erp-product-media'
        AND (storage.foldername(name))[1] = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = current_app_tenant_id()
              AND product.activity_id = (storage.foldername(name))[2]
              AND product.id = (storage.foldername(name))[3]
        )
        AND current_app_user_role() IN ('ADMIN','ACCOUNTANT','INVENTORY_KEEPER')
    ) WITH CHECK (
        bucket_id = 'erp-product-media'
        AND (storage.foldername(name))[1] = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = current_app_tenant_id()
              AND product.activity_id = (storage.foldername(name))[2]
              AND product.id = (storage.foldername(name))[3]
        )
        AND current_app_user_role() IN ('ADMIN','ACCOUNTANT','INVENTORY_KEEPER')
    );
CREATE POLICY product_media_tenant_delete ON storage.objects
    FOR DELETE USING (
        bucket_id = 'erp-product-media'
        AND (storage.foldername(name))[1] = current_app_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.erp_products AS product
            WHERE product.tenant_id = current_app_tenant_id()
              AND product.activity_id = (storage.foldername(name))[2]
              AND product.id = (storage.foldername(name))[3]
        )
        AND current_app_user_role() IN ('ADMIN','ACCOUNTANT','INVENTORY_KEEPER')
    );

-- SYNC-01: تنفيذ الحركة المالية/المخزنية وتسجيل مفتاح عدم التكرار في معاملة واحدة لا تقبل التجزئة
CREATE OR REPLACE FUNCTION apply_outbox_mutation(
    p_tenant_id TEXT,
    p_device_id TEXT,
    p_idempotency_key TEXT,
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_action TEXT,
    p_payload JSONB
)
RETURNS JSONB AS $$
DECLARE
    v_jwt_tenant TEXT;
    v_role TEXT;
    v_inserted UUID;
BEGIN
    v_jwt_tenant := current_app_tenant_id();
    v_role := current_app_user_role();

    IF v_jwt_tenant IS NULL OR v_jwt_tenant IS DISTINCT FROM p_tenant_id OR v_role = 'DENIED' THEN
        RAISE EXCEPTION 'Unauthorized tenant or role context for outbox mutation' USING ERRCODE = '42501';
    END IF;

    INSERT INTO erp_outbox_sync_log (tenant_id, device_id, idempotency_key, entity_type, entity_id, action, status)
    VALUES (p_tenant_id, p_device_id, p_idempotency_key, p_entity_type, p_entity_id, p_action, 'PROCESSED')
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object(
            'accepted', TRUE,
            'duplicate', TRUE,
            'idempotency_key', p_idempotency_key,
            'processed_at', NOW()
        );
    END IF;

    IF p_action = 'DELETE' THEN
        IF p_entity_type = 'PRODUCT' THEN
            UPDATE erp_products SET is_deleted = TRUE, is_active = FALSE WHERE tenant_id = p_tenant_id AND id = p_entity_id;
        ELSIF p_entity_type = 'PARTY' THEN
            UPDATE erp_parties SET is_deleted = TRUE WHERE tenant_id = p_tenant_id AND id = p_entity_id;
        ELSIF p_entity_type = 'BRANCH' THEN
            UPDATE erp_branches SET is_deleted = TRUE, is_active = FALSE WHERE tenant_id = p_tenant_id AND id = p_entity_id;
        ELSIF p_entity_type = 'CASHBOX' THEN
            UPDATE erp_cash_boxes SET is_deleted = TRUE, is_active = FALSE WHERE tenant_id = p_tenant_id AND id = p_entity_id;
        ELSIF p_entity_type = 'ACCOUNT' THEN
            UPDATE erp_accounts SET is_deleted = TRUE WHERE tenant_id = p_tenant_id AND code = p_entity_id;
        ELSE
            RAISE EXCEPTION 'Hard/soft delete is prohibited for posted financial entity %', p_entity_type;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'accepted', TRUE,
        'duplicate', FALSE,
        'idempotency_key', p_idempotency_key,
        'log_id', v_inserted,
        'processed_at', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
