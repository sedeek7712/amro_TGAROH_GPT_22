/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * تعريفات ونماذج البيانات المؤسسية (Data Models & TypeScript Types)
 * متوافقة مع نماذج Django REST Framework وقاعدة بيانات PostgreSQL
 * الأنشطة التجارية 4 مستقلة + وحدة الأمانات المستقلة
 */

// الأنشطة التجارية الأربعة المستقلة فقط (Commercial Activities)
export type CommercialActivityId = 'pharmacy' | 'grocery' | 'bike_parts' | 'equipment_parts';
export type ActivityId = CommercialActivityId;

// مراكز التكلفة: الأنشطة الأربعة + الإدارة العامة
export type CostCenterId = CommercialActivityId | 'general';

export interface CommercialActivity {
  id: CommercialActivityId;
  nameAr: string;
  code: string;
  descriptionAr: string;
  costCenterCode: string;
  color: string;
  icon: string;
  isInventoryManaged: boolean;
}

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface Account {
  code: string;              // كود الحساب (مثال: 1101)
  nameAr: string;            // اسم الحساب بالعربية
  type: AccountType;         // طبيعة الحساب
  parentCode: string | null; // كود الحساب الأب
  isLeaf: boolean;           // هل هو حساب فرعي يقبل القيود؟
  balance: number;           // الرصيد الدفتري الحالي
  costCenterId?: CostCenterId;
}

export interface CostCenter {
  id: CostCenterId;
  nameAr: string;
  code: string;
}

export interface ProductBatch {
  id: string;             // UUID
  productId: string;      // معرّف الصنف
  batchNumber: string;    // رقم التشغيلة
  expiryDate: string;     // تاريخ الانتهاء YYYY-MM-DD
  quantity: number;       // الكمية المتاحة في هذه التشغيلة
  costPrice: number;      // سعر التكلفة للتشغيلة
}

export interface Product {
  id: string;                 // UUID v4
  activityId: CommercialActivityId;
  code: string;               // كود الصنف
  barcode?: string;           // الباركود الدولي أو المحلي
  nameAr: string;             // اسم الصنف
  category: string;           // التصنيف
  unit: string;               // وحدة القياس (حبة، كرتون، لتر...)
  purchasePrice: number;      // سعر الشراء
  sellPrice: number;          // سعر البيع
  currentStock: number;       // إجمالي الرصيد المخزني
  minStockAlert: number;      // حد الطلب / التنبيه
  storageLocation?: string;   // الرف / الموقع

  // حقول خاصة بالصيدلية والأغذية (اختيارية)
  trackExpiry?: boolean;      // تفعيل تتبع الصلاحية
  scientificName?: string;    // الاسم العلمي (صيدلية)
  dosageForm?: string;        // الشكل الدوائي (حبوب، شراب...)
  batches?: ProductBatch[];   // التشغيلات الفعلية

  // حقول خاصة بقطع غيار الدراجات والمعدات (اختيارية)
  oemNumber?: string;          // رقم القطعة الأصلي
  manufacturer?: string;       // الشركة المصنعة
  compatibleModels?: string;   // الموديلات المتوافقة وسنوات الصنع
  equipmentType?: string;      // نوع المعدة
  serialNumber?: string;       // الرقم التسلسلي للقطعة الحساسة
  updatedAt?: string;          // تاريخ آخر تحديث ISO
}

export type AmanatType = 'CASH' | 'ITEM';
export type AmanatStatus = 'HELD' | 'RETURNED' | 'CANCELLED';

export interface AmanatRecord {
  id: string;                   // UUID v4
  branchId?: string;            // الفرع المالك لسجل الأمانة
  recordNumber: string;         // رقم سند الأمانة (AMN-YYYY-XXXXX)
  depositorName: string;        // اسم المودع
  depositorPhone: string;       // رقم الهاتف
  depositorNationalId?: string; // رقم الهوية إن وجد
  type: AmanatType;             // نقدية أم عينية
  amount: number;               // المبلغ للأمانة النقدية
  cashBoxId?: string;           // الصندوق المحفوظ به إن كانت نقدية
  itemDescription?: string;     // وصف الصنف العيني ومواصفاته
  itemSerial?: string;          // الرقم التسلسلي للصنف العيني
  storageLocation?: string;     // موقع الحفظ (الخزنة / الرف)
  status: AmanatStatus;         // محفوظة، مستردة، ملغاة
  receivedDate: string;         // تاريخ الاستلام
  expectedReturnDate?: string;  // تاريخ الإرجاع المتوقع
  returnedDate?: string;        // تاريخ الإرجاع الفعلي
  receivedBy: string;           // الموظف المستلم
  recipientSignatureName?: string; // اسم وتوقيع المستلم عند الإرجاع
  notes?: string;               // ملاحظات الحفظ
  journalEntryId?: string;      // معرّف القيد المحاسبي (للأمانات النقدية فقط)
}

