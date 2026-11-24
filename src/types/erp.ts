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
  isActive?: boolean;          // حالة الصنف (نشط أو مؤرشف/معطل حفاظاً على السجل المالي)
  updatedAt?: string;          // تاريخ آخر تحديث ISO
}

export type ProductImageSyncStatus = 'LOCAL_ONLY' | 'PENDING_UPLOAD' | 'UPLOADING' | 'SYNCED' | 'FAILED';

export interface ProductImage {
  id: string;
  tenantId: string;
  productId: string;
  activityId: CommercialActivityId;
  storageKey: string;
  thumbnailStorageKey: string;
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  thumbnailSizeBytes: number;
  width: number;
  height: number;
  checksumSha256: string;
  isPrimary: boolean;
  sortOrder: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: ProductImageSyncStatus;
  isDeleted?: boolean;
}

/** Local-only binary cache. These fields must never enter Outbox or cloud metadata. */
export interface ProductImageLocalAsset extends ProductImage {
  originalBlob?: Blob;
  thumbnailBlob?: Blob;
}

export type AmanatType = 'CASH' | 'ITEM';
export type AmanatStatus = 'HELD' | 'RETURNED' | 'CANCELLED';

export interface AmanatReturnEvent {
  id: string;
  date: string;
  amount: number;
  cashBoxId?: string;
  journalEntryId?: string;
  recipientSignatureName?: string;
  notes?: string;
  createdBy?: string;
  createdByName?: string;
}

