/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك التخزين الدائم وإدارة قاعدة البيانات المحلية (Dexie IndexedDB Engine)
 * يدعم 4 أنشطة تجارية مستقلة + وحدة أمانات مستقلة + طابور Outbox + منع تعديل القيود بعد الترحيل
 */

import {
  CommercialActivity,
  CommercialActivityId,
  Account,
  Product,
  Party,
  Invoice,
  JournalEntry,
  CashBox,
  PaymentVoucher,
  AmanatRecord,
  SystemUser,
  SystemAuditLog,
  CostCenterId,
  OutboxQueueItem,
  Branch,
} from '../types/erp';
import { db, requestPersistentStorage } from '../db/erpDatabase';
import { DEFAULT_CURRENCY_CONFIG } from '../config/currency';

// الأنشطة التجارية الأربعة الرسمية المستقلة فقط (الأمانات وحدة مستقلة لحفظ أموال وأصناف الغير)
export const OFFICIAL_ACTIVITIES: CommercialActivity[] = [
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

// الدليل المحاسبي الشجري الموحد المعتمد
export const INITIAL_CHART_OF_ACCOUNTS: Account[] = [
  // 1. الأصول (Assets)
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

  // 2. الخصوم (Liabilities)
  { code: '2', nameAr: 'الخصوم', type: 'LIABILITY', parentCode: null, isLeaf: false, balance: 0 },
  { code: '21', nameAr: 'الخصوم المتداولة', type: 'LIABILITY', parentCode: '2', isLeaf: false, balance: 0 },
  { code: '2101', nameAr: 'الموردون والدائنون', type: 'LIABILITY', parentCode: '21', isLeaf: true, balance: 0 },
  { code: '2102', nameAr: 'أمانات نقدية للغير (التزام معزول)', type: 'LIABILITY', parentCode: '21', isLeaf: true, balance: 0 },

  // 3. حقوق الملكية (Equity)
  { code: '3', nameAr: 'حقوق الملكية', type: 'EQUITY', parentCode: null, isLeaf: false, balance: 0 },
  { code: '3101', nameAr: 'رأس المال المخصص', type: 'EQUITY', parentCode: '3', isLeaf: true, balance: 0 },
  { code: '3102', nameAr: 'الأرباح والخسائر المبقاة', type: 'EQUITY', parentCode: '3', isLeaf: true, balance: 0 },

  // 4. الإيرادات (Revenue)
  { code: '4', nameAr: 'الإيرادات', type: 'REVENUE', parentCode: null, isLeaf: false, balance: 0 },
  { code: '4101', nameAr: 'إيرادات مبيعات الصيدلية', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'pharmacy' },
  { code: '4102', nameAr: 'إيرادات مبيعات المواد الغذائية والبقالة', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'grocery' },
  { code: '4103', nameAr: 'إيرادات مبيعات قطع غيار الدراجات', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'bike_parts' },
  { code: '4104', nameAr: 'إيرادات مبيعات قطع غيار المعدات', type: 'REVENUE', parentCode: '4', isLeaf: true, balance: 0, costCenterId: 'equipment_parts' },

  // 5. المصروفات وتكلفة المبيعات (Expenses & COGS)
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
];

export const INITIAL_BRANCHES: Branch[] = [
  {
    id: 'branch_main',
    code: 'BR01',
    nameAr: 'الفرع الرئيسي',
    isMain: true,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

const INITIAL_CASH_BOXES: CashBox[] = [
  { id: 'cb-1', code: 'CASH-MAIN', nameAr: 'الصندوق الرئيسي (الخزينة العامة)', accountCode: '1101', balance: 0, isDefault: true, branchId: 'branch_main' },
  { id: 'cb-2', code: 'BANK-01', nameAr: 'الحساب البنكي الأول', accountCode: '1102', balance: 0, isDefault: false, branchId: 'branch_main' },
];

export const INITIAL_USERS: SystemUser[] = [
  {
    id: 'user-admin',
    tenantId: 'tenant_main',
    username: 'admin',
    fullName: 'المدير العام (إدارة النظام)',
    role: 'ADMIN',
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    active: true,
    mustChangePassword: true,
  },
  {
    id: 'user-accountant',
    tenantId: 'tenant_main',
    username: 'accountant',
    fullName: 'المحاسب المالي العام',
    role: 'ACCOUNTANT',
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    active: true,
    mustChangePassword: true,
  },
  {
    id: 'user-cashier',
    tenantId: 'tenant_main',
    username: 'cashier',
    fullName: 'أمين نقطة البيع (كاشير)',
    role: 'CASHIER',
    allowedActivities: ['pharmacy', 'grocery', 'bike_parts', 'equipment_parts'],
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    active: true,
    mustChangePassword: true,
  },
];

// --- واجهة بيانات الشركة القابلة للتخصيص ---
export interface CompanyProfile {
  nameAr: string;         // اسم الشركة بالعربية
  nameEn?: string;        // اسم الشركة بالإنجليزية
  logo?: string;          // base64 string للشعار
  address?: string;       // العنوان
  phone?: string;         // الهاتف
  email?: string;         // البريد
  taxNumber?: string;     // الرقم الضريبي
  currencyCode?: string;  // رمز العملة القياسي (SAR افتراضي)
  currency: string;       // العملة (ريال سعودي افتراضي)
  currencySymbol: string; // رمز العملة (ر.س)
  website?: string;       // الموقع
  headerNote?: string;    // ملاحظة رأس الفاتورة
  footerNote?: string;    // ملاحظة ذيل الفاتورة
}

// المفاتيح المعيارية الجديدة للمشروع المستقل
const STORAGE_KEYS = {
  ACTIVITIES: 'multi_activity_erp_activities',
  ACCOUNTS: 'multi_activity_erp_accounts',
  PRODUCTS: 'multi_activity_erp_products',
  PARTIES: 'multi_activity_erp_parties',
  INVOICES: 'multi_activity_erp_invoices',
  JOURNAL_ENTRIES: 'multi_activity_erp_journal_entries',
  CASH_BOXES: 'multi_activity_erp_cash_boxes',
  VOUCHERS: 'multi_activity_erp_vouchers',
  AMANAT: 'multi_activity_erp_amanat',
  USERS: 'multi_activity_erp_users',
  CURRENT_USER: 'multi_activity_erp_current_user',
  AUDIT_LOGS: 'multi_activity_erp_audit_logs',
  OUTBOX: 'multi_activity_erp_outbox',
  BRANCHES: 'multi_activity_erp_branches',
  ACTIVE_BRANCH_ID: 'multi_activity_erp_active_branch_id',
  COMPANY_PROFILE: 'multi_activity_erp_company_profile',
};

// المفاتيح السابقة للحفاظ عليها وقراءة بياناتها دون حذفها (Backward-Compatibility & Safe Migration)
const LEGACY_STORAGE_KEYS = {
  ACTIVITIES: 'alharaj_erp_activities',
  ACCOUNTS: 'alharaj_erp_accounts',
  PRODUCTS: 'alharaj_erp_products',
  PARTIES: 'alharaj_erp_parties',
  INVOICES: 'alharaj_erp_invoices',
  JOURNAL_ENTRIES: 'alharaj_erp_journal_entries',
  CASH_BOXES: 'alharaj_erp_cash_boxes',
  VOUCHERS: 'alharaj_erp_vouchers',
  AMANAT: 'alharaj_erp_amanat',
  USERS: 'alharaj_erp_users',
  CURRENT_USER: 'alharaj_erp_current_user',
  AUDIT_LOGS: 'alharaj_erp_audit_logs',
  OUTBOX: 'alharaj_erp_outbox',
  BRANCHES: 'alharaj_erp_branches',
  ACTIVE_BRANCH_ID: 'alharaj_erp_active_branch_id',
};

class StorageService {
  private isInitialized = false;
  private memoryFallback = new Map<string, string>();

  private getItem<T>(key: string, defaultValue: T): T {
    try {
      if (typeof localStorage === 'undefined') {
        const mem = this.memoryFallback.get(key);
        if (!mem) return defaultValue;
        return JSON.parse(mem) as T;
      }
      const data = localStorage.getItem(key);
      if (!data) return defaultValue;
      return JSON.parse(data) as T;
    } catch (err) {
      console.error(`Error reading key ${key} from storage:`, err);
      return defaultValue;
    }
  }

  private setItem<T>(key: string, value: T): void {
    try {
      if (typeof localStorage === 'undefined') {
        this.memoryFallback.set(key, JSON.stringify(value));
        return;
      }
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.error(`Error writing key ${key} to storage:`, err);
    }
  }

  // توليد معرف UUID v4 قياسي للعمليات
  public generateUUID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'uuid-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 9);
  }

  // ترحيل البيانات من المفاتيح السابقة دون حذف المفاتيح القديمة إطلاقاً
  public migrateLegacyLocalStorage(): { migrated: boolean; keysMigrated: string[] } {
    const keysMigrated: string[] = [];
    if (typeof localStorage === 'undefined') return { migrated: false, keysMigrated };

    for (const [keyName, newStorageKey] of Object.entries(STORAGE_KEYS)) {
      const legacyStorageKey = (LEGACY_STORAGE_KEYS as Record<string, string>)[keyName];
      if (legacyStorageKey) {
        const legacyVal = localStorage.getItem(legacyStorageKey);
        const newVal = localStorage.getItem(newStorageKey);

        // إذا وُجدت بيانات في المفتاح القديم ولم تكن منسوخة بعد في المفتاح الجديد
        if (legacyVal && !newVal) {
          localStorage.setItem(newStorageKey, legacyVal);
          keysMigrated.push(keyName);
          console.log(`[Storage Migration] Preserved & Migrated: ${legacyStorageKey} -> ${newStorageKey}`);
        }
      }
    }

    return { migrated: keysMigrated.length > 0, keysMigrated };
  }

  // تهيئة النظام دون فرض تسجيل دخول مدير عام تلقائياً ودون الكتابة فوق Dexie
  public initialize(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    requestPersistentStorage();
    this.migrateLegacyLocalStorage();

    if (typeof localStorage !== 'undefined') {
      if (!localStorage.getItem(STORAGE_KEYS.ACCOUNTS)) {
        this.setItem(STORAGE_KEYS.ACCOUNTS, INITIAL_CHART_OF_ACCOUNTS);
      }
      this.setItem(STORAGE_KEYS.ACTIVITIES, OFFICIAL_ACTIVITIES);

      if (!localStorage.getItem(STORAGE_KEYS.CASH_BOXES)) {
        this.setItem(STORAGE_KEYS.CASH_BOXES, INITIAL_CASH_BOXES);
      }
      if (!localStorage.getItem(STORAGE_KEYS.USERS)) {
        this.setItem(STORAGE_KEYS.USERS, INITIAL_USERS);
      }

      if (!localStorage.getItem(STORAGE_KEYS.BRANCHES)) {
        this.setItem(STORAGE_KEYS.BRANCHES, INITIAL_BRANCHES);
      }
      if (!localStorage.getItem(STORAGE_KEYS.ACTIVE_BRANCH_ID)) {
        this.setItem(STORAGE_KEYS.ACTIVE_BRANCH_ID, 'branch_main');
      }

      if (!localStorage.getItem(STORAGE_KEYS.PRODUCTS)) this.setItem(STORAGE_KEYS.PRODUCTS, []);
      if (!localStorage.getItem(STORAGE_KEYS.PARTIES)) this.setItem(STORAGE_KEYS.PARTIES, []);
      if (!localStorage.getItem(STORAGE_KEYS.INVOICES)) this.setItem(STORAGE_KEYS.INVOICES, []);
      if (!localStorage.getItem(STORAGE_KEYS.JOURNAL_ENTRIES)) this.setItem(STORAGE_KEYS.JOURNAL_ENTRIES, []);
      if (!localStorage.getItem(STORAGE_KEYS.VOUCHERS)) this.setItem(STORAGE_KEYS.VOUCHERS, []);
      if (!localStorage.getItem(STORAGE_KEYS.AMANAT)) this.setItem(STORAGE_KEYS.AMANAT, []);
      if (!localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS)) this.setItem(STORAGE_KEYS.AUDIT_LOGS, []);
      if (!localStorage.getItem(STORAGE_KEYS.OUTBOX)) this.setItem(STORAGE_KEYS.OUTBOX, []);
    }
  }

  // --- نظام الفروع ونقاط البيع (Multi-Branch System) ---
  public getBranches(): Branch[] {
    return this.getItem<Branch[]>(STORAGE_KEYS.BRANCHES, INITIAL_BRANCHES);
  }

  public saveBranches(branches: Branch[]): void {
    this.setItem(STORAGE_KEYS.BRANCHES, branches);
    db.branches.bulkPut(branches).catch(() => {});
  }

  public getActiveBranchId(): string {
    return this.getItem<string>(STORAGE_KEYS.ACTIVE_BRANCH_ID, 'branch_main');
  }

  public setActiveBranchId(branchId: string): void {
    this.setItem(STORAGE_KEYS.ACTIVE_BRANCH_ID, branchId);
  }

  public getActiveBranch(): Branch {
    const branches = this.getBranches();
    const activeId = this.getActiveBranchId();
    return branches.find((b) => b.id === activeId) || branches[0] || INITIAL_BRANCHES[0];
  }

  public addBranch(branch: Branch): void {
    const branches = this.getBranches();
    if (!branch.id) branch.id = this.generateUUID();
    branches.push(branch);
    this.saveBranches(branches);
    this.queueOutbox('BRANCH', branch.id, 'CREATE', branch as unknown as Record<string, unknown>);
    this.logAction('إضافة فرع', `تمت إضافة الفرع: ${branch.nameAr} (${branch.code})`);
  }

  public updateBranch(branch: Branch): void {
    const branches = this.getBranches();
    const idx = branches.findIndex((b) => b.id === branch.id);
    if (idx !== -1) {
      branches[idx] = branch;
      this.saveBranches(branches);
      this.queueOutbox('BRANCH', branch.id, 'UPDATE', branch as unknown as Record<string, unknown>);
      this.logAction('تعديل فرع', `تم تحديث بيانات الفرع: ${branch.nameAr}`);
    }
  }

  // معرّف نقطة البيع / الجهاز لمنع تصادم كاشيرات الفرع الواحد عند العمل دون إنترنت
  public getTerminalCode(): string {
    return this.getItem<string>('multi_activity_erp_terminal_code', 'POS01');
  }

  public setTerminalCode(code: string): void {
    const clean = code.trim().toUpperCase() || 'POS01';
    this.setItem('multi_activity_erp_terminal_code', clean);
  }

  /**
   * توليد رقم تسلسلي مستقل لكل فرع ونقطة بيع لمنع تصادم الفواتير في بيئة العمل دون اتصال (Offline Collision-Proof)
   * النمط: INV-{BRANCH_CODE}-{TERMINAL_CODE}-{YYYY}-{SEQUENCE}
   */
  public generateBranchInvoiceNumber(type: 'INV' | 'PUR', branchCode?: string, terminalCode?: string): string {
    const activeCode = branchCode || this.getActiveBranch().code || 'BR01';
    const termCode = terminalCode || this.getTerminalCode();
    const year = new Date().getFullYear();
    const invoices = this.getInvoices();
    const prefix = `${type}-${activeCode}-${termCode}-${year}-`;
    const branchInvoices = invoices.filter((inv) => inv.invoiceNumber && inv.invoiceNumber.startsWith(prefix));
    const nextSeq = branchInvoices.length + 1;
    return `${prefix}${String(nextSeq).padStart(5, '0')}`;
  }

  /**
   * توليد رقم سند مالي مستقل لكل فرع ونقطة بيع
   */
  public generateBranchVoucherNumber(type: 'RCT' | 'PAY', branchCode?: string, terminalCode?: string): string {
    const activeCode = branchCode || this.getActiveBranch().code || 'BR01';
    const termCode = terminalCode || this.getTerminalCode();
    const year = new Date().getFullYear();
    const vouchers = this.getVouchers();
    const prefix = `${type}-${activeCode}-${termCode}-${year}-`;
    const branchVouchers = vouchers.filter((v) => v.voucherNumber && v.voucherNumber.startsWith(prefix));
    const nextSeq = branchVouchers.length + 1;
    return `${prefix}${String(nextSeq).padStart(5, '0')}`;
  }

  // الأنشطة التجارية الأربعة
  public getActivities(): CommercialActivity[] {
    return OFFICIAL_ACTIVITIES;
  }

  // الدليل المحاسبي
  public getAccounts(): Account[] {
    return this.getItem<Account[]>(STORAGE_KEYS.ACCOUNTS, INITIAL_CHART_OF_ACCOUNTS);
  }

  public saveAccounts(accounts: Account[]): void {
    this.setItem(STORAGE_KEYS.ACCOUNTS, accounts);
    db.accounts.bulkPut(accounts).catch(() => {});
  }

  public updateAccountBalance(code: string, deltaBalance: number): void {
    const accounts = this.getAccounts();
    const target = accounts.find((a) => a.code === code);
    if (target) {
      target.balance = Number((target.balance + deltaBalance).toFixed(2));
      this.saveAccounts(accounts);
    }
  }

  // الأصناف والمخزون
  public getProducts(activityId?: CommercialActivityId): Product[] {
    const products = this.getItem<Product[]>(STORAGE_KEYS.PRODUCTS, []);
    if (activityId) {
      return products.filter((p) => p.activityId === activityId);
    }
    return products;
  }

  public saveProducts(products: Product[]): void {
    this.setItem(STORAGE_KEYS.PRODUCTS, products);
    if (products.length > 0) {
      db.products.bulkPut(products).catch(() => {});
    }
  }

  public addProduct(product: Product): void {
    if (!product.id) product.id = this.generateUUID();
    const products = this.getProducts();
    products.unshift(product);
    this.saveProducts(products);
    this.queueOutbox('PRODUCT', product.id, 'CREATE', product as unknown as Record<string, unknown>);
    this.logAction('إضافة صنف', `تمت إضافة الصنف ${product.nameAr} بكود ${product.code}`);
  }

  public updateProduct(product: Product): void {
    const products = this.getProducts();
    const index = products.findIndex((p) => p.id === product.id);
    if (index !== -1) {
      products[index] = product;
      this.saveProducts(products);
      this.queueOutbox('PRODUCT', product.id, 'UPDATE', product as unknown as Record<string, unknown>);
      this.logAction('تعديل صنف', `تم تحديث بيانات الصنف ${product.nameAr}`);
    }
  }

  public deleteProduct(productId: string): void {
    const products = this.getProducts().filter((p) => p.id !== productId);
    this.saveProducts(products);
    db.products.delete(productId).catch(() => {});
    this.queueOutbox('PRODUCT', productId, 'DELETE', { id: productId });
    this.logAction('حذف صنف', `تم حذف الصنف ذو المعرف ${productId}`);
  }

  // العملاء والموردين
  public getParties(type?: 'CUSTOMER' | 'SUPPLIER'): Party[] {
    const parties = this.getItem<Party[]>(STORAGE_KEYS.PARTIES, []);
    if (type) {
      return parties.filter((p) => p.type === type);
    }
    return parties;
  }

  public saveParties(parties: Party[]): void {
    this.setItem(STORAGE_KEYS.PARTIES, parties);
    if (parties.length > 0) {
      db.parties.bulkPut(parties).catch(() => {});
    }
  }

  public addParty(party: Party): void {
    if (!party.id) party.id = this.generateUUID();
    const parties = this.getParties();
    parties.unshift(party);
    this.saveParties(parties);
    this.queueOutbox('PARTY', party.id, 'CREATE', party as unknown as Record<string, unknown>);
    this.logAction(`إضافة ${party.type === 'CUSTOMER' ? 'عميل' : 'مورد'}`, `تم تسجيل ${party.nameAr}`);
  }

  public updateParty(party: Party): void {
    const parties = this.getParties();
    const index = parties.findIndex((p) => p.id === party.id);
    if (index !== -1) {
      parties[index] = party;
      this.saveParties(parties);
      this.queueOutbox('PARTY', party.id, 'UPDATE', party as unknown as Record<string, unknown>);
    }
  }

  public updatePartyBalance(partyId: string, deltaBalance: number): void {
    const parties = this.getParties();
    const target = parties.find((p) => p.id === partyId);
    if (target) {
      target.balance = Number((target.balance + deltaBalance).toFixed(2));
      this.saveParties(parties);
    }
  }

  // الفواتير
  public getInvoices(activityId?: CommercialActivityId): Invoice[] {
    const invoices = this.getItem<Invoice[]>(STORAGE_KEYS.INVOICES, []);
    if (activityId) {
      return invoices.filter((inv) => inv.activityId === activityId);
    }
    return invoices;
  }

  public saveInvoices(invoices: Invoice[]): void {
    this.setItem(STORAGE_KEYS.INVOICES, invoices);
    if (invoices.length > 0) {
      db.invoices.bulkPut(invoices).catch(() => {});
    }
  }

  public addInvoice(invoice: Invoice, skipOutbox = false): void {
    if (!invoice.id) invoice.id = this.generateUUID();
    invoice.isPosted = true; // الفواتير الصادرة مرحلة وغير قابلة للتعديل
    const invoices = this.getInvoices();
    invoices.unshift(invoice);
    this.saveInvoices(invoices);
    if (!skipOutbox) {
      const deps: string[] = [];
      if (invoice.partyId) deps.push(invoice.partyId);
      if (invoice.items) {
        invoice.items.forEach((it) => {
          if (it.productId && !deps.includes(it.productId)) deps.push(it.productId);
        });
      }
      this.queueOutbox('INVOICE', invoice.id, 'CREATE', invoice as unknown as Record<string, unknown>, deps);
    }
    this.logAction(`فاتورة ${invoice.type}`, `إصدار فاتورة رقم ${invoice.invoiceNumber} بقيمة ${invoice.total}`);
  }

  // قيود اليومية - منع التعديل المباشر بعد الترحيل، والتصحيح يتم عبر العكس فقط
  public getJournalEntries(costCenterId?: CostCenterId): JournalEntry[] {
    const entries = this.getItem<JournalEntry[]>(STORAGE_KEYS.JOURNAL_ENTRIES, []);
    if (costCenterId) {
      return entries.filter((e) => e.costCenterId === costCenterId);
    }
    return entries;
  }

  public saveJournalEntries(entries: JournalEntry[]): void {
    this.setItem(STORAGE_KEYS.JOURNAL_ENTRIES, entries);
    if (entries.length > 0) {
      db.journalEntries.bulkPut(entries).catch(() => {});
    }
  }

  public addJournalEntry(entry: JournalEntry, skipOutbox = false): void {
    if (!entry.id) entry.id = this.generateUUID();
    if (!entry.status) entry.status = 'POSTED';

    // التحقق الصارم من توازن القيد المحاسبي المزدوج (Double-Entry Balance Enforcement)
    let totalDebit = 0;
    let totalCredit = 0;
    if (entry.lines && entry.lines.length > 0) {
      for (const line of entry.lines) {
        totalDebit += Number(line.debit || 0);
        totalCredit += Number(line.credit || 0);
      }
      totalDebit = Number(totalDebit.toFixed(2));
      totalCredit = Number(totalCredit.toFixed(2));
    }

    if (Math.abs(totalDebit - totalCredit) > 0.001) {
      throw new Error(`القيد المحاسبي غير متوازن: إجمالي المدين (${totalDebit}) لا يساوي إجمالي الدائن (${totalCredit})`);
    }

    const entries = this.getJournalEntries();
    entries.unshift(entry);
    this.saveJournalEntries(entries);
    if (!skipOutbox) {
      const deps: string[] = [];
      if (entry.referenceId) deps.push(entry.referenceId);
      this.queueOutbox('JOURNAL_ENTRY', entry.id, 'CREATE', entry as unknown as Record<string, unknown>, deps);
    }
    this.logAction('قيد محاسبي', `تم ترحيل القيد رقم ${entry.entryNumber}: ${entry.description}`);
  }

  /**
   * إنشاء قيد عكسي لتصحيح قيد مرحل سابق دون المساس بالقيد الأصلي
   */
  public reverseJournalEntry(
    originalEntryId: string,
    reversalReason: string
  ): { success: boolean; reversalEntry?: JournalEntry; error?: string } {
    const entries = this.getJournalEntries();
    const original = entries.find((e) => e.id === originalEntryId);

    if (!original) {
      return { success: false, error: 'القيد الأصلي غير موجود.' };
    }

    if (original.status === 'REVERSED') {
      return { success: false, error: 'تم عكس هذا القيد مسبقاً بقيد تصحيحي آخر.' };
    }

    // إنشاء أطراف القيد العكسي (عكس المدين والدائن)
    const reversedLines = original.lines.map((l) => ({
      id: this.generateUUID(),
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,   // عكس: ما كان دائناً يصبح مديناً
      credit: l.debit,   // عكس: ما كان مديناً يصبح دائناً
      costCenterId: l.costCenterId,
      memo: `عكس لقيد ${original.entryNumber}: ${reversalReason}`,
    }));

    const reversalCount = entries.length + 1;
    const reversalEntryNumber = `REV-${new Date().getFullYear()}-${String(reversalCount).padStart(5, '0')}`;

    const reversalEntry: JournalEntry = {
      id: this.generateUUID(),
      entryNumber: reversalEntryNumber,
      date: new Date().toISOString().split('T')[0],
      description: `قيد تسوية وعكس للقيد ${original.entryNumber} - السبب: ${reversalReason}`,
      costCenterId: original.costCenterId,
      lines: reversedLines,
      status: 'POSTED',
      referenceType: 'MANUAL',
      referenceId: original.id,
      isAutoGenerated: true,
      reversedEntryId: original.id,
      reversalReason,
    };

    // تطبيق أثر القيد العكسي على أرصدة الحسابات
    reversedLines.forEach((line) => {
      const netDelta = (Number(line.debit) || 0) - (Number(line.credit) || 0);
      this.updateAccountBalance(line.accountCode, netDelta);
    });

    // تعليم القيد الأصلي كمعكوس
    original.status = 'REVERSED';
    original.reversedEntryId = reversalEntry.id;
    original.reversalReason = reversalReason;

    entries.unshift(reversalEntry);
    this.saveJournalEntries(entries);

    this.queueOutbox('JOURNAL_ENTRY', reversalEntry.id, 'CREATE', reversalEntry as unknown as Record<string, unknown>);
    this.queueOutbox('JOURNAL_ENTRY', original.id, 'UPDATE', { id: original.id, status: 'REVERSED', reversalReason });
    this.logAction('عكس قيد محاسبي', `تم إنشاء القيد العكسي ${reversalEntry.entryNumber} للقيد ${original.entryNumber}`);

    return { success: true, reversalEntry };
  }

  // الصناديق
  public getCashBoxes(): CashBox[] {
    return this.getItem<CashBox[]>(STORAGE_KEYS.CASH_BOXES, INITIAL_CASH_BOXES);
  }

  public saveCashBoxes(boxes: CashBox[]): void {
    this.setItem(STORAGE_KEYS.CASH_BOXES, boxes);
    db.cashBoxes.bulkPut(boxes).catch(() => {});
  }

  public updateCashBoxBalance(id: string, delta: number): void {
    const boxes = this.getCashBoxes();
    const box = boxes.find((b) => b.id === id);
    if (box) {
      box.balance = Number((box.balance + delta).toFixed(2));
      this.saveCashBoxes(boxes);
    }
  }

  // السندات (قبض وصرف)
  public getVouchers(): PaymentVoucher[] {
    return this.getItem<PaymentVoucher[]>(STORAGE_KEYS.VOUCHERS, []);
  }

  public addVoucher(voucher: PaymentVoucher, skipOutbox = false): void {
    if (!voucher.id) voucher.id = this.generateUUID();
    const vouchers = this.getVouchers();
    vouchers.unshift(voucher);
    this.setItem(STORAGE_KEYS.VOUCHERS, vouchers);
    db.vouchers.put(voucher).catch(() => {});
    if (!skipOutbox) {
      const deps: string[] = [];
      if (voucher.partyId) deps.push(voucher.partyId);
      if (voucher.cashBoxId) deps.push(voucher.cashBoxId);
      this.queueOutbox('VOUCHER', voucher.id, 'CREATE', voucher as unknown as Record<string, unknown>, deps);
    }
    this.logAction(
      voucher.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف',
      `سند رقم ${voucher.voucherNumber} بمبلغ ${voucher.amount} لصالح/من ${voucher.partyName}`
    );
  }

  // وحدة الأمانات المستقلة (حفظ أموال وأصناف الغير)
  public getAmanatRecords(): AmanatRecord[] {
    return this.getItem<AmanatRecord[]>(STORAGE_KEYS.AMANAT, []);
  }

  public saveAmanatRecords(records: AmanatRecord[]): void {
    this.setItem(STORAGE_KEYS.AMANAT, records);
    if (records.length > 0) {
      db.amanatRecords.bulkPut(records).catch(() => {});
    }
  }

  public addAmanatRecord(record: AmanatRecord, skipOutbox = false): void {
    if (!record.id) record.id = this.generateUUID();
    const records = this.getAmanatRecords();
    records.unshift(record);
    this.saveAmanatRecords(records);
    if (!skipOutbox) {
      const deps: string[] = [];
      if (record.cashBoxId) deps.push(record.cashBoxId);
      this.queueOutbox('AMANAT', record.id, 'CREATE', record as unknown as Record<string, unknown>, deps);
    }
    this.logAction(
      'تسجيل أمانة',
      `استلام أمانة ${record.type === 'CASH' ? 'نقدية' : 'عينية'} رقم ${record.recordNumber} من ${record.depositorName}`
    );
  }

  public updateAmanatRecord(record: AmanatRecord): void {
    const records = this.getAmanatRecords();
    const index = records.findIndex((r) => r.id === record.id);
    if (index !== -1) {
      records[index] = record;
      this.saveAmanatRecords(records);
      const deps: string[] = [];
      if (record.cashBoxId) deps.push(record.cashBoxId);
      this.queueOutbox('AMANAT', record.id, 'UPDATE', record as unknown as Record<string, unknown>, deps);
      this.logAction('تحديث أمانة', `تغيير حالة أمانة رقم ${record.recordNumber} إلى ${record.status}`);
    }
  }

  // طابور الإرسال والمزامنة (Outbox Queue)
  public getOutboxQueue(): OutboxQueueItem[] {
    return this.getItem<OutboxQueueItem[]>(STORAGE_KEYS.OUTBOX, []);
  }

  public queueOutbox(
    entityType: OutboxQueueItem['entityType'],
    entityId: string,
    action: OutboxQueueItem['action'],
    payload: Record<string, unknown>,
    dependsOn?: string[],
    branchId?: string
  ): void {
    const queue = this.getOutboxQueue();
    const currentActor = this.getCurrentUser();
    const tenantId = currentActor?.tenantId || 'tenant_main';
    const targetBranchId = branchId || this.getActiveBranchId();
    const idempotencyKey = `${tenantId}_${targetBranchId}_${entityType}_${entityId}_${action}`;

    // منع تكرار نفس الحركة المعلقة
    const existingIdx = queue.findIndex(
      (i) => i.idempotencyKey === idempotencyKey && (i.status === 'PENDING' || i.status === 'SYNCING')
    );
    if (existingIdx !== -1) {
      queue[existingIdx].payload = payload;
      if (dependsOn) queue[existingIdx].dependsOn = dependsOn;
      if (targetBranchId) queue[existingIdx].branchId = targetBranchId;
      this.setItem(STORAGE_KEYS.OUTBOX, queue);
      db.outbox.put(queue[existingIdx]).catch(() => {});
      return;
    }

    // تحديد أولوية Master-Data-First: 1=حسابات/صناديق/فروع، 2=أطراف/أصناف، 3=فواتير/سندات، 4=قيود
    let priority = 3;
    if (entityType === 'ACCOUNT' || entityType === 'CASHBOX' || entityType === 'BRANCH') priority = 1;
    else if (entityType === 'PARTY' || entityType === 'PRODUCT') priority = 2;
    else if (entityType === 'INVOICE' || entityType === 'VOUCHER' || entityType === 'AMANAT') priority = 3;
    else if (entityType === 'JOURNAL_ENTRY') priority = 4;

    const item: OutboxQueueItem = {
      id: this.generateUUID(),
      tenantId,
      branchId: targetBranchId,
      entityType,
      entityId,
      action,
      payload,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      idempotencyKey,
      retryCount: 0,
      priority,
      dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
    };
    queue.push(item);
    this.setItem(STORAGE_KEYS.OUTBOX, queue);
    db.outbox.put(item).catch(() => {});
  }

  public markOutboxSynced(id: string): void {
    const queue = this.getOutboxQueue();
    const item = queue.find((i) => i.id === id);
    if (item) {
      item.status = 'SYNCED';
      item.syncedAt = new Date().toISOString();
      this.setItem(STORAGE_KEYS.OUTBOX, queue);
      db.outbox.put(item).catch(() => {});
    }
  }

  // المستخدمون والصلاحيات
  public getUsers(): SystemUser[] {
    return this.getItem<SystemUser[]>(STORAGE_KEYS.USERS, INITIAL_USERS);
  }

  public saveUsers(users: SystemUser[]): void {
    this.setItem(STORAGE_KEYS.USERS, users);
    db.users.bulkPut(users).catch(() => {});
  }

  public getCurrentUser(): SystemUser {
    return this.getItem<SystemUser>(STORAGE_KEYS.CURRENT_USER, {
      id: 'guest',
      tenantId: 'tenant_main',
      username: 'guest',
      fullName: 'مستخدم غير مسجل',
      role: 'CASHIER',
      allowedActivities: [],
      branchId: 'branch_main',
      allowedBranches: ['branch_main'],
      active: false,
    });
  }

  public setCurrentUser(user: SystemUser): void {
    this.setItem(STORAGE_KEYS.CURRENT_USER, user);
  }

  // سجل المراجعة والرقابة
  public getAuditLogs(): SystemAuditLog[] {
    return this.getItem<SystemAuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
  }

  public logAction(action: string, details: string): void {
    const logs = this.getAuditLogs();
    const currentUser = this.getCurrentUser();
    const newLog: SystemAuditLog = {
      id: this.generateUUID(),
      timestamp: new Date().toISOString(),
      userId: currentUser?.id || 'sys',
      userName: currentUser?.fullName || 'النظام',
      action,
      details,
    };
    logs.unshift(newLog);
    this.setItem(STORAGE_KEYS.AUDIT_LOGS, logs.slice(0, 500));
    db.auditLogs.put(newLog).catch(() => {});
  }

  // النسخ الاحتياطي الكامل المستقل مع رمز التحقق (Checksum)
  public exportFullBackupJSON(): string {
    const payload = {
      branches: this.getBranches(),
      accounts: this.getAccounts(),
      activities: this.getActivities(),
      products: this.getProducts(),
      parties: this.getParties(),
      invoices: this.getInvoices(),
      journalEntries: this.getJournalEntries(),
      cashBoxes: this.getCashBoxes(),
      vouchers: this.getVouchers(),
      amanat: this.getAmanatRecords(),
      users: this.getUsers(),
      auditLogs: this.getAuditLogs(),
      outbox: this.getOutboxQueue(),
    };

    const serialized = JSON.stringify(payload);
    // حساب رمز تحقق رياضي حتمي
    let checksum = 0;
    for (let i = 0; i < serialized.length; i++) {
      checksum = (checksum + serialized.charCodeAt(i) * (i + 1)) % 1000000007;
    }

    const backup = {
      app: 'نظام الإدارة التجارية والمحاسبية المتكامل',
      systemIdentifier: 'multi_activity_erp',
      version: '2.1.0',
      exportedAt: new Date().toISOString(),
      checksum: checksum.toString(16),
      data: payload,
    };

    return JSON.stringify(backup, null, 2);
  }

  public exportBackupJSON(): string {
    return this.exportFullBackupJSON();
  }

  public importBackupJSON(jsonStr: string): { success: boolean; error?: string } {
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== 'object' || !parsed.data) {
        return { success: false, error: 'الملف غير مطابق لبنية النسخة الاحتياطية الرسمية: حقل البيانات مفقود.' };
      }

      // 1. التحقق من هوية النظام وإصدار المخطط
      if (
        parsed.systemIdentifier &&
        parsed.systemIdentifier !== 'multi_activity_erp' &&
        parsed.systemIdentifier !== 'alharaj_erp'
      ) {
        return { success: false, error: 'الملف ينتمي لنظام تجاري مختلف وغير متوافق مع قواعد بيانات هذا النظام.' };
      }

      // 2. التحقق الصارم من رمز التحقق الرياضي (Checksum Verification)
      // رفض استعادة أي نسخة تعرضت للعبث اليدوي أو التلف قبل المساس بالبيانات
      if (parsed.checksum) {
        const serialized = JSON.stringify(parsed.data);
        let calculated = 0;
        for (let i = 0; i < serialized.length; i++) {
          calculated = (calculated + serialized.charCodeAt(i) * (i + 1)) % 1000000007;
        }
        if (calculated.toString(16) !== parsed.checksum) {
          return {
            success: false,
            error: 'فشل التحقق من سلامة النسخة الاحتياطية (Checksum Mismatch)؛ الملف تالف أو تم تعديله خارج النظام، وتم حجب الاستعادة لحماية قواعد البيانات.',
          };
        }
      }

      // 3. استعادة البيانات الشاملة لكافة الفروع والمستخدمين والقيود
      const d = parsed.data;
      if (d.branches && Array.isArray(d.branches)) this.saveBranches(d.branches);
      if (d.accounts && Array.isArray(d.accounts)) this.saveAccounts(d.accounts);
      if (d.products && Array.isArray(d.products)) this.saveProducts(d.products);
      if (d.parties && Array.isArray(d.parties)) this.saveParties(d.parties);
      if (d.invoices && Array.isArray(d.invoices)) this.saveInvoices(d.invoices);
      if (d.journalEntries && Array.isArray(d.journalEntries)) this.saveJournalEntries(d.journalEntries);
      if (d.cashBoxes && Array.isArray(d.cashBoxes)) this.saveCashBoxes(d.cashBoxes);
      if (d.vouchers && Array.isArray(d.vouchers)) {
        this.setItem(STORAGE_KEYS.VOUCHERS, d.vouchers);
        db.vouchers.bulkPut(d.vouchers).catch(() => {});
      }
      if (d.amanat && Array.isArray(d.amanat)) this.saveAmanatRecords(d.amanat);
      if (d.users && Array.isArray(d.users)) this.saveUsers(d.users);
      if (d.auditLogs && Array.isArray(d.auditLogs)) {
        this.setItem(STORAGE_KEYS.AUDIT_LOGS, d.auditLogs);
        db.auditLogs.bulkPut(d.auditLogs).catch(() => {});
      }
      if (d.outbox && Array.isArray(d.outbox)) {
        this.setItem(STORAGE_KEYS.OUTBOX, d.outbox);
        db.outbox.bulkPut(d.outbox).catch(() => {});
      }
      if (d.syncConflicts && Array.isArray(d.syncConflicts)) {
        db.syncConflicts.bulkPut(d.syncConflicts).catch(() => {});
      }

      this.logAction('استعادة نسخة احتياطية', 'تم التحقق من سلامة Checksum واستعادة البيانات وكافة السجلات بنجاح.');
      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'خطأ غير معروف في قراءة الملف';
      console.error('Failed to import backup:', e);
      return { success: false, error: msg };
    }
  }

  // تصفير الدفاتر للبدء من جديد (نظيفة وخالية)
  public resetToCleanBooks(): void {
    localStorage.removeItem(STORAGE_KEYS.PRODUCTS);
    localStorage.removeItem(STORAGE_KEYS.PARTIES);
    localStorage.removeItem(STORAGE_KEYS.INVOICES);
    localStorage.removeItem(STORAGE_KEYS.JOURNAL_ENTRIES);
    localStorage.removeItem(STORAGE_KEYS.VOUCHERS);
    localStorage.removeItem(STORAGE_KEYS.AMANAT);
    localStorage.removeItem(STORAGE_KEYS.AUDIT_LOGS);
    localStorage.removeItem(STORAGE_KEYS.OUTBOX);
    localStorage.setItem(STORAGE_KEYS.BRANCHES, JSON.stringify(INITIAL_BRANCHES));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_BRANCH_ID, 'branch_main');
    localStorage.setItem(STORAGE_KEYS.ACCOUNTS, JSON.stringify(INITIAL_CHART_OF_ACCOUNTS));
    localStorage.setItem(STORAGE_KEYS.CASH_BOXES, JSON.stringify(INITIAL_CASH_BOXES));
    localStorage.setItem(STORAGE_KEYS.ACTIVITIES, JSON.stringify(OFFICIAL_ACTIVITIES));
    this.isInitialized = false;
    this.initialize();
  }

  // --- بيانات الشركة القابلة للتخصيص ---
  public getCompanyProfile(): CompanyProfile {
    return this.getItem<CompanyProfile>(STORAGE_KEYS.COMPANY_PROFILE, {
      nameAr: 'نظام الإدارة التجارية',
      currencyCode: DEFAULT_CURRENCY_CONFIG.code,
      currency: DEFAULT_CURRENCY_CONFIG.nameAr,
      currencySymbol: DEFAULT_CURRENCY_CONFIG.symbol,
    });
  }

  public saveCompanyProfile(profile: CompanyProfile): void {
    this.setItem(STORAGE_KEYS.COMPANY_PROFILE, profile);
    this.logAction('تعديل بيانات الشركة', `تم تحديث بيانات الشركة: ${profile.nameAr}`);
  }

  // توليد سكريبت ترحيل قاعدة بيانات PostgreSQL متوافق مع Django
  public exportPostgreSqlSchemaAndData(): string {
    return `-- ==========================================================
-- نظام الإدارة التجارية والمحاسبية المتكامل (multi_activity_erp)
-- سكريبت إنشاء جداول PostgreSQL متوافق مع نماذج Django 5.x REST
-- التاريخ: ${new Date().toISOString()}
-- ==========================================================

CREATE TABLE IF NOT EXISTS erp_activity (
    id VARCHAR(50) PRIMARY KEY,
    name_ar VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL UNIQUE,
    cost_center_code VARCHAR(50) NOT NULL,
    is_inventory_managed BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS erp_account (
    code VARCHAR(50) PRIMARY KEY,
    name_ar VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL,
    parent_code VARCHAR(50) REFERENCES erp_account(code),
    is_leaf BOOLEAN DEFAULT TRUE,
    balance NUMERIC(15, 2) DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS erp_product (
    id UUID PRIMARY KEY,
    activity_id VARCHAR(50) REFERENCES erp_activity(id),
    code VARCHAR(100) NOT NULL,
    barcode VARCHAR(100),
    name_ar VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    unit VARCHAR(50) NOT NULL,
    purchase_price NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    sell_price NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    current_stock NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    min_stock_alert NUMERIC(15, 2) DEFAULT 0.00,
    storage_location VARCHAR(100),
    track_expiry BOOLEAN DEFAULT FALSE,
    scientific_name VARCHAR(255),
    dosage_form VARCHAR(100),
    oem_number VARCHAR(100),
    manufacturer VARCHAR(100),
    compatible_models TEXT,
    equipment_type VARCHAR(100),
    serial_number VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS erp_product_batch (
    id UUID PRIMARY KEY,
    product_id UUID REFERENCES erp_product(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    expiry_date DATE NOT NULL,
    quantity NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    cost_price NUMERIC(15, 2) NOT NULL DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS erp_party (
    id UUID PRIMARY KEY,
    type VARCHAR(20) NOT NULL,
    name_ar VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    address TEXT,
    balance NUMERIC(15, 2) DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS erp_invoice (
    id UUID PRIMARY KEY,
    invoice_number VARCHAR(50) NOT NULL UNIQUE,
    type VARCHAR(20) NOT NULL,
    activity_id VARCHAR(50) REFERENCES erp_activity(id),
    party_id UUID REFERENCES erp_party(id),
    party_name VARCHAR(255),
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    subtotal NUMERIC(15, 2) NOT NULL,
    discount NUMERIC(15, 2) DEFAULT 0.00,
    tax NUMERIC(15, 2) DEFAULT 0.00,
    total NUMERIC(15, 2) NOT NULL,
    paid_amount NUMERIC(15, 2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL
);

CREATE TABLE IF NOT EXISTS erp_journal_entry (
    id UUID PRIMARY KEY,
    entry_number VARCHAR(50) NOT NULL UNIQUE,
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT NOT NULL,
    cost_center_id VARCHAR(50),
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
    is_auto_generated BOOLEAN DEFAULT FALSE,
    reversed_entry_id UUID REFERENCES erp_journal_entry(id)
);

CREATE TABLE IF NOT EXISTS erp_journal_entry_line (
    id UUID PRIMARY KEY,
    entry_id UUID REFERENCES erp_journal_entry(id) ON DELETE CASCADE,
    account_code VARCHAR(50) REFERENCES erp_account(code),
    debit NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    credit NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    memo TEXT
);

CREATE TABLE IF NOT EXISTS erp_amanat_record (
    id UUID PRIMARY KEY,
    record_number VARCHAR(50) NOT NULL UNIQUE,
    depositor_name VARCHAR(255) NOT NULL,
    depositor_phone VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL,
    amount NUMERIC(15, 2) DEFAULT 0.00,
    item_description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'HELD',
    received_date DATE NOT NULL,
    returned_date DATE,
    received_by VARCHAR(100) NOT NULL
);
`;
  }
}

export const storage = new StorageService();
storage.initialize();
