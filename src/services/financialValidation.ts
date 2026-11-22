/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك التحقق المالي المركزي (Central Financial Validation Engine - FIN-03)
 * يفرض سلامة الكميات والأسعار والخصومات والمدفوعات والصناديق والقيود في طبقة الخدمات
 */

import { roundMoney } from '../config/currency';
import {
  Account,
  AmanatRecord,
  CashBox,
  Invoice,
  JournalEntry,
  PaymentVoucher,
  Product,
} from '../types/erp';

export class FinancialValidationError extends Error {
  public readonly code = 'FINANCIAL_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'FinancialValidationError';
  }
}

function isFinitePositive(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

function isFiniteNonNegative(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

export function validateSalesInvoiceInput(params: {
  invoice: Invoice;
  totalCogs: number;
  stockDeductions: Array<{ productId: string; quantity: number; batchNumber?: string }>;
  cashBox?: CashBox | null;
  applyAdvanceAmount?: number;
}): void {
  const { invoice, totalCogs, stockDeductions, cashBox, applyAdvanceAmount = 0 } = params;

  if (!invoice || !invoice.items || invoice.items.length === 0) {
    throw new FinancialValidationError('فاتورة المبيعات يجب أن تحتوي على صنف واحد على الأقل.');
  }
  if (!stockDeductions || stockDeductions.length === 0) {
    throw new FinancialValidationError('بنود خصم المخزون مطلوبة لإتمام فاتورة المبيعات.');
  }

  for (const item of invoice.items) {
    if (!isFinitePositive(item.quantity)) {
      throw new FinancialValidationError(`كمية الصنف (${item.productName}) يجب أن تكون أكبر من الصفر.`);
    }
    if (!isFiniteNonNegative(item.unitPrice) || !isFiniteNonNegative(item.discount)) {
      throw new FinancialValidationError(`السعر والخصم للصنف (${item.productName}) يجب ألا يكونا قيمتين سالبتين.`);
    }
    const lineGross = roundMoney(item.quantity * item.unitPrice);
    if (item.discount > lineGross + 0.01) {
      throw new FinancialValidationError(`خصم الصنف (${item.productName}) يتجاوز قيمته.`);
    }
  }

  for (const ded of stockDeductions) {
    if (!ded.productId || !isFinitePositive(ded.quantity)) {
      throw new FinancialValidationError('كمية خصم المخزون يجب أن تكون رقماً موجباً أكبر من الصفر.');
    }
  }

  const invoiceQuantities = new Map<string, number>();
  for (const item of invoice.items) {
    invoiceQuantities.set(item.productId, (invoiceQuantities.get(item.productId) || 0) + item.quantity);
  }
  const deductionQuantities = new Map<string, number>();
  for (const deduction of stockDeductions) {
    deductionQuantities.set(
      deduction.productId,
      (deductionQuantities.get(deduction.productId) || 0) + deduction.quantity
    );
  }
  if (invoiceQuantities.size !== deductionQuantities.size) {
    throw new FinancialValidationError('بنود الفاتورة لا تطابق بنود خصم المخزون.');
  }
  for (const [productId, quantity] of invoiceQuantities) {
    if (Math.abs(quantity - (deductionQuantities.get(productId) || 0)) > 0.0001) {
      throw new FinancialValidationError(`كمية الصنف (${productId}) لا تطابق كمية خصم المخزون.`);
    }
  }

  if (
    !isFiniteNonNegative(invoice.subtotal) ||
    !isFiniteNonNegative(invoice.discount) ||
    !isFiniteNonNegative(invoice.tax) ||
    !isFiniteNonNegative(invoice.total) ||
    !isFiniteNonNegative(invoice.paidAmount) ||
    !isFiniteNonNegative(totalCogs)
  ) {
    throw new FinancialValidationError('مبالغ الفاتورة والتكلفة لا يجوز أن تكون سالبة أو غير صالحة.');
  }

  if (invoice.discount > invoice.subtotal + 0.01) {
    throw new FinancialValidationError('الخصم الإجمالي للفاتورة يتجاوز المجموع الفرعي.');
  }

  const expectedTotal = roundMoney(invoice.subtotal - invoice.discount + invoice.tax);
  if (Math.abs(expectedTotal - roundMoney(invoice.total)) > 0.02) {
    throw new FinancialValidationError(
      `إجمالي الفاتورة (${invoice.total}) لا يطابق الصافي المحسوب (${expectedTotal}).`
    );
  }

  if (!isFiniteNonNegative(applyAdvanceAmount)) {
    throw new FinancialValidationError('مبلغ التسوية من الرصيد المقدم لا يجوز أن يكون سالباً.');
  }

  const totalSettled = roundMoney(invoice.paidAmount + applyAdvanceAmount);
  if (totalSettled > invoice.total + 0.01) {
    throw new FinancialValidationError(
      `مجموع المدفوع نقداً والمخصوم من الرصيد المقدم (${totalSettled}) لا يمكن أن يتجاوز إجمالي الفاتورة (${invoice.total}).`
    );
  }

  if (invoice.paidAmount > 0) {
    if (!invoice.cashBoxId || !invoice.cashBoxId.trim()) {
      throw new FinancialValidationError('يجب تحديد صندوق نقدي/بنكي صالح لتحصيل المبلغ المدفوع.');
    }
    if (!cashBox) {
      throw new FinancialValidationError(`الصندوق النقدي المحدد (${invoice.cashBoxId}) غير موجود.`);
    }
  }

  if (applyAdvanceAmount > 0 && !invoice.partyId) {
    throw new FinancialValidationError('استخدام الرصيد المقدم يتطلب اختيار عميل مسجل.');
  }

  const unpaid = roundMoney(invoice.total - totalSettled);
  if (invoice.paymentMethod === 'CREDIT' && unpaid > 0 && !invoice.partyId) {
    throw new FinancialValidationError('يجب تحديد عميل مسجل عند البيع الآجل لتسجيل الذمة المدينة.');
  }
}

export function validatePurchaseInvoiceInput(params: {
  invoice: Invoice;
  itemsWithBatches: Array<{
    productId: string;
    quantity: number;
    costPrice: number;
    batchNumber?: string;
    expiryDate?: string;
  }>;
  cashBox?: CashBox | null;
}): void {
  const { invoice, itemsWithBatches, cashBox } = params;

  if (!itemsWithBatches || itemsWithBatches.length === 0) {
    throw new FinancialValidationError('فاتورة المشتريات يجب أن تحتوي على صنف واحد على الأقل.');
  }

  let computedLinesTotal = 0;
  for (const item of itemsWithBatches) {
    if (!item.productId || !isFinitePositive(item.quantity)) {
      throw new FinancialValidationError('كمية الشراء لكل صنف يجب أن تكون رقماً موجباً أكبر من الصفر.');
    }
    if (!isFiniteNonNegative(item.costPrice)) {
      throw new FinancialValidationError('سعر التكلفة في فاتورة المشتريات لا يجوز أن يكون سالباً.');
    }
    computedLinesTotal = roundMoney(computedLinesTotal + roundMoney(item.quantity * item.costPrice));
  }

  if (
    !isFiniteNonNegative(invoice.subtotal) ||
    !isFiniteNonNegative(invoice.discount) ||
    !isFiniteNonNegative(invoice.tax) ||
    !isFiniteNonNegative(invoice.total) ||
    !isFiniteNonNegative(invoice.paidAmount)
  ) {
    throw new FinancialValidationError('مبالغ فاتورة المشتريات لا يجوز أن تكون سالبة أو غير صالحة.');
  }

  if (invoice.discount > invoice.subtotal + 0.01) {
    throw new FinancialValidationError('خصم فاتورة المشتريات يتجاوز المجموع الفرعي.');
  }

  const expectedTotal = roundMoney(invoice.subtotal - invoice.discount + invoice.tax);
  if (Math.abs(expectedTotal - roundMoney(invoice.total)) > 0.02) {
    throw new FinancialValidationError(
      `إجمالي فاتورة المشتريات (${invoice.total}) لا يطابق الصافي المحسوب (${expectedTotal}).`
    );
  }

  if (Math.abs(computedLinesTotal - roundMoney(invoice.subtotal)) > 0.05) {
    throw new FinancialValidationError(
      `مجموع بنود المشتريات (${computedLinesTotal}) لا يطابق المجموع الفرعي للفاتورة (${invoice.subtotal}).`
    );
  }

  if (invoice.paidAmount > invoice.total + 0.01) {
    throw new FinancialValidationError(
      `المبلغ المدفوع (${invoice.paidAmount}) لا يمكن أن يتجاوز إجمالي فاتورة المشتريات (${invoice.total}).`
    );
  }

  if (invoice.paidAmount > 0) {
    if (!invoice.cashBoxId || !invoice.cashBoxId.trim()) {
      throw new FinancialValidationError('يجب تحديد صندوق نقدي صالح لسداد فاتورة المشتريات.');
    }
    if (!cashBox) {
      throw new FinancialValidationError(`الصندوق النقدي المحدد (${invoice.cashBoxId}) غير موجود.`);
    }
    if (roundMoney(cashBox.balance) + 0.001 < roundMoney(invoice.paidAmount)) {
      throw new FinancialValidationError(
        `رصيد الصندوق (${cashBox.nameAr}: ${roundMoney(cashBox.balance)}) غير كافٍ لسداد مبلغ ${roundMoney(invoice.paidAmount)}.`
      );
    }
  }
}

export function validateVoucherInput(params: {
  voucher: PaymentVoucher;
  cashBox?: CashBox | null;
  accountExists: boolean;
  account?: Pick<Account, 'isLeaf'> | null;
}): void {
  const { voucher, cashBox, accountExists, account } = params;

  if (!isFinitePositive(voucher.amount)) {
    throw new FinancialValidationError('مبلغ السند المالي يجب أن يكون رقماً موجباً أكبر من الصفر.');
  }
  if (!voucher.cashBoxId || !cashBox) {
    throw new FinancialValidationError(`الصندوق المحدد (${voucher.cashBoxId || '-'}) غير موجود أو غير نشط.`);
  }
  if (!voucher.accountCode || !accountExists) {
    throw new FinancialValidationError(`الحساب المقابل (${voucher.accountCode || '-'}) غير موجود في الدليل المحاسبي.`);
  }
  if (account && account.isLeaf === false) {
    throw new FinancialValidationError(`لا يجوز الترحيل على الحساب التجميعي غير الفرعي (${voucher.accountCode}).`);
  }
  if (!voucher.description || !voucher.description.trim()) {
    throw new FinancialValidationError('وصف السند وسبب الحركة مطلوب محاسبياً.');
  }
  const willPost = (voucher.status || 'POSTED') !== 'DRAFT';
  if (willPost && voucher.type === 'PAYMENT' && roundMoney(cashBox.balance) + 0.001 < roundMoney(voucher.amount)) {
    throw new FinancialValidationError(
      `رصيد الصندوق (${cashBox.nameAr}: ${roundMoney(cashBox.balance)}) غير كافٍ لصرف مبلغ ${roundMoney(voucher.amount)}.`
    );
  }
}

export function validateJournalEntryInput(params: {
  entry: JournalEntry;
  validAccountCodes?: Set<string>;
  accountsByCode?: Map<string, Pick<Account, 'isLeaf'>>;
}): void {
  const { entry, validAccountCodes, accountsByCode } = params;
  if (!entry.description || !entry.description.trim()) {
    throw new FinancialValidationError('شرح وبيان القيد المحاسبي مطلوب.');
  }
  if (!entry.lines || entry.lines.length < 2) {
    throw new FinancialValidationError('يجب أن يحتوي القيد على طرفين على الأقل (طرف مدين وطرف دائن).');
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of entry.lines) {
    if (!line.accountCode || !line.accountCode.trim()) {
      throw new FinancialValidationError('جميع أسطر القيد يجب أن تحتوي على كود حساب صالح.');
    }
    if (accountsByCode && accountsByCode.size > 0) {
      const targetAcc = accountsByCode.get(line.accountCode);
      if (!targetAcc) {
        throw new FinancialValidationError(`الحساب المحاسبي (${line.accountCode}) غير معرف في الدليل المحاسبي.`);
      }
      if (targetAcc.isLeaf === false) {
        throw new FinancialValidationError(`لا يجوز القيد على الحساب التجميعي غير الفرعي (${line.accountCode}).`);
      }
    } else if (validAccountCodes && validAccountCodes.size > 0 && !validAccountCodes.has(line.accountCode)) {
      throw new FinancialValidationError(`الحساب المحاسبي (${line.accountCode}) غير معرف في الدليل المحاسبي.`);
    }
    if (!isFiniteNonNegative(line.debit) || !isFiniteNonNegative(line.credit)) {
      throw new FinancialValidationError('لا يجوز أن تحتوي أسطر القيد على قيم سالبة أو غير صالحة.');
    }
    if (line.debit > 0 && line.credit > 0) {
      throw new FinancialValidationError(`السطر للحساب (${line.accountCode}) لا يمكن أن يحمل مدين ودائن في آن واحد.`);
    }
    if (line.debit === 0 && line.credit === 0) {
      throw new FinancialValidationError(`السطر للحساب (${line.accountCode}) لا يمكن أن يكون صفراً في الجانبين.`);
    }
    totalDebit = roundMoney(totalDebit + line.debit);
    totalCredit = roundMoney(totalCredit + line.credit);
  }

  if (totalDebit <= 0) {
    throw new FinancialValidationError('إجمالي القيد المحاسبي يجب أن يكون أكبر من الصفر.');
  }

  const diff = Math.abs(totalDebit - totalCredit);
  if (diff > 0.009) {
    throw new FinancialValidationError(
      `القيد غير متوازن! إجمالي المدين (${totalDebit.toFixed(2)}) لا يساوي إجمالي الدائن (${totalCredit.toFixed(2)}).`
    );
  }
}

export function validateAmanatDepositInput(params: {
  record: AmanatRecord;
  cashBox?: CashBox | null;
}): void {
  const { record, cashBox } = params;
  if (!record.depositorName?.trim() || !record.depositorPhone?.trim()) {
    throw new FinancialValidationError('اسم المودع ورقم الهاتف مطلوبان لتسجيل الأمانة.');
  }
  if (record.type === 'CASH') {
    if (!isFinitePositive(record.amount)) {
      throw new FinancialValidationError('مبلغ الأمانة النقدية يجب أن يكون أكبر من الصفر.');
    }
    if (!cashBox) {
      throw new FinancialValidationError('يجب تحديد صندوق نقدي صالح لاستلام الأمانة النقدية.');
    }
  } else if (!record.itemDescription?.trim()) {
    throw new FinancialValidationError('وصف الصنف العيني مطلوب لتسجيل الأمانة العينية.');
  }
}

export function validateAmanatReturnInput(params: {
  record: AmanatRecord;
  cashBox?: CashBox | null;
}): void {
  const { record, cashBox } = params;
  if (record.status !== 'HELD') {
    throw new FinancialValidationError('لا يمكن رد أمانة ليست في حالة الحفظ (HELD).');
  }
  if (record.type === 'CASH') {
    if (!isFinitePositive(record.amount)) {
      throw new FinancialValidationError('مبلغ الأمانة النقدية غير صالح للرد.');
    }
    if (!cashBox) {
      throw new FinancialValidationError('الصندوق النقدي المحدد لرد الأمانة غير موجود.');
    }
    if (roundMoney(cashBox.balance) + 0.001 < roundMoney(record.amount)) {
      throw new FinancialValidationError(
        `رصيد الصندوق (${cashBox.nameAr}: ${roundMoney(cashBox.balance)}) غير كافٍ لرد الأمانة النقدية (${roundMoney(record.amount)}).`
      );
    }
  }
}

export function validateProductStockConsistency(product: Product): void {
  if (!isFiniteNonNegative(product.currentStock)) {
    throw new FinancialValidationError(`رصيد الصنف (${product.nameAr}) لا يجوز أن يكون سالباً.`);
  }
  if (!isFiniteNonNegative(product.purchasePrice) || !isFiniteNonNegative(product.sellPrice)) {
    throw new FinancialValidationError(`أسعار الشراء والبيع للصنف (${product.nameAr}) يجب أن تكون غير سالبة.`);
  }
  if (product.batches && product.batches.length > 0) {
    let sum = 0;
    for (const batch of product.batches) {
      if (!isFiniteNonNegative(batch.quantity)) {
        throw new FinancialValidationError(`كمية التشغيلة (${batch.batchNumber}) للصنف (${product.nameAr}) لا يجوز أن تكون سالبة.`);
      }
      sum = roundMoney(sum + batch.quantity, 4);
    }
    if (Math.abs(sum - roundMoney(product.currentStock, 4)) > 0.001) {
      throw new FinancialValidationError(
        `تعارض في مخزون الصنف (${product.nameAr}): الرصيد الإجمالي (${product.currentStock}) لا يساوي مجموع كميات التشغيلات (${sum}).`
      );
    }
  }
}