export type PartyType = 'CUSTOMER' | 'SUPPLIER';

export interface Party {
  id: string;               // UUID v4
  type: PartyType;
  nameAr: string;
  phone: string;
  address?: string;
  taxNumber?: string;
  balance: number;          // الرصيد (موجب = مدين لنا، سالب = دائن علينا)
  creditLimit?: number;     // سقف الائتمان
  notes?: string;
}

export type InvoiceType = 'SALE' | 'PURCHASE' | 'RETURN_SALE' | 'RETURN_PURCHASE';
export type PaymentMethod = 'CASH' | 'CREDIT' | 'BANK_TRANSFER';

export interface InvoiceItem {
  id: string;               // UUID v4
  productId: string;
  productName: string;
  productCode: string;
  batchNumber?: string;
  expiryDate?: string;
  oemNumber?: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
}

export interface StockDeductionRecorded {
  productId: string;
  batchNumber?: string;
  expiryDate?: string;
  quantity: number;
  unitCost: number;
}

export interface Invoice {
  id: string;               // UUID v4
  invoiceNumber: string;
  type: InvoiceType;
  activityId: CommercialActivityId;
  branchId?: string;        // معرف الفرع التابع له الفاتورة
  partyId?: string;
  partyName: string;
  date: string;
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  tax: number;
  shippingCost?: number;    // مصاريف شحن/توصيل إضافية للمشتريات
  total: number;
  paidAmount: number;
  paymentMethod: PaymentMethod;
  cashBoxId: string;
  notes?: string;
  journalEntryId?: string;
  isPosted?: boolean;
  status?: 'POSTED' | 'REVERSED';
  reversedByJournalId?: string;
  reversalReason?: string;
  totalCogs?: number;
  stockDeductionsRecorded?: StockDeductionRecorded[];
}

export type JournalEntryStatus = 'DRAFT' | 'POSTED' | 'REVERSED';

export interface JournalEntryLine {
  id: string;               // UUID v4
  accountCode: string;
  accountName: string;
  debit: number;            // مدين
  credit: number;           // دائن
  costCenterId?: CostCenterId;
  memo?: string;
}

export interface JournalEntry {
  id: string;               // UUID v4
  entryNumber: string;
  date: string;
  description: string;
  costCenterId: CostCenterId;
  branchId?: string;        // معرف الفرع التابع له القيد
  lines: JournalEntryLine[];
  status: JournalEntryStatus;
  referenceType?: 'INVOICE' | 'VOUCHER' | 'MANUAL' | 'AMANAT';
  referenceId?: string;
  isAutoGenerated: boolean;
  reversedEntryId?: string; // معرّف القيد المعكوس إن كان تصحيحياً
  reversalReason?: string;
}

export interface Branch {
  id: string;               // UUID v4 أو معرف قياسي
  code: string;             // كود الفرع، مثل BR01، BR02 لترقيم الفواتير المستقل
  nameAr: string;           // اسم الفرع، مثل 'الفرع الرئيسي'
  isMain: boolean;          // هل هو الفرع الرئيسي للمنشأة
  address?: string;
  phone?: string;
  defaultCashBoxId?: string;
  allowedActivities?: CommercialActivityId[];
  active: boolean;
  createdAt: string;
}

export interface PosTerminal {
  id: string;
  code: string;             // مثل POS-01
  nameAr: string;
  branchId: string;
  cashBoxId: string;
  active: boolean;
}

export interface CashBox {
  id: string;
  code: string;
  nameAr: string;
  accountCode: string;
  balance: number;
  isDefault: boolean;
  branchId?: string;        // ربط الصندوق بالفرع
  isCentral?: boolean;      // صندوق مركزي خاضع لصلاحية خاصة
}

export type VoucherType = 'RECEIPT' | 'PAYMENT';

export interface PaymentVoucher {
  id: string;               // UUID v4
  voucherNumber: string;
  type: VoucherType;
  date: string;
  amount: number;
  cashBoxId: string;
  branchId?: string;        // معرف الفرع
  partyId?: string;
  partyName: string;
  accountCode: string;
  description: string;
  costCenterId: CostCenterId;
  journalEntryId?: string;
  status?: 'POSTED' | 'REVERSED';
  reversedByJournalId?: string;
}

export type UserRole = 'ADMIN' | 'ACCOUNTANT' | 'CASHIER' | 'INVENTORY_KEEPER';

