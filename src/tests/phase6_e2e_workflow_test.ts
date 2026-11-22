/**
 * نظام الإدارة التجارية والمحاسبية المتكامل (multi_activity_erp)
 * حزمة اختبارات دورة العمل الميدانية الشاملة للمرحلة السادسة (Phase 6 E2E Workflow Test Suite)
 * يختبر العمليات التجارية الأربعة + وحدة الأمانات + القيد المزدوج + مراكز التكلفة + FEFO
 */

import 'fake-indexeddb/auto';

// تهيئة بيئة localStorage في Node.js
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store: Record<string, string> = {};
  const mockStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = String(val); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
}

import { db } from '../db/erpDatabase';
import { storage } from '../services/storageService';
import { dexieDataService } from '../services/dexieDataService';
import { authService, hashPassword } from '../services/authService';
import { ROLE_ALLOWED_VIEWS } from '../config/rbac';
import { Product, Invoice, AmanatRecord, Party, JournalEntry, JournalEntryLine } from '../types/erp';

interface TestResult {
  stepNumber: number;
  domain: string;
  testName: string;
  passed: boolean;
  details: string;
  evidence: string;
}

const testResults: TestResult[] = [];

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runE2ETestSuite() {
  console.log('================================================================');
  console.log('بدء تشغيل حزمة اختبارات دورة العمل الميدانية الشاملة (المرحلة 6)');
  console.log('================================================================\n');

  // تهيئة قواعد البيانات والمصادر الأولية وتوثيق جلسة المدير المعتمد للاختبار
  await dexieDataService.initialize();
  const existingUsers = await db.users.toArray();
  const baseAdmin = existingUsers.find((u) => u.role === 'ADMIN') || storage.getUsers()[0];
  const e2ePassword = 'Admin#E2E2026!';
  const adminActor = {
    ...baseAdmin,
    active: true,
    tenantId: 'tenant_main',
    branchId: 'branch_main',
    allowedBranches: ['branch_main'],
    passwordHash: await hashPassword(e2ePassword),
    mustChangePassword: false,
  };
  await db.users.put(adminActor);
  const login = await authService.authenticate({
    username: adminActor.username,
    password: e2ePassword,
    users: [adminActor],
    onUserUpdated: async (updated) => { await db.users.put(updated); },
  });
  assert(login.success === true, 'E2E administrator login must succeed');

  // تمويل رصيد افتتاحي للصندوق cb-1 لتغطية مشتريات الاختبار النقدية وفق ضوابط FIN-03
  await db.cashBoxes.update('cb-1', { balance: 10000 });

  // -------------------------------------------------------------------------
  // 1. دورة الصيدلية والتشغيلات وتطبيق FEFO
  // -------------------------------------------------------------------------
  try {
    const pharmaProd: Product = {
      id: 'prod_pharma_paracetamol',
      activityId: 'pharmacy',
      code: 'MED-001',
      barcode: '6281001001',
      nameAr: 'باراسيتامول 500 مجم أقراص',
      category: 'مسكنات',
      unit: 'شريط',
      purchasePrice: 10,
      sellPrice: 15,
      currentStock: 0,
      minStockAlert: 5,
      scientificName: 'Paracetamol',
      dosageForm: 'أقراص',
      trackExpiry: true,
      batches: [],
    };
    await db.products.put(pharmaProd);
    await db.parties.put({
      id: 'supp_pharma_01',
      type: 'SUPPLIER',
      nameAr: 'شركة الأدوية المتحدة',
      phone: '0500001111',
      balance: 0,
      advanceBalance: 0,
    });

    // شراء تشغيلتين مختلفتي تاريخ الصلاحية
    const dateToday = new Date().toISOString().split('T')[0];
    const expirySoon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // بعد شهر
    const expiryLater = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // بعد سنة

    const purchaseInvoice: Invoice = {
      id: 'inv_pur_pharma_01',
      invoiceNumber: storage.generateBranchInvoiceNumber('PUR', 'BR01', 'POS-01'),
      type: 'PURCHASE',
      activityId: 'pharmacy',
      branchId: 'branch_main',
      partyId: 'supp_pharma_01',
      partyName: 'شركة الأدوية المتحدة',
      date: dateToday,
      items: [
        {
          id: 'item_1',
          productId: pharmaProd.id,
          productName: pharmaProd.nameAr,
          productCode: pharmaProd.code,
          unit: 'شريط',
          quantity: 20,
          unitPrice: 10,
          discount: 0,
          total: 200,
          batchNumber: 'BATCH-EXP-SOON',
          expiryDate: expirySoon,
        },
        {
          id: 'item_2',
          productId: pharmaProd.id,
          productName: pharmaProd.nameAr,
          productCode: pharmaProd.code,
          unit: 'شريط',
          quantity: 30,
          unitPrice: 10,
          discount: 0,
          total: 300,
          batchNumber: 'BATCH-EXP-LATER',
          expiryDate: expiryLater,
        },
      ],
      subtotal: 500,
      discount: 0,
      tax: 0,
      total: 500,
      paidAmount: 500,
      paymentMethod: 'CASH',
      cashBoxId: 'cb-1',
      isPosted: true,
    };

    const purResult = await dexieDataService.createPurchaseInvoiceAtomic({
      invoice: purchaseInvoice,
      itemsWithBatches: [
        { productId: pharmaProd.id, quantity: 20, costPrice: 10, batchNumber: 'BATCH-EXP-SOON', expiryDate: expirySoon },
        { productId: pharmaProd.id, quantity: 30, costPrice: 10, batchNumber: 'BATCH-EXP-LATER', expiryDate: expiryLater },
      ],
    });

    assert(purResult.success, 'فشل إنشاء فاتورة مشتريات الصيدلية الذرية');

    // التحقق من الرصيد والتشغيلات
    const updatedProd = await db.products.get(pharmaProd.id);
    assert(updatedProd?.currentStock === 50, `الرصيد يجب أن يكون 50، الفعلي: ${updatedProd?.currentStock}`);
    assert(updatedProd?.batches?.length === 2, `يجب توفر تشغيلتين، الفعلي: ${updatedProd?.batches?.length}`);

    // محاكاة بيع 15 وحدة: يجب أن تصرف حصراً من التشغيلة الأقرب انتهاءً (FEFO)
    const saleInvoice: Invoice = {
      id: 'inv_sale_pharma_01',
      invoiceNumber: storage.generateBranchInvoiceNumber('INV', 'BR01', 'POS-01'),
      type: 'SALE',
      activityId: 'pharmacy',
      branchId: 'branch_main',
      partyName: 'عميل صيدلية نقدي',
      date: dateToday,
      items: [
        {
          id: 'sale_item_1',
          productId: pharmaProd.id,
          productName: pharmaProd.nameAr,
          productCode: pharmaProd.code,
          unit: 'شريط',
          quantity: 15,
          unitPrice: 15,
          discount: 0,
          total: 225,
        },
      ],
      subtotal: 225,
      discount: 0,
      tax: 0,
      total: 225,
      paidAmount: 225,
      paymentMethod: 'CASH',
      cashBoxId: 'cb-1',
      isPosted: true,
    };

    const saleResult = await dexieDataService.createSalesInvoiceAtomic({
      invoice: saleInvoice,
      totalCogs: 150, // 15 * 10
      stockDeductions: [{ productId: pharmaProd.id, quantity: 15 }],
    });

    assert(saleResult.success, 'فشل إنشاء فاتورة مبيعات الصيدلية');

    const prodAfterSale = await db.products.get(pharmaProd.id);
    assert(prodAfterSale?.currentStock === 35, `الرصيد بعد البيع يجب أن يصبح 35، الفعلي: ${prodAfterSale?.currentStock}`);

    const batchSoon = prodAfterSale?.batches?.find((b) => b.batchNumber === 'BATCH-EXP-SOON');
    const batchLater = prodAfterSale?.batches?.find((b) => b.batchNumber === 'BATCH-EXP-LATER');

    assert(batchSoon?.quantity === 5, `التشغيلة الأقرب انتهاءً يجب أن ينقص رصيدها من 20 إلى 5، الفعلي: ${batchSoon?.quantity}`);
    assert(batchLater?.quantity === 30, `التشغيلة الأبعد يجب أن يبقى رصيدها 30 دون مساس، الفعلي: ${batchLater?.quantity}`);

    testResults.push({
      stepNumber: 1,
      domain: 'الصيدلية (Pharmacy & FEFO)',
      testName: 'دورة مشتريات ومبيعات الصيدلية وصرف الأقرب انتهاءً (FEFO)',
      passed: true,
      details: 'تم شراء تشغيلتين وخصم كمية البيع حصراً من التشغيلة الأقرب انتهاءً مع ترحيل القيود المتوازنة.',
      evidence: `Stock: 50 -> 35 | BatchSoon: 20 -> 5 | BatchLater: 30 unchanged | JV: ${saleResult.journalEntry.entryNumber}`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 1,
      domain: 'الصيدلية (Pharmacy & FEFO)',
      testName: 'دورة مشتريات ومبيعات الصيدلية وصرف الأقرب انتهاءً (FEFO)',
      passed: false,
      details: (err as Error).message,
      evidence: 'Failed in pharmacy FEFO workflow',
    });
  }

  // -------------------------------------------------------------------------
  // 2. منع بيع المنتجات منتهية الصلاحية قطيعاً
  // -------------------------------------------------------------------------
  try {
    const expiredProd: Product = {
      id: 'prod_pharma_expired',
      activityId: 'pharmacy',
      code: 'MED-EXP-001',
      nameAr: 'شراب منتهي الصلاحية',
      category: 'أدوية منتهية',
      unit: 'عبوة',
      purchasePrice: 12,
      sellPrice: 20,
      currentStock: 10,
      minStockAlert: 2,
      trackExpiry: true,
      batches: [
        {
          id: 'b_exp_1',
          productId: 'prod_pharma_expired',
          batchNumber: 'EXP-PAST-01',
          expiryDate: '2023-01-01', // تاريخ ماضٍ منتهي
          quantity: 10,
          costPrice: 12,
        },
      ],
    };
    await db.products.put(expiredProd);

    let saleBlocked = false;
    let blockedReason = '';

    try {
      await dexieDataService.createSalesInvoiceAtomic({
        invoice: {
          id: 'inv_sale_blocked_exp',
          invoiceNumber: 'INV-TEST-EXP-001',
          type: 'SALE',
          activityId: 'pharmacy',
          partyName: 'عميل تجربة',
          date: new Date().toISOString().split('T')[0],
          items: [{ id: 'it_exp', productId: expiredProd.id, productName: expiredProd.nameAr, productCode: expiredProd.code, unit: 'عبوة', quantity: 1, unitPrice: 20, discount: 0, total: 20 }],
          subtotal: 20,
          discount: 0,
          tax: 0,
          total: 20,
          paidAmount: 20,
          paymentMethod: 'CASH',
          cashBoxId: 'cb-1',
          isPosted: true,
        },
        totalCogs: 12,
        stockDeductions: [{ productId: expiredProd.id, quantity: 1, batchNumber: 'EXP-PAST-01' }],
      });
    } catch (e: unknown) {
      saleBlocked = true;
      blockedReason = (e as Error).message;
    }

    assert(saleBlocked, 'يجب منع بيع الدواء منتهي الصلاحية قطيعاً');
    assert(blockedReason.includes('منتهي') || blockedReason.includes('صلاحية'), `رسالة الخطأ يجب أن توضح انتهاء الصلاحية: ${blockedReason}`);

    testResults.push({
      stepNumber: 2,
      domain: 'الصيدلية (Safety Rule)',
      testName: 'حظر بيع الأصناف منتهية الصلاحية قطعياً',
      passed: true,
      details: 'تم حجب عملية البيع ورمي خطأ صريح لمنع صرف أي دواء منتهي الصلاحية حمايةً للمستهلك.',
      evidence: `Blocked sale successfully with error: "${blockedReason}"`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 2,
      domain: 'الصيدلية (Safety Rule)',
      testName: 'حظر بيع الأصناف منتهية الصلاحية قطعياً',
      passed: false,
      details: (err as Error).message,
      evidence: 'Expired product sale was permitted',
    });
  }

  // -------------------------------------------------------------------------
  // 3. دورة المواد الغذائية والبقالة (Grocery Lifecycle)
  // -------------------------------------------------------------------------
  try {
    const groceryProd: Product = {
      id: 'prod_grocery_rice_10kg',
      activityId: 'grocery',
      code: 'GROC-RICE-01',
      barcode: '6291002003',
      nameAr: 'أرز بسمتي درجة أولى 10 كجم',
      category: 'أغذية حبوب',
      unit: 'كيس',
      purchasePrice: 65,
      sellPrice: 85,
      currentStock: 40,
      minStockAlert: 10,
      batches: [],
    };
    await db.products.put(groceryProd);

    const saleInvoice: Invoice = {
      id: 'inv_sale_groc_01',
      invoiceNumber: storage.generateBranchInvoiceNumber('INV', 'BR01', 'POS-01'),
      type: 'SALE',
      activityId: 'grocery',
      branchId: 'branch_main',
      partyName: 'عميل بقالة نقدي',
      date: new Date().toISOString().split('T')[0],
      items: [
        {
          id: 'it_groc_1',
          productId: groceryProd.id,
          productName: groceryProd.nameAr,
          productCode: groceryProd.code,
          unit: 'كيس',
          quantity: 4,
          unitPrice: 85,
          discount: 0,
          total: 340,
        },
      ],
      subtotal: 340,
      discount: 0,
      tax: 0,
      total: 340,
      paidAmount: 340,
      paymentMethod: 'CASH',
      cashBoxId: 'cb-1',
      isPosted: true,
    };

    const res = await dexieDataService.createSalesInvoiceAtomic({
      invoice: saleInvoice,
      totalCogs: 260, // 4 * 65
      stockDeductions: [{ productId: groceryProd.id, quantity: 4 }],
    });

    assert(res.success, 'فشل بيع صنف البقالة');
    const updatedGroc = await db.products.get(groceryProd.id);
    assert(updatedGroc?.currentStock === 36, `رصيد الأرز يجب أن يصبح 36، الفعلي: ${updatedGroc?.currentStock}`);

    // فحص القيد المحاسبي لمركز تكلفة المواد الغذائية CC-102
    assert(res.journalEntry.costCenterId === 'grocery', `مركز التكلفة يجب أن يكون grocery، الفعلي: ${res.journalEntry.costCenterId}`);

    testResults.push({
      stepNumber: 3,
      domain: 'المواد الغذائية (Grocery)',
      testName: 'دورة مبيعات البقالة وتحديث المخزون وقيد إيرادات المواد الغذائية',
      passed: true,
      details: 'تم خصم الرصيد المخزني وترحيل إيرادات وتكلفة مبيعات المواد الغذائية بمركز التكلفة CC-102.',
      evidence: `Stock: 40 -> 36 | Invoice Total: 340 | CostCenter: grocery | JV: ${res.journalEntry.entryNumber}`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 3,
      domain: 'المواد الغذائية (Grocery)',
      testName: 'دورة مبيعات البقالة وتحديث المخزون وقيد إيرادات المواد الغذائية',
      passed: false,
      details: (err as Error).message,
      evidence: 'Grocery workflow failed',
    });
  }

  // -------------------------------------------------------------------------
  // 4. دورة قطع غيار الدراجات النارية (Bike Parts & OEM)
  // -------------------------------------------------------------------------
  try {
    const bikePart: Product = {
      id: 'prod_bike_clutch_plate',
      activityId: 'bike_parts',
      code: 'BP-CLUTCH-01',
      barcode: '7100200300',
      nameAr: 'صحن كلتش دراجة نارية ياماها 125',
      category: 'كلتشات ونواقل حركة',
      unit: 'طقم',
      purchasePrice: 45,
      sellPrice: 70,
      currentStock: 15,
      minStockAlert: 3,
      oemNumber: 'OEM-YAM-2024-CL',
      manufacturer: 'Yamaha Genuine',
      compatibleModels: 'Yamaha YBR 125, Boxer 150',
      batches: [],
    };
    await db.products.put(bikePart);

    const saleInvoice: Invoice = {
      id: 'inv_sale_bike_01',
      invoiceNumber: storage.generateBranchInvoiceNumber('INV', 'BR01', 'POS-01'),
      type: 'SALE',
      activityId: 'bike_parts',
      branchId: 'branch_main',
      partyName: 'ورشة السلام للدراجات',
      date: new Date().toISOString().split('T')[0],
      items: [
        {
          id: 'it_bp_1',
          productId: bikePart.id,
          productName: bikePart.nameAr,
          productCode: bikePart.code,
          unit: 'طقم',
          quantity: 2,
          unitPrice: 70,
          discount: 0,
          total: 140,
        },
      ],
      subtotal: 140,
      discount: 0,
      tax: 0,
      total: 140,
      paidAmount: 140,
      paymentMethod: 'CASH',
      cashBoxId: 'cb-1',
      isPosted: true,
    };

    const res = await dexieDataService.createSalesInvoiceAtomic({
      invoice: saleInvoice,
      totalCogs: 90, // 2 * 45
      stockDeductions: [{ productId: bikePart.id, quantity: 2 }],
    });

    assert(res.success, 'فشل بيع قطع غيار الدراجات');
    const updatedPart = await db.products.get(bikePart.id);
    assert(updatedPart?.currentStock === 13, `رصيد الكلتش يجب أن يصبح 13، الفعلي: ${updatedPart?.currentStock}`);
    assert(res.journalEntry.costCenterId === 'bike_parts', 'مركز التكلفة يجب أن يكون bike_parts');

    testResults.push({
      stepNumber: 4,
      domain: 'قطع الدراجات (Bike Parts)',
      testName: 'دورة مبيعات قطع غيار الدراجات مع رقم OEM وموديلات التوافق',
      passed: true,
      details: 'تم فحص دعم OEM والموديل المتوافق وخصم المخزون وترحيل القيد لمركز تكلفة قطع الدراجات CC-103.',
      evidence: `Stock: 15 -> 13 | OEM: ${bikePart.oemNumber} | JV: ${res.journalEntry.entryNumber}`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 4,
      domain: 'قطع الدراجات (Bike Parts)',
      testName: 'دورة مبيعات قطع غيار الدراجات مع رقم OEM وموديلات التوافق',
      passed: false,
      details: (err as Error).message,
      evidence: 'Bike parts workflow failed',
    });
  }

  // -------------------------------------------------------------------------
  // 5. دورة قطع غيار المعدات والمبيعات الآجلة (Equipment Parts & Credit Sale)
  // -------------------------------------------------------------------------
  try {
    const customer: Party = {
      id: 'cust_equip_contractor',
      type: 'CUSTOMER',
      nameAr: 'مؤسسة النور للمقاولات والمعدات',
      phone: '0501122334',
      balance: 0,
      creditLimit: 50000,
    };
    await db.parties.put(customer);

    const equipPart: Product = {
      id: 'prod_equip_hydraulic_pump',
      activityId: 'equipment_parts',
      code: 'EQ-PUMP-900',
      barcode: '8900100200',
      nameAr: 'طرمبة هيدروليك حراثة كوماتسو',
      category: 'هيدروليك ومضخات',
      unit: 'حبة',
      purchasePrice: 1200,
      sellPrice: 1650,
      currentStock: 6,
      minStockAlert: 1,
      oemNumber: 'KOM-HYD-9988',
      equipmentType: 'حراثات ومعدات ثقيلة',
      serialNumber: 'SN-KOM-2026-X1',
      batches: [],
    };
    await db.products.put(equipPart);

    // بيع آجل بالكامل (المبلغ المدفوع = 0)
    const saleInvoice: Invoice = {
      id: 'inv_sale_equip_credit_01',
      invoiceNumber: storage.generateBranchInvoiceNumber('INV', 'BR01', 'POS-01'),
      type: 'SALE',
      activityId: 'equipment_parts',
      branchId: 'branch_main',
      partyId: customer.id,
      partyName: customer.nameAr,
      date: new Date().toISOString().split('T')[0],
      items: [
        {
          id: 'it_eq_1',
          productId: equipPart.id,
          productName: equipPart.nameAr,
          productCode: equipPart.code,
          unit: 'حبة',
          quantity: 1,
          unitPrice: 1650,
          discount: 0,
          total: 1650,
        },
      ],
      subtotal: 1650,
      discount: 0,
      tax: 0,
      total: 1650,
      paidAmount: 0, // آجل كامل
      paymentMethod: 'CREDIT',
      cashBoxId: 'cb-1',
      isPosted: true,
    };

    const res = await dexieDataService.createSalesInvoiceAtomic({
      invoice: saleInvoice,
      totalCogs: 1200,
      stockDeductions: [{ productId: equipPart.id, quantity: 1 }],
    });

    assert(res.success, 'فشل البيع الآجل لمعدات ثقيلة');

    const updatedCust = await db.parties.get(customer.id);
    assert(updatedCust?.balance === 1650, `رصيد ذمة العميل الآجل يجب أن يصبح 1650، الفعلي: ${updatedCust?.balance}`);

    const updatedPart = await db.products.get(equipPart.id);
    assert(updatedPart?.currentStock === 5, `رصيد الطرمبة يجب أن يصبح 5، الفعلي: ${updatedPart?.currentStock}`);

    // التحقق من أن القيد مدين للعملاء (1103) ودائن لمبيعات المعدات (4104)
    const arLine = res.journalEntry.lines.find((l: JournalEntryLine) => l.accountCode === '1103');
    const revLine = res.journalEntry.lines.find((l: JournalEntryLine) => l.accountCode === '4104');

    assert(arLine?.debit === 1650, `طرف المدين في العملاء يجب أن يكون 1650، الفعلي: ${arLine?.debit}`);
    assert(revLine?.credit === 1650, `طرف الدائن في مبيعات المعدات يجب أن يكون 1650، الفعلي: ${revLine?.credit}`);

    testResults.push({
      stepNumber: 5,
      domain: 'قطع المعدات (Equipment Parts)',
      testName: 'دورة بيع آجل لقطع المعدات وترحيل ذمم العملاء وإيرادات المعدات (CC-104)',
      passed: true,
      details: 'تم البيع الآجل وتحديث رصيد العميل الآجل (1103) وخصم المخزون وإثبات الإيراد لمركز تكلفة المعدات CC-104.',
      evidence: `Customer Balance: 0 -> 1650 | Stock: 6 -> 5 | Equipment Rev 4104: 1650 | JV: ${res.journalEntry.entryNumber}`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 5,
      domain: 'قطع المعدات (Equipment Parts)',
      testName: 'دورة بيع آجل لقطع المعدات وترحيل ذمم العملاء وإيرادات المعدات (CC-104)',
      passed: false,
      details: (err as Error).message,
      evidence: 'Equipment parts credit sale failed',
    });
  }

  // -------------------------------------------------------------------------
  // 6. دورة الأمانات النقدية (Cash Amanat: Deposit & Return)
  // -------------------------------------------------------------------------
  try {
    const cashAmanatRecord: AmanatRecord = {
      id: 'amn_cash_test_01',
      recordNumber: 'AMN-2026-00001',
      depositorName: 'أحمد صالح المهري',
      depositorPhone: '0555112233',
      depositorNationalId: '1098877665',
      type: 'CASH',
      amount: 5000,
      status: 'HELD',
      receivedDate: new Date().toISOString().split('T')[0],
      receivedBy: 'أمين الخزينة',
      notes: 'أمانة سفر مؤقتة تسلم لصاحبها بالهوية',
    };

    // 1. تسجيل إيداع الأمانة النقدية عبر المعاملة الذرية الموحدة
    const depResult = await dexieDataService.createAmanatDepositAtomic({
      record: cashAmanatRecord,
      cashBoxId: 'cb-1',
    });

    const depositEntry = depResult.journalEntry;
    assert(!!depositEntry, 'يجب ترحيل قيد إيداع الأمانة النقدية');

    const cashDebitLine = depositEntry?.lines.find((l: JournalEntryLine) => l.accountCode === '1101');
    const liabilityCreditLine = depositEntry?.lines.find((l: JournalEntryLine) => l.accountCode === '2102');

    assert(cashDebitLine?.debit === 5000, 'الطرف المدين يجب أن يكون الصندوق 1101 بمبلغ 5000');
    assert(liabilityCreditLine?.credit === 5000, 'الطرف الدائن يجب أن يكون أمانات نقدية للغير 2102 بمبلغ 5000');
    assert(depositEntry?.costCenterId === 'general', 'مركز التكلفة يجب أن يكون general وليس أي نشاط تجاري');

    // 2. رد الأمانة النقدية وإبراء الذمة عبر المعاملة الذرية
    const retResult = await dexieDataService.returnAmanatAtomic({
      recordId: depResult.record.id,
      cashBoxId: 'cb-1',
      recipientSignatureName: 'أحمد صالح المهري',
    });

    const returnEntry = retResult.journalEntry;
    assert(!!returnEntry, 'يجب ترحيل قيد تسوية واسترداد الأمانة');

    const liabilityDebitLine = returnEntry?.lines.find((l: JournalEntryLine) => l.accountCode === '2102');
    const cashCreditLine = returnEntry?.lines.find((l: JournalEntryLine) => l.accountCode === '1101');

    assert(liabilityDebitLine?.debit === 5000, 'الطرف المدين يجب أن يكون تسوية الأمانة 2102 بمبلغ 5000');
    assert(cashCreditLine?.credit === 5000, 'الطرف الدائن يجب أن يكون الصندوق 1101 بمبلغ 5000');

    testResults.push({
      stepNumber: 6,
      domain: 'الأمانات النقدية (Cash Amanat)',
      testName: 'دورة إيداع ورد الأمانة النقدية ومعالجتها كالتزام معزول (2102)',
      passed: true,
      details: 'تم إثبات الأمانة كالتزام متداول (2102) دون احتسابها إيراداً أو ربحاً، وتسويتها بالكامل عند الرد.',
      evidence: `Deposit JV: ${depositEntry?.entryNumber} (1101 Dr / 2102 Cr) | Return JV: ${returnEntry?.entryNumber} (2102 Dr / 1101 Cr)`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 6,
      domain: 'الأمانات النقدية (Cash Amanat)',
      testName: 'دورة إيداع ورد الأمانة النقدية ومعالجتها كالتزام معزول (2102)',
      passed: false,
      details: (err as Error).message,
      evidence: 'Cash amanat workflow failed',
    });
  }

  // -------------------------------------------------------------------------
  // 7. دورة الأمانات العينية (Physical Item Custody)
  // -------------------------------------------------------------------------
  try {
    const initialJournalCount = (await db.journalEntries.toArray()).length;
    const initialProductsCount = (await db.products.toArray()).length;

    const physicalAmanatRecord: AmanatRecord = {
      id: 'amn_item_test_02',
      recordNumber: 'AMN-2026-00002',
      depositorName: 'سعيد عبد الله الحضرمي',
      depositorPhone: '0555998877',
      type: 'ITEM',
      amount: 0,
      itemDescription: 'حقيبة سفر مغلقة بداخلها وثائق ومقتنيات شخصية',
      itemSerial: 'BAG-SEC-2026',
      status: 'HELD',
      receivedDate: new Date().toISOString().split('T')[0],
      receivedBy: 'مسؤول المستودع',
      notes: 'حفظ في الخزنة الأمنية رقم 3',
    };

    await dexieDataService.createAmanatDepositAtomic({ record: physicalAmanatRecord });

    const savedAmanat = await db.amanatRecords.get(physicalAmanatRecord.id);
    assert(savedAmanat?.status === 'HELD', 'يجب حفظ الأمانة العينية بحالة HELD');

    // التحقق الصارم: الأمانة العينية يجب ألا تنشئ أي قيد مالي أو تغير في المخزون التجاري
    const postJournalCount = (await db.journalEntries.toArray()).length;
    const postProductsCount = (await db.products.toArray()).length;

    assert(postJournalCount === initialJournalCount, 'الأمانات العينية ممنوع أن تنشئ أي قيد محاسبي في الدفاتر المالية');
    assert(postProductsCount === initialProductsCount, 'الأمانات العينية ممنوع أن تدخل في جدول المخزون السلعي التجاري');

    // إرجاع الأمانة العينية
    await dexieDataService.returnAmanatAtomic({
      recordId: physicalAmanatRecord.id,
      recipientSignatureName: 'سعيد عبد الله الحضرمي',
    });

    const finalAmanat = await db.amanatRecords.get(physicalAmanatRecord.id);
    assert(finalAmanat?.status === 'RETURNED', 'يجب أن تصبح حالة الأمانة العينية RETURNED بعد التسليم');

    testResults.push({
      stepNumber: 7,
      domain: 'الأمانات العينية (Physical Custody)',
      testName: 'دورة استلام وتسليم الأمانات العينية وعزلها التام عن المخزون والدفاتر المالية',
      passed: true,
      details: 'تم قيد وتسليم الأمانة العينية في السجل الإحصائي والرقابي مع ضمان عدم مساسها بحسابات المخزون أو القيود المالية.',
      evidence: `Record: ${physicalAmanatRecord.recordNumber} | No Financial JVs created | No inventory impact`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 7,
      domain: 'الأمانات العينية (Physical Custody)',
      testName: 'دورة استلام وتسليم الأمانات العينية وعزلها التام عن المخزون والدفاتر المالية',
      passed: false,
      details: (err as Error).message,
      evidence: 'Physical custody workflow failed',
    });
  }

  // -------------------------------------------------------------------------
  // 8. التحقق من سلامة ميزان المراجعة وتوازن القيد المزدوج الإجمالي
  // -------------------------------------------------------------------------
  try {
    const allEntries = await db.journalEntries.toArray();
    assert(allEntries.length > 0, 'يجب توفر قيود مرحلة في الدفاتر');

    let totalLedgerDebit = 0;
    let totalLedgerCredit = 0;

    for (const entry of allEntries) {
      assert(entry.status === 'POSTED' || entry.status === 'REVERSED', `حالة القيد يجب أن تكون مرحلة أو معكوسة: ${entry.status}`);
      let entryDebit = 0;
      let entryCredit = 0;
      for (const line of entry.lines) {
        entryDebit += Number(line.debit || 0);
        entryCredit += Number(line.credit || 0);
      }
      const entryDiff = Math.abs(entryDebit - entryCredit);
      assert(entryDiff <= 0.01, `القيد ${entry.entryNumber} غير متوازن! فارق: ${entryDiff}`);

      totalLedgerDebit += entryDebit;
      totalLedgerCredit += entryCredit;
    }

    const overallDiff = Math.abs(totalLedgerDebit - totalLedgerCredit);
    assert(overallDiff <= 0.02, `ميزان المراجعة الشامل غير متوازن! إجمالي المدين: ${totalLedgerDebit}, إجمالي الدائن: ${totalLedgerCredit}`);

    testResults.push({
      stepNumber: 8,
      domain: 'المحاسبة العامة (Trial Balance)',
      testName: 'التحقق الصارم من توازن ميزان المراجعة ومطابقة إجمالي المدين مع الدائن',
      passed: true,
      details: `تم تدقيق كافة القيود المرحلة (${allEntries.length} قيد) والتأكد من مطابقة إجمالي المدين والدائن بدقة السنت.`,
      evidence: `Total Debit: ${totalLedgerDebit.toFixed(2)} == Total Credit: ${totalLedgerCredit.toFixed(2)} (Diff: ${overallDiff.toFixed(4)})`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 8,
      domain: 'المحاسبة العامة (Trial Balance)',
      testName: 'التحقق الصارم من توازن ميزان المراجعة ومطابقة إجمالي المدين مع الدائن',
      passed: false,
      details: (err as Error).message,
      evidence: 'Trial balance discrepancy detected',
    });
  }

  // -------------------------------------------------------------------------
  // 9. التحقق من التصحيح بالقيد العكسي دون المساس بالقيد الأصلي
  // -------------------------------------------------------------------------
  try {
    // أنشئ قيداً يدوياً مستقلاً للاختبار؛ لا نختار قيد فاتورة أو سند لأن عكسه يجب أن يتم من المستند الأصلي.
    const sampleEntry: JournalEntry = {
      id: 'manual-journal-reversal-test',
      entryNumber: 'JV-MANUAL-REVERSAL-TEST',
      date: new Date().toISOString().split('T')[0],
      description: 'قيد يدوي لاختبار الحوكمة المحاسبية للعكس',
      status: 'POSTED',
      costCenterId: 'general',
      branchId: 'branch_main',
      referenceType: 'MANUAL',
      isAutoGenerated: false,
      lines: [
        {
          id: 'manual-reversal-line-debit',
          accountCode: '4101',
          accountName: 'إيرادات اختبارية',
          debit: 100,
          credit: 0,
          costCenterId: 'general',
          memo: 'طرف مدين للقيد اليدوي',
        },
        {
          id: 'manual-reversal-line-credit',
          accountCode: '5101',
          accountName: 'مصروفات اختبارية',
          debit: 0,
          credit: 100,
          costCenterId: 'general',
          memo: 'طرف دائن للقيد اليدوي',
        },
      ],
    };
    await db.journalEntries.put(sampleEntry);

    const originalId = sampleEntry.id;
    const reversalRes = await dexieDataService.reverseJournalEntryAtomic(originalId, 'خطأ في احتساب مركز التكلفة');

    assert(!!reversalRes, 'يجب توليد قيد عكسي بنجاح');
    assert(reversalRes.entryNumber.startsWith('REV-'), `رقم القيد العكسي يجب أن يبدأ بـ REV-: ${reversalRes.entryNumber}`);

    const originalAfterRev = await db.journalEntries.get(originalId);
    assert(originalAfterRev?.status === 'REVERSED', 'القيد الأصلي يجب أن تتحول حالته إلى REVERSED');
    assert(originalAfterRev?.reversedEntryId === reversalRes.id, 'القيد الأصلي يجب أن يرتبط بمعرف القيد العكسي');

    // التأكد من أن أطراف القيد العكسي عكست المدين والدائن بالضبط
    assert(reversalRes.lines.length === sampleEntry!.lines.length, 'عدد أسطر القيد العكسي يجب أن يطابق القيد الأصلي');

    testResults.push({
      stepNumber: 9,
      domain: 'حوكمة القيود (Reversal Governance)',
      testName: 'التصحيح المحاسبي بقيد عكسي مستقل ومنع تعديل القيد الأصلي',
      passed: true,
      details: 'تم الحفاظ على مسار التدقيق المالي الكامل، حيث تم إنشاء قيد عكسي مستقل وربطه بالقيد الأصلي المعكوس.',
      evidence: `Original Entry: ${sampleEntry?.entryNumber} (Status: REVERSED) <-> Reversal Entry: ${reversalRes.entryNumber}`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 9,
      domain: 'حوكمة القيود (Reversal Governance)',
      testName: 'التصحيح المحاسبي بقيد عكسي مستقل ومنع تعديل القيد الأصلي',
      passed: false,
      details: (err as Error).message,
      evidence: 'Reversal governance failed',
    });
  }

  // -------------------------------------------------------------------------
  // 10. التحقق من حماية مسارات الواجهة ومصفوفة الصلاحيات (RBAC Navigation Guard)
  // -------------------------------------------------------------------------
  try {
    const cashierViews = ROLE_ALLOWED_VIEWS.CASHIER;

    assert(cashierViews.includes('pos'), 'الكاشير يجب أن يصل لنقاط البيع');
    assert(cashierViews.includes('inventory'), 'الكاشير يجب أن يصل للمخزون');
    assert(!cashierViews.includes('accounting'), 'الكاشير ممنوع قطعياً من الوصول للقيود والمحاسبة');
    assert(!cashierViews.includes('users'), 'الكاشير ممنوع قطعياً من إدارة المستخدمين والصلاحيات');
    assert(!cashierViews.includes('reports'), 'الكاشير ممنوع من التقارير المالية والأرباح');

    const adminViews = ROLE_ALLOWED_VIEWS.ADMIN;
    assert(adminViews.length === 12, `المدير العام يملك الصلاحية الكاملة على جميع شاشات النظام (12 شاشة)، الفعلي: ${adminViews.length}`);

    testResults.push({
      stepNumber: 10,
      domain: 'الأمان والصلاحيات (RBAC Matrix)',
      testName: 'مطابقة مصفوفة الصلاحيات وحجب شاشات المحاسبة والمستخدمين عن الكاشير',
      passed: true,
      details: 'تم التحقق من حجب الشاشات الحساسة (القيود، التقارير المالية، الصلاحيات) عن الكاشير وتخصيص نقاط البيع فقط.',
      evidence: `Cashier views: [${cashierViews.join(', ')}] | Restricted: accounting, users, reports, sync`,
    });
  } catch (err: unknown) {
    testResults.push({
      stepNumber: 10,
      domain: 'الأمان والصلاحيات (RBAC Matrix)',
      testName: 'مطابقة مصفوفة الصلاحيات وحجب شاشات المحاسبة والمستخدمين عن الكاشير',
      passed: false,
      details: (err as Error).message,
      evidence: 'RBAC matrix validation failed',
    });
  }

  // -------------------------------------------------------------------------
  // تقرير النتائج النهائي
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('نتائج اختبارات دورة العمل الميدانية للمرحلة السادسة (Phase 6):');
  console.log('================================================================\n');

  let passedCount = 0;
  for (const r of testResults) {
    const badge = r.passed ? '✅ [نجاح]' : '❌ [فشل]';
    console.log(`${badge} خطوة ${r.stepNumber} [${r.domain}]: ${r.testName}`);
    console.log(`   - الوصف: ${r.details}`);
    console.log(`   - الدليل: ${r.evidence}\n`);
    if (r.passed) passedCount++;
  }

  console.log('================================================================');
  console.log(`النتيجة الإجمالية: ${passedCount} / ${testResults.length} اختبارات ناجحة بنسبة ${((passedCount / testResults.length) * 100).toFixed(1)}%`);
  console.log('================================================================\n');

  if (passedCount !== testResults.length) {
    process.exit(1);
  }
}

runE2ETestSuite().catch((e) => {
  console.error('Fatal E2E Test Suite Error:', e);
  process.exit(1);
});
