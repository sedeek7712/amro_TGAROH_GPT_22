/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * محرك المخزون المتقدم متعدد الأنشطة التخصصية (Specialized Inventory Engine)
 * يدعم الصيدلية (FEFO ومنع المنتهي)، الأغذية (تتبع حسب الصنف)، وقطع الغيار (OEM وتوافق وتسلسلي)
 */

import { storage } from './storageService';
import { roundMoney } from '../config/currency';
import { Product, ProductBatch, CommercialActivityId } from '../types/erp';

class InventoryService {
  // توليد كود صنف فريد حسب النشاط التجاري
  public generateProductCode(activityId: CommercialActivityId): string {
    const prefixes: Record<CommercialActivityId, string> = {
      pharmacy: 'MED',
      grocery: 'FOD',
      bike_parts: 'MBK',
      equipment_parts: 'EQP',
    };
    const prefix = prefixes[activityId] || 'ITM';
    const products = storage.getProducts(activityId);
    const num = products.length + 1;
    return `${prefix}-${String(num).padStart(4, '0')}`;
  }

  // إضافة صنف جديد مع حساب الرصيد وتوليد المعرفات
  public createProduct(data: Omit<Product, 'id' | 'code' | 'currentStock'>): Product {
    const code = this.generateProductCode(data.activityId);
    let totalStock = 0;

    // حساب الرصيد الأولي من التشغيلات إن وجدت
    if (data.batches && data.batches.length > 0) {
      totalStock = roundMoney(data.batches.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0), 4);
    }

    const newProduct: Product = {
      ...data,
      id: storage.generateUUID(),
      code,
      currentStock: totalStock,
    };