export interface SystemUser {
  id: string;
  tenantId?: string;        // معرف المؤسسة التابع لها المستخدم
  username: string;
  fullName: string;
  role: UserRole;
  allowedActivities: CommercialActivityId[];
  branchId?: string;        // الفرع الأساسي للمستخدم
  allowedBranches?: string[]; // الفروع المصرح للمستخدم بالوصول لها
  active: boolean;
  passwordHash?: string;    // مشتق كلمة المرور الآمن (PBKDF2-SHA256) - لا تخزن كنص صريح
  hasPassword?: boolean;    // مؤشر وجود كلمة مرور دون كشف المشتق في الواجهة المكتبية
  mustChangePassword?: boolean; // إلزام تغيير كلمة المرور الأولية عند أول دخول
  failedLoginAttempts?: number;
  lockedUntil?: string;     // توقيت انتهاء القفل المؤقت ISO
  updatedAt?: string;
}

export interface AuthSession {
  userId: string;
  username: string;
  role: UserRole;
  tenantId: string;
  branchId: string;
  allowedBranches: string[];
  issuedAt: string;
  expiresAt: string;
  signature: string;        // توقيع التحقق من سلامة الجلسة ومنع التلاعب في المتصفح
}

export interface CurrencyConfig {
  code: string;             // رمز ISO 4217 مثل SAR أو YER
  nameAr: string;
  symbol: string;
  decimalPlaces: number;
  roundingMode: 'HALF_UP';
}

export interface DocumentSequence {
  key: string;              // {tenantId}:{branchId}:{terminalCode}:{docType}:{year}
  lastSeq: number;
  updatedAt: string;
}

export interface SystemAuditLog {
  id: string;
  tenantId?: string;
  branchId?: string;
  timestamp: string;
  userId: string;
  userName: string;
  action: string;
  details: string;
}

export interface OutboxQueueItem {
  id: string;               // UUID v4
  tenantId: string;         // معرّف المؤسسة / المستأجر لضمان عزل البيانات
  branchId?: string;        // معرف الفرع
  entityType: 'INVOICE' | 'JOURNAL_ENTRY' | 'PRODUCT' | 'AMANAT' | 'VOUCHER' | 'PARTY' | 'ACCOUNT' | 'CASHBOX' | 'BRANCH';
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: Record<string, unknown>;
  createdAt: string;
  status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
  idempotencyKey: string;
  retryCount: number;
  priority?: number;        // 1: بيانات أساسية، 2: أطراف ومنتجات، 3: فواتير وسندات، 4: قيود اليومية
  dependsOn?: string[];     // معرفات الكيانات التي يجب أن تتم مزامنتها أولاً قبل إرسال هذه الحركة
  errorMessage?: string;
  syncedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;     // موعد إعادة المحاولة التالي وفق خوارزمية التراجع الأسي (Exponential Backoff)
  leaseOwner?: string;      // معرّف العامل/النافذة الحاجزة للعنصر ذرياً
  leaseExpiresAt?: string;  // وقت انتهاء الحجز الذري
}

export interface Tenant {
  id: string;
  name: string;
  code: string;
  currency: string;
  taxNumber?: string;
  createdAt: string;
  isActive: boolean;
}

export interface DeviceRegistration {
  deviceId: string;
  tenantId: string;
  branchId?: string;
  deviceName: string;
  deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'WEB';
  registeredAt: string;
  lastPullAt?: string;
  lastPushAt?: string;
  sequenceNumber: number;
  isActive: boolean;
}

export interface SyncConflict {
  id: string;
  tenantId: string;
  branchId?: string;
  entityType: OutboxQueueItem['entityType'];
  entityId: string;
  localPayload: Record<string, unknown>;
  remotePayload: Record<string, unknown>;
  detectedAt: string;
  resolvedAt?: string;
  status: 'PENDING_REVIEW' | 'RESOLVED_LOCAL' | 'RESOLVED_REMOTE' | 'RESOLVED_MERGED';
  notes?: string;
}

export interface SupabaseSyncConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  tenantId: string;
  deviceId: string;
  deviceName: string;
  branchId?: string;
  autoSync: boolean;
  lastPullTimestamp: string | null;
  lastPushTimestamp: string | null;
  tableCursors?: Record<string, string>;
  syncIntervalSeconds: number;
}

export interface CloudSyncResult {
  pushedCount: number;
  pulledCount: number;
  conflictsCount: number;
  errors: string[];
  durationMs: number;
  timestamp: string;
}

export interface CompanyProfile {
  nameAr: string;
  nameEn?: string;
  logo?: string;
  address?: string;
  phone?: string;
  email?: string;
  taxNumber?: string;
  currencyCode?: string;
  currency: string;
  currencySymbol: string;
  currencyDecimalPlaces?: number;
  website?: string;
  headerNote?: string;
  footerNote?: string;
}


