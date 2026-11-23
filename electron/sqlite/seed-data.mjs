export const OFFICIAL_ACTIVITIES = [
  {
    id: 'pharmacy',
    nameAr: 'الصيدلية',
    code: 'PHARM',
    descriptionAr: 'الأدوية والمستلزمات الطبية وتتبع الصلاحيات والتشغيلات بنظام FEFO',
    costCenterCode: 'CC-101',
    color: 'emerald',
    icon: 'Pill',
    isInventoryManaged: true,
  },
  {
    id: 'grocery',
    nameAr: 'المواد الغذائية والبقالة',
    code: 'GROC',
    descriptionAr: 'المواد الاستهلاكية والأغذية والباركود وتتبع الصلاحية بحسب طبيعة الصنف',
    costCenterCode: 'CC-102',
    color: 'amber',
    icon: 'ShoppingBag',
    isInventoryManaged: true,
  },
  {
    id: 'bike_parts',
    nameAr: 'قطع غيار الدراجات النارية',
    code: 'BIKE',
    descriptionAr: 'قطع الغيار والزيوت والإكسسوارات برقم القطعة OEM والموديلات المتوافقة',
    costCenterCode: 'CC-103',
    color: 'blue',
    icon: 'Bike',
    isInventoryManaged: true,
  },
  {
    id: 'equipment_parts',
    nameAr: 'قطع غيار المعدات',
    code: 'EQUIP',
    descriptionAr: 'قطع المعدات الميكانيكية والزراعية مع خصائص القطعة والرقم التسلسلي عند الحاجة',
    costCenterCode: 'CC-104',
    color: 'indigo',
    icon: 'Wrench',
    isInventoryManaged: true,
  },
];