export interface AmanatRecord {
  id: string;                   // UUID v4
  branchId?: string;            // الفرع المالك لسجل الأمانة
  recordNumber: string;         // رقم سند الأمانة (AMN-YYYY-XXXXX)
  depositorName: string;        // اسم المودع
  depositorPhone: string;       // رقم الهاتف
  depositorNationalId?: string; // رقم الهوية إن وجد
  type: AmanatType;             // نقدية أم عينية
  amount: number;               // المبلغ الإجمالي للأمانة النقدية
  returnedAmount?: number;      // إجمالي المبلغ المردود حتى الآن
  remainingAmount?: number;     // المتبقي من الأمانة النقدية
  returnHistory?: AmanatReturnEvent[]; // سجل دفعات الرد الجزئي/الكلي
  cashBoxId?: string;           // الصندوق المحفوظ به إن كانت نقدية
  itemDescription?: string;     // وصف الصنف العيني ومواصفاته
  itemSerial?: string;          // الرقم التسلسلي للصنف العيني
  storageLocation?: string;     // موقع الحفظ (الخزنة / الرف)
  status: AmanatStatus;         // محفوظة، مستردة، ملغاة
  receivedDate: string;         // تاريخ الاستلام
  expectedReturnDate?: string;  // تاريخ الإرجاع المتوقع
  returnedDate?: string;        // تاريخ الإرجاع النهائي الفعلي
  cancelledDate?: string;       // تاريخ الإلغاء
  cancelledReason?: string;     // سبب الإلغاء الموثق
  receivedBy: string;           // الموظف المستلم
  recipientSignatureName?: string; // اسم وتوقيع المستلم عند الإرجاع
  notes?: string;               // ملاحظات الحفظ
  journalEntryId?: string;      // معرّف القيد المحاسبي للإيداع (للأمانات النقدية فقط)
  returnJournalEntryId?: string; // معرّف آخر قيد رد/عكس أمانة
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
  advanceBalance?: number;  // الرصيد المقدم المتاح (التزام دفعات عملاء 2103 أو أصل سلف موردين 1105)
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
  dueDate?: string;         // تاريخ الاستحقاق للفواتير الآجلة
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  tax: number;
  shippingCost?: number;    // مصاريف شحن/توصيل إضافية للمشتريات
  total: number;
  paidAmount: number;       // إجمالي المسدد على الفاتورة (نقداً + دفعة مقدمة + سندات مخصصة)
  advanceAppliedAmount?: number; // المبلغ المسوّى من الرصيد المقدم عند إنشاء الفاتورة
  paymentMethod: PaymentMethod;
  cashBoxId: string;
  notes?: string;
  journalEntryId?: string;
  isPosted?: boolean;
  status?: 'POSTED' | 'REVERSED';
  reversedByJournalId?: string;
  reversalReason?: string;
  originalInvoiceId?: string;     // معرف الفاتورة الأصلية في حالة المرتجع
  originalInvoiceNumber?: string; // رقم الفاتورة الأصلية في حالة المرتجع
  returnReason?: string;          // سبب المرتجع الموثق
  returnedAmount?: number;        // إجمالي المبالغ المخصومة/المرتجعة المرتبطة بالفاتورة الأصلية
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
  cashBoxId?: string;       // معرف الصندوق الفعلي عند الترحيل على حساب نقدي
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
  referenceType?: 'INVOICE' | 'VOUCHER' | 'MANUAL' | 'AMANAT' | 'ADVANCE_SETTLEMENT' | 'VOUCHER_REVERSAL' | 'INVENTORY';
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
export type VoucherStatus = 'DRAFT' | 'POSTED' | 'CANCELLED' | 'REVERSED';
export type VoucherAllocationMode = 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT' | 'GENERAL';
export type VoucherPaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHECK';

export interface VoucherManualAllocationInput {
  invoiceId: string;
  allocatedAmount: number;
}

export interface PaymentAllocation {
  id: string;
  tenantId?: string;
  branchId?: string;
  voucherId?: string;
  advanceTransactionId?: string;
  partyId: string;
  invoiceId: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  allocatedAmount: number;
  allocationMethod: 'FIFO' | 'MANUAL' | 'ADVANCE_SETTLEMENT';
  status: 'ACTIVE' | 'REVERSED';
  createdAt: string;
  createdBy?: string;
}

export interface PartyAdvanceTransaction {
  id: string;
  tenantId?: string;
  branchId?: string;
  partyId: string;
  partyType: PartyType;
  type: 'OVERPAYMENT_DEPOSIT' | 'PREPAYMENT_DEPOSIT' | 'APPLY_TO_INVOICE' | 'REFUND' | 'REVERSAL';
  amount: number;           // موجب للإيداع، سالب للاستخدام أو العكس أو الرد
  balanceAfter: number;
  voucherId?: string;
  invoiceId?: string;
  journalEntryId?: string;
  date: string;
  description: string;
  createdBy?: string;
  createdAt: string;
}

export interface AllocationAudit {
  id: string;
  tenantId?: string;
  branchId?: string;
  voucherId: string;
  partyId: string;
  userId: string;
  userName: string;
  reason: string;
  previousAllocations: Array<{ invoiceId: string; invoiceNumber?: string; allocatedAmount: number }>;
  newAllocations: Array<{ invoiceId: string; invoiceNumber?: string; allocatedAmount: number }>;
  timestamp: string;
}

export interface PaymentVoucher {
  id: string;               // UUID v4
  voucherNumber: string;
  type: VoucherType;
  voucherMode?: VoucherAllocationMode;
  date: string;
  amount: number;
  cashBoxId: string;
  branchId?: string;        // معرف الفرع
  partyId?: string;
  partyType?: PartyType;
  partyName: string;
  accountCode: string;
  paymentMethod?: VoucherPaymentMethod;
  externalRef?: string;
  description: string;
  costCenterId: CostCenterId;
  journalEntryId?: string;
  status?: VoucherStatus;
  reversedByJournalId?: string;
  reversedVoucherId?: string;
  reversalReason?: string;
  cancelledReason?: string;
  appliedToDebtAmount?: number;
  advanceAmount?: number;
  allocations?: PaymentAllocation[];
  manualAllocations?: VoucherManualAllocationInput[];
  manualOverride?: boolean;
  overrideReason?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt?: string;
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
  entityType?: string;
  entityId?: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
  result?: 'SUCCESS' | 'FAILURE';
}

export interface OutboxQueueItem {
  id: string;               // UUID v4
  tenantId: string;         // معرّف المؤسسة / المستأجر لضمان عزل البيانات
  branchId?: string;        // معرف الفرع
  entityType:
    | 'INVOICE'
    | 'JOURNAL_ENTRY'
    | 'PRODUCT'
    | 'AMANAT'
    | 'VOUCHER'
    | 'PARTY'
    | 'ACCOUNT'
    | 'CASHBOX'
    | 'BRANCH'
    | 'PAYMENT_ALLOCATION'
    | 'PARTY_ADVANCE'
    | 'ALLOCATION_AUDIT'
    | 'PRODUCT_IMAGE';
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
  supabaseAccessToken?: string;
  supabaseAuthEmail?: string;
  supabaseTokenExpiresAt?: string;
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