    storage.addProduct(newProduct);
    return newProduct;
  }

  // فحص ما إذا كانت التشغيلة منتهية الصلاحية
  public isBatchExpired(expiryDate: string): boolean {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(expiryDate);
    return exp.getTime() < today.getTime();
  }

  // خصم مخزون عند البيع وفق استراتيجية FEFO (الأقرب انتهاءً يصرف أولاً) مع منع المنتهي الصلاحية
  public deductStockForSale(
    productId: string,
    quantity: number,
    chosenBatchNumber?: string
  ): { success: boolean; totalCost: number; error?: string } {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { success: false, totalCost: 0, error: 'كمية الخصم يجب أن تكون أكبر من الصفر.' };
    }
    const products = storage.getProducts();
    const product = products.find((p) => p.id === productId);

    if (!product) {
      return { success: false, totalCost: 0, error: 'الصنف غير موجود بالمستودع.' };
    }

    if (product.currentStock < quantity) {
      return {
        success: false,
        totalCost: 0,
        error: `الرصيد المتاح من (${product.nameAr}) هو ${product.currentStock} فقط، المطلوب بيع ${quantity}.`,
      };
    }

    let remainingQtyToDeduct = quantity;
    let accumulatedCost = 0;

    if (product.batches && product.batches.length > 0) {
      if (chosenBatchNumber) {
        const batch = product.batches.find((b) => b.batchNumber === chosenBatchNumber);
        if (!batch) {
          return { success: false, totalCost: 0, error: `رقم التشغيلة ${chosenBatchNumber} غير متوفر.` };
        }
        if (this.isBatchExpired(batch.expiryDate)) {
          return {
            success: false,
            totalCost: 0,
            error: `محظور بيع التشغيلة (${batch.batchNumber}) لأنها منتهية الصلاحية بتاريخ ${batch.expiryDate}!`,
          };
        }
        if (batch.quantity < quantity) {
          return {
            success: false,
            totalCost: 0,
            error: `الكمية المتاحة في التشغيلة (${chosenBatchNumber}) هي ${batch.quantity} فقط.`,
          };
        }
        batch.quantity = roundMoney(batch.quantity - quantity, 4);
        accumulatedCost = quantity * batch.costPrice;
      } else {
        const validBatches = product.batches
          .filter((b) => b.quantity > 0 && !this.isBatchExpired(b.expiryDate))
          .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

        const totalValidQty = validBatches.reduce((sum, b) => sum + b.quantity, 0);
        if (totalValidQty < quantity) {
          return {
            success: false,
            totalCost: 0,
            error: `لا توجد كمية سارية كافية! الرصيد الساري غير المنتهي هو ${totalValidQty} فقط، وبقية المخزون منتهي الصلاحية ومحظور بيعه.`,
          };
        }

        for (const batch of validBatches) {
          if (remainingQtyToDeduct <= 0) break;
          const deductFromThis = Math.min(batch.quantity, remainingQtyToDeduct);
          batch.quantity = roundMoney(batch.quantity - deductFromThis, 4);
          remainingQtyToDeduct = roundMoney(remainingQtyToDeduct - deductFromThis, 4);
          accumulatedCost += deductFromThis * batch.costPrice;
        }
      }

      product.currentStock = roundMoney(product.batches.reduce((sum, b) => sum + b.quantity, 0), 4);
    } else {
      product.currentStock = roundMoney(product.currentStock - quantity, 4);
      accumulatedCost = quantity * product.purchasePrice;
    }

    storage.updateProduct(product);
    return { success: true, totalCost: roundMoney(accumulatedCost) };
  }

  // إضافة مخزون عند الشراء مع دعم التشغيلات وتواريخ الصلاحية
  public addStockForPurchase(
    productId: string,
    quantity: number,
    costPrice: number,
    batchNumber?: string,
    expiryDate?: string
  ): void {
    const products = storage.getProducts();
    const product = products.find((p) => p.id === productId);
    if (!product) return;

    if (batchNumber && expiryDate) {
      if (!product.batches) product.batches = [];
      const existingBatch = product.batches.find((b) => b.batchNumber === batchNumber);
      if (existingBatch) {
        existingBatch.quantity += quantity;
        existingBatch.costPrice = costPrice;
      } else {
        product.batches.push({
          id: storage.generateUUID(),
          productId: product.id,
          batchNumber,
          expiryDate,
          quantity,
          costPrice,
        });
      }
      product.currentStock = product.batches.reduce((sum, b) => sum + b.quantity, 0);
    } else {
      product.currentStock += quantity;
    }

    product.purchasePrice = costPrice;
    storage.updateProduct(product);
  }

  // فحص الأصناف منخفضة الرصيد (تحت حد الطلب)
  public getLowStockAlerts(activityId?: CommercialActivityId): Product[] {
    const products = storage.getProducts(activityId);
    return products.filter((p) => p.currentStock <= p.minStockAlert);
  }

  // فحص الأصناف قريبة الانتهاء (للصيدلية والمواد الغذائية)
  public getExpiringSoonBatches(daysThreshold: number = 60): Array<{
    product: Product;
    batch: ProductBatch;
    daysRemaining: number;
    isExpired: boolean;
  }> {
    const products = storage.getProducts();
    const results: Array<{
      product: Product;
      batch: ProductBatch;
      daysRemaining: number;
      isExpired: boolean;
    }> = [];

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    products.forEach((p) => {
      if (p.batches && p.batches.length > 0) {
        p.batches.forEach((b) => {
          if (b.quantity > 0) {
            const expTime = new Date(b.expiryDate).getTime();
            const diffDays = Math.ceil((expTime - now.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays <= daysThreshold) {
              results.push({
                product: p,
                batch: b,
                daysRemaining: diffDays,
                isExpired: diffDays <= 0,
              });
            }
          }
        });
      }
    });

    return results.sort((a, b) => a.daysRemaining - b.daysRemaining);
  }

  // تقييم إجمالي قيمة المخزون التجاري المملوك فقط (الأمانات معزولة تماماً)
  public getInventoryValuation(activityId?: CommercialActivityId): {
    totalValue: number;
    totalItemsCount: number;
    activityBreakdown: Record<CommercialActivityId, { count: number; value: number }>;
  } {
    const products = storage.getProducts();
    let totalValue = 0;
    let totalItemsCount = 0;

    const activityBreakdown: Record<CommercialActivityId, { count: number; value: number }> = {
      pharmacy: { count: 0, value: 0 },
      grocery: { count: 0, value: 0 },
      bike_parts: { count: 0, value: 0 },
      equipment_parts: { count: 0, value: 0 },
    };

    products.forEach((p) => {
      if (activityId && p.activityId !== activityId) return;

      let itemVal = 0;
      if (p.batches && p.batches.length > 0) {
        itemVal = p.batches.reduce((sum, b) => sum + b.quantity * b.costPrice, 0);
      } else {
        itemVal = p.currentStock * p.purchasePrice;
      }
      itemVal = Number(itemVal.toFixed(2));

      totalValue += itemVal;
      totalItemsCount += p.currentStock;

      if (activityBreakdown[p.activityId]) {
        activityBreakdown[p.activityId].count += p.currentStock;
        activityBreakdown[p.activityId].value += itemVal;
      }
    });

    return {
      totalValue: Number(totalValue.toFixed(2)),
      totalItemsCount,
      activityBreakdown,
    };
  }
}

export const inventory = new InventoryService();