export const INITIAL_CHART_OF_ACCOUNTS = [
  { code: '1', nameAr: 'الأصول', type: 'ASSET', parentCode: null, isLeaf: false, balance: 0 },
  { code: '11', nameAr: 'الأصول المتداولة', type: 'ASSET', parentCode: '1', isLeaf: false, balance: 0 },
  { code: '1101', nameAr: 'الصندوق الرئيسي (الخزينة)', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 0 },
  { code: '1102', nameAr: 'الحسابات البنكية', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 0 },
  { code: '1103', nameAr: 'العملاء والمدينون', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 0 },
  { code: '1104', nameAr: 'المخزون السلعي التجاري المملوك', type: 'ASSET', parentCode: '11', isLeaf: false, balance: 0 },
  { code: '11041', nameAr: 'مخزون الصيدلية', type: 'ASSET', parentCode: '1104', isLeaf: true, balance: 0, costCenterId: 'pharmacy' },
  { code: '11042', nameAr: 'مخزون المواد الغذائية والبقالة', type: 'ASSET', parentCode: '1104', isLeaf: true, balance: 0, costCenterId: 'grocery' },
  { code: '11043', nameAr: 'مخزون قطع غيار الدراجات النارية', type: 'ASSET', parentCode: '1104', isLeaf: true, balance: 0, costCenterId: 'bike_parts' },
  { code: '11044', nameAr: 'مخزون قطع غيار المعدات', type: 'ASSET', parentCode: '1104', isLeaf: true, balance: 0, costCenterId: 'equipment_parts' },
  { code: '1105', nameAr: 'سلف الموردين (دفعات مقدمة للموردين)', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 0 },
  { code: '1106', nameAr: 'ضريبة القيمة المضافة - مدخلات', type: 'ASSET', parentCode: '11', isLeaf: true, balance: 0 },
  { code: '2', nameAr: 'الخصوم', type: 'LIABILITY', parentCode: null, isLeaf: false, balance: 0 },
  { code: '21', nameAr: 'الخصوم المتداولة', type: 'LIABILITY', parentCode: '2', isLeaf: false, balance: 0 },
  { code: '2101', nameAr: 'الموردون والدائنون', type: 'LIABILITY', parentCode: '21', isLeaf: true, balance: 0 },
  { code: '2102', nameAr: 'أمانات نقدية للغير (التزام معزول)', type: 'LIABILITY', parentCode: '21', isLeaf: true, balance: 0 },
  { code: '2103', nameAr: 'دفعات مقدمة من العملاء', type: 'LIABILITY', parentCode: '21', isLeaf: true, balance: 0 },
  { code: '3', nameAr: 'حقوق الملكية', type: 'EQUITY', parentCode: null, isLeaf: false, balance: 0 },
  { code: '3101', nameAr: 'رأس المال المخصص', type: 'EQUITY', parentCode: '3', isLeaf: true, balance: 0 },
  { code: '3102', nameAr: 'الأرباح والخسائر المبقاة', type: 'EQUITY', parentCode: '3', isLeaf: true, balance: 0 },
  { code: '4', nameAr: 'الإيرادات', type: 'REVENUE', parentCode: null, isLeaf: false, balance: 0 },
  { code: '4101', nameAr: 'إيرادات مبيعات الصيدلية', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'pharmacy' },
  { code: '4102', nameAr: 'إيرادات مبيعات المواد الغذائية والبقالة', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'grocery' },
  { code: '4103', nameAr: 'إيرادات مبيعات قطع غيار الدراجات', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'bike_parts' },
  { code: '4104', nameAr: 'إيرادات مبيعات قطع غيار المعدات', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'equipment_parts' },
  { code: '42', nameAr: 'مردودات ومسموحات المبيعات', type: 'REVENUE', parentCode: '4', isLeaf: false, balance: 0 },
  { code: '4201', nameAr: 'مردودات مبيعات الصيدلية', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'pharmacy' },
  { code: '4202', nameAr: 'مردودات مبيعات المواد الغذائية والبقالة', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'grocery' },
  { code: '4203', nameAr: 'مردودات مبيعات قطع غيار الدراجات', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'bike_parts' },
  { code: '4204', nameAr: 'مردودات مبيعات قطع غيار المعدات', type: 'REVENUE', parentCode: '42', isLeaf: true, balance: 0, costCenterId: 'equipment_parts' },
  { code: '5', nameAr: 'المصروفات', type: 'EXPENSE', parentCode: null, isLeaf: false, balance: 0 },
  { code: '51', nameAr: 'تكلفة المبيعات (بضاعة مباعة)', type: 'EXPENSE', parentCode: '5', isLeaf: false, balance: 0 },
  { code: '5101', nameAr: 'تكلفة مبيعات الصيدلية', type: 'EXPENSE', parentCode: '51', isLeaf: true, balance: 0, costCenterId: 'pharmacy' },
  { code: '5102', nameAr: 'تكلفة مبيعات البقالة', type: 'EXPENSE', parentCode: '51', isLeaf: true, balance: 0, costCenterId: 'grocery' },
  { code: '5103', nameAr: 'تكلفة مبيعات قطع الدراجات', type: 'EXPENSE', parentCode: '51', isLeaf: true, balance: 0, costCenterId: 'bike_parts' },
  { code: '5104', nameAr: 'تكلفة مبيعات قطع المعدات', type: 'EXPENSE', parentCode: '51', isLeaf: true, balance: 0, costCenterId: 'equipment_parts' },
  { code: '52', nameAr: 'المصروفات التشغيلية والعمومية (الإدارة العامة)', type: 'EXPENSE', parentCode: '5', isLeaf: false, balance: 0, costCenterId: 'general' },
  { code: '5201', nameAr: 'إيجارات مقرات وأنشطة', type: 'EXPENSE', parentCode: '52', isLeaf: true, balance: 0, costCenterId: 'general' },
  { code: '5202', nameAr: 'كهرباء ومياه وهاتف', type: 'EXPENSE', parentCode: '52', isLeaf: true, balance: 0, costCenterId: 'general' },
  { code: '5203', nameAr: 'رواتب وأجور العاملين', type: 'EXPENSE', parentCode: '52', isLeaf: true, balance: 0, costCenterId: 'general' },
  { code: '5204', nameAr: 'مصاريف صيانة ونثريات', type: 'EXPENSE', parentCode: '52', isLeaf: true, balance: 0, costCenterId: 'general' },
  { code: '5205', nameAr: 'فروقات وتسويات وتلف المخزون', type: 'EXPENSE', parentCode: '52', isLeaf: true, balance: 0, costCenterId: 'general' },
];

export const INITIAL_CASH_BOXES = [
  {
    id: 'cb-1',
    code: 'CASH-MAIN',
    nameAr: 'الصندوق الرئيسي (الخزينة العامة)',
    accountCode: '1101',
    balance: 0,
    isDefault: true,
    branchId: 'branch_main',
  },
  {
    id: 'cb-2',
    code: 'BANK-01',
    nameAr: 'الحساب البنكي الأول',
    accountCode: '1102',
    balance: 0,
    isDefault: false,
    branchId: 'branch_main',
  },
];

export const DEFAULT_COMPANY_PROFILE = {
  nameAr: 'نظام الإدارة التجارية',
  currencyCode: 'SAR',
  currency: 'ريال سعودي',
  currencySymbol: 'ر.س',
  currencyDecimalPlaces: 2,
};

/**
 * Seeds canonical activities, chart of accounts, initial cash boxes, and default
 * company profile ONLY when each respective table/setting is empty.
 * NOTE: Must NOT be called on database open, so fresh DBs remain eligible for
 * legacy-backup-importer.mjs until createInitialAdmin or explicit setup completes.
 */
export function seedReferenceDataIfEmpty(database, tenantId = 'tenant_main', nowIso = new Date().toISOString()) {
  database.prepare(
    'INSERT OR IGNORE INTO tenants (id,name,code,currency,is_active,data_json) VALUES (?,?,?,?,1,?)'
  ).run(
    tenantId,
    'المنشأة الرئيسية',
    'MAIN',
    'YER',
    JSON.stringify({ id: tenantId, name: 'المنشأة الرئيسية', code: 'MAIN', currency: 'YER', isActive: true })
  );

  database.prepare(
    'INSERT OR IGNORE INTO branches (tenant_id,id,code,name_ar,is_main,active,data_json) VALUES (?,?,?,?,1,1,?)'
  ).run(
    tenantId,
    'branch_main',
    'BR01',
    'الفرع الرئيسي',
    JSON.stringify({
      id: 'branch_main',
      code: 'BR01',
      nameAr: 'الفرع الرئيسي',
      isMain: true,
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  );

  const actCount = database.prepare('SELECT COUNT(*) AS count FROM activities WHERE tenant_id = ?').get(tenantId).count;
  if (actCount === 0) {
    const stmt = database.prepare('INSERT INTO activities (tenant_id,id,code,data_json) VALUES (?,?,?,?)');
    for (const act of OFFICIAL_ACTIVITIES) {
      stmt.run(tenantId, act.id, act.code, JSON.stringify({ ...act, tenantId }));
    }
  }

  const accCount = database.prepare('SELECT COUNT(*) AS count FROM accounts WHERE tenant_id = ?').get(tenantId).count;
  if (accCount === 0) {
    const stmt = database.prepare(
      'INSERT INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
    );
    for (const acc of INITIAL_CHART_OF_ACCOUNTS) {
      stmt.run(
        tenantId,
        acc.code,
        acc.type,
        acc.parentCode ?? null,
        acc.isLeaf ? 1 : 0,
        '0.00',
        JSON.stringify({ ...acc, balance: 0, tenantId })
      );
    }
  }

  const cbCount = database.prepare('SELECT COUNT(*) AS count FROM cash_boxes WHERE tenant_id = ?').get(tenantId).count;
  if (cbCount === 0) {
    const stmt = database.prepare(
      'INSERT INTO cash_boxes (tenant_id,id,branch_id,code,account_code,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
    );
    for (const cb of INITIAL_CASH_BOXES) {
      stmt.run(
        tenantId,
        cb.id,
        cb.branchId,
        cb.code,
        cb.accountCode,
        '0.00',
        JSON.stringify({ ...cb, tenantId })
      );
    }
  }

  const profileRow = database.prepare(
    'SELECT 1 FROM app_settings WHERE tenant_id = ? AND setting_key = ?'
  ).get(tenantId, 'company_profile');
  if (!profileRow) {
    database.prepare(
      'INSERT INTO app_settings (tenant_id,setting_key,value_json,updated_at) VALUES (?,?,?,?)'
    ).run(tenantId, 'company_profile', JSON.stringify(DEFAULT_COMPANY_PROFILE), nowIso);
  }
}

export function ensureCanonicalAccounts(database, tenantId = 'tenant_main') {
  const existing = database.prepare('SELECT code FROM accounts WHERE tenant_id = ?').all(tenantId);
  if (existing.length === 0) return;
  const existingCodes = new Set(existing.map((r) => r.code));
  const stmt = database.prepare(
    'INSERT OR IGNORE INTO accounts (tenant_id,code,account_type,parent_code,is_leaf,balance_decimal,data_json) VALUES (?,?,?,?,?,?,?)'
  );
  for (const acc of INITIAL_CHART_OF_ACCOUNTS) {
    if (existingCodes.has(acc.code)) continue;
    if (acc.parentCode && !existingCodes.has(acc.parentCode)) continue;
    stmt.run(
      tenantId,
      acc.code,
      acc.type,
      acc.parentCode ?? null,
      acc.isLeaf ? 1 : 0,
      '0.00',
      JSON.stringify({ ...acc, balance: 0, tenantId })
    );
    existingCodes.add(acc.code);
  }
}
