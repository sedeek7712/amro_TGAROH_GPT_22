import { randomUUID } from 'node:crypto';
import {
  assertActivityAccess,
  assertPermission,
  filterRecordsByActivityScope,
} from '../rbac.mjs';
import {
  divBigIntHalfUp,
  formatScaledInt,
  MONEY_SCALE,
  mulScaledHalfUp,
  parseScaledInt,
  QTY_SCALE,
  toMoneyNumber,
  TOTALS_SCALE,
  unitsToNumber,
} from '../money.mjs';
import { allocateSequenceTx, enqueueOutboxTx, parseRowJson, writeAuditLogTx } from './core-service.mjs';
import {
  ACTIVITY_INVENTORY_ACCOUNTS,
  ensureCanonicalAccountTx,
  getTerminalCodeValue,
  insertJournalEntryTx,
  resolveBranchTx,
  updateAccountBalanceByLineTx,
} from './accounting-tx-helpers.mjs';

const VALID_PARTY_TYPES = new Set(['CUSTOMER', 'SUPPLIER']);

function normalizeBatch(batch, productId, defaultCostPrice, tenantId) {
  const qtyUnits = parseScaledInt(batch.quantity ?? 0, QTY_SCALE, 'batch.quantity');
  if (qtyUnits < 0n) {
    throw new Error('كمية التشغيلة لا يجوز أن تكون سالبة.');
  }
  const costUnits = parseScaledInt(
    batch.costPrice !== undefined ? batch.costPrice : defaultCostPrice,
    QTY_SCALE,
    'batch.costPrice'
  );
  if (costUnits < 0n) {
    throw new Error('سعر تكلفة التشغيلة لا يجوز أن يكون سالباً.');
  }
  const batchNumber = String(batch.batchNumber || '').trim();
  if (!batchNumber) {
    throw new Error('رقم التشغيلة مطلوب.');
  }
  return {
    ...batch,
    id: String(batch.id || '').trim() || randomUUID(),
    tenantId,
    productId,
    batchNumber,
    expiryDate: String(batch.expiryDate || '').trim(),
    quantity: unitsToNumber(qtyUnits, QTY_SCALE),
    costPrice: unitsToNumber(costUnits, QTY_SCALE),
    _qtyUnits: qtyUnits,
    _costUnits: costUnits,
  };
}

function hydrateBatchRow(row) {
  const parsed = parseRowJson(row);
  const qtyUnits = parseScaledInt(row.quantity_decimal, QTY_SCALE, 'dbBatchQty');
  const costUnits = parseScaledInt(row.cost_price_decimal, QTY_SCALE, 'dbBatchCost');
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date || '',
    quantity: unitsToNumber(qtyUnits, QTY_SCALE),
    costPrice: unitsToNumber(costUnits, QTY_SCALE),
  };
}

export function hydrateProductRow(row, batchesForProduct) {
  const parsed = parseRowJson(row);
  const stockUnits = parseScaledInt(row.current_stock_decimal, QTY_SCALE, 'dbProductStock');
  const resolvedBatches = Array.isArray(batchesForProduct)
    ? batchesForProduct
    : Array.isArray(parsed.batches)
      ? parsed.batches
      : [];
  return {
    ...parsed,
    id: row.id,
    tenantId: row.tenant_id,
    activityId: row.activity_id,
    code: row.code,
    barcode: row.barcode ?? parsed.barcode,
    category: row.category || parsed.category || '',
    currentStock: unitsToNumber(stockUnits, QTY_SCALE),
    batches: resolvedBatches,
  };
}

export function syncProductAndBatchesTx(database, tenantId, product) {
  const cleanBatches = Array.isArray(product.batches)
    ? product.batches.map((b) => normalizeBatch(b, product.id, product.purchasePrice ?? 0, tenantId))
    : [];

  let stockUnits;
  if (cleanBatches.length > 0) {
    const batchSumUnits = cleanBatches.reduce((sum, b) => sum + b._qtyUnits, 0n);
    if (
      product.currentStock !== undefined &&
      product.currentStock !== null &&
      Number(product.currentStock) !== 0
    ) {
      const providedUnits = parseScaledInt(product.currentStock, QTY_SCALE, 'product.currentStock');
      if (providedUnits !== batchSumUnits) {
        throw new Error(
          `تعارض كميات الصنف (${product.nameAr}): إجمالي الرصيد (${unitsToNumber(providedUnits, QTY_SCALE)}) لا يطابق مجموع التشغيلات (${unitsToNumber(batchSumUnits, QTY_SCALE)}).`
        );
      }
    }
    stockUnits = batchSumUnits;
  } else {
    stockUnits = parseScaledInt(product.currentStock ?? 0, QTY_SCALE, 'product.currentStock');
    if (stockUnits < 0n) {
      throw new Error('رصيد المخزون لا يجوز أن يكون سالباً.');
    }
  }

  const publicBatches = cleanBatches.map(({ _qtyUnits, _costUnits, ...rest }) => rest);
  const purchaseUnits = parseScaledInt(product.purchasePrice ?? 0, QTY_SCALE, 'product.purchasePrice');
  if (purchaseUnits < 0n) {
    throw new Error('سعر الشراء لا يجوز أن يكون سالباً.');
  }
  const persistedProduct = {
    ...product,
    tenantId,
    currentStock: unitsToNumber(stockUnits, QTY_SCALE),
    purchasePrice: unitsToNumber(purchaseUnits, QTY_SCALE),
    sellPrice: toMoneyNumber(product.sellPrice ?? 0),
    minStockAlert: unitsToNumber(parseScaledInt(product.minStockAlert ?? 0, QTY_SCALE, 'minStockAlert'), QTY_SCALE),
    isActive: product.isActive !== false,
    batches: publicBatches,
  };

  database.prepare(
    `INSERT INTO products (tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,id) DO UPDATE SET
       activity_id=excluded.activity_id,
       code=excluded.code,
       barcode=excluded.barcode,
       category=excluded.category,
       current_stock_decimal=excluded.current_stock_decimal,
       data_json=excluded.data_json`
  ).run(
    tenantId,
    persistedProduct.id,
    persistedProduct.activityId,
    persistedProduct.code,
    persistedProduct.barcode || null,
    persistedProduct.category || '',
    formatScaledInt(stockUnits, QTY_SCALE),
    JSON.stringify(persistedProduct)
  );

  database.prepare('DELETE FROM product_batches WHERE tenant_id = ? AND product_id = ?')
    .run(tenantId, persistedProduct.id);

  const insertBatchStmt = database.prepare(
    'INSERT INTO product_batches (tenant_id,id,product_id,batch_number,expiry_date,quantity_decimal,cost_price_decimal,data_json) VALUES (?,?,?,?,?,?,?,?)'
  );
  for (let idx = 0; idx < cleanBatches.length; idx += 1) {
    const raw = cleanBatches[idx];
    const pub = publicBatches[idx];
    insertBatchStmt.run(
      tenantId,
      pub.id,
      persistedProduct.id,
      pub.batchNumber,
      pub.expiryDate || '',
      formatScaledInt(raw._qtyUnits, QTY_SCALE),
      formatScaledInt(raw._costUnits, QTY_SCALE),
      JSON.stringify(pub)
    );
  }

  return persistedProduct;
}

export function loadProductWithBatches(database, tenantId, productId) {
  const row = database.prepare(
    'SELECT tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json FROM products WHERE tenant_id = ? AND id = ?'
  ).get(tenantId, productId);
  if (!row) return undefined;
  const batchRows = database.prepare(
    'SELECT tenant_id,id,product_id,batch_number,expiry_date,quantity_decimal,cost_price_decimal,data_json FROM product_batches WHERE tenant_id = ? AND product_id = ? ORDER BY expiry_date ASC, rowid ASC'
  ).all(tenantId, productId);
  return hydrateProductRow(row, batchRows.map(hydrateBatchRow));
}

function computeProductStockCostUnits(product) {
  const batches = Array.isArray(product?.batches) ? product.batches : [];
  let rawTotal = 0n;
  if (batches.length > 0) {
    for (const b of batches) {
      const qUnits = parseScaledInt(b.quantity ?? 0, QTY_SCALE, 'batch.quantity');
      const cUnits = parseScaledInt(b.costPrice ?? product.purchasePrice ?? 0, QTY_SCALE, 'batch.costPrice');
      if (qUnits > 0n && cUnits > 0n) {
        rawTotal += mulScaledHalfUp(qUnits, cUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
      }
    }
  } else {
    const qUnits = parseScaledInt(product?.currentStock ?? 0, QTY_SCALE, 'product.currentStock');
    const cUnits = parseScaledInt(product?.purchasePrice ?? 0, QTY_SCALE, 'product.purchasePrice');
    if (qUnits > 0n && cUnits > 0n) {
      rawTotal = mulScaledHalfUp(qUnits, cUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
    }
  }
  return divBigIntHalfUp(rawTotal * MONEY_SCALE, TOTALS_SCALE);
}

export function createInventoryPartiesService(database, core = null) {
  return {
    // --- المنتجات والمخزون والتشغيلات ---
    getProducts(actor, activityId) {
      assertPermission(actor, 'inventory:view', 'عرض الأصناف والمخزون');
      const productRows = activityId && activityId !== 'all'
        ? database.prepare(
            'SELECT tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json FROM products WHERE tenant_id = ? AND activity_id = ? ORDER BY rowid'
          ).all(actor.tenantId, String(activityId))
        : database.prepare(
            'SELECT tenant_id,id,activity_id,code,barcode,category,current_stock_decimal,data_json FROM products WHERE tenant_id = ? ORDER BY rowid'
          ).all(actor.tenantId);

      const batchRows = database.prepare(
        'SELECT tenant_id,id,product_id,batch_number,expiry_date,quantity_decimal,cost_price_decimal,data_json FROM product_batches WHERE tenant_id = ? ORDER BY expiry_date ASC, rowid ASC'
      ).all(actor.tenantId);

      const batchesByProduct = new Map();
      for (const bRow of batchRows) {
        const list = batchesByProduct.get(bRow.product_id) || [];
        list.push(hydrateBatchRow(bRow));
        batchesByProduct.set(bRow.product_id, list);
      }

      const products = productRows.map((row) =>
        hydrateProductRow(row, batchesByProduct.get(row.id) || [])
      );
      return filterRecordsByActivityScope(products, actor);
    },

    getProductById(actor, id) {
      assertPermission(actor, 'inventory:view', 'عرض بيانات الصنف');
      if (!id) return undefined;
      const product = loadProductWithBatches(database, actor.tenantId, String(id));
      if (!product) return undefined;
      return filterRecordsByActivityScope([product], actor)[0];
    },

    saveProductAtomic(actor, product, isUpdate = false) {
      assertPermission(actor, 'inventory:write', isUpdate ? 'تعديل صنف' : 'إضافة صنف');
      if (!product || typeof product !== 'object') {
        throw new Error('بيانات الصنف غير صالحة.');
      }
      const nameAr = String(product.nameAr || '').trim();
      const code = String(product.code || '').trim();
      const activityId = String(product.activityId || '').trim();
      if (!nameAr || !code || !activityId) {
        throw new Error('اسم الصنف وكوده والنشاط التجاري حقول مطلوبة.');
      }
      assertActivityAccess(actor, activityId, isUpdate ? 'تعديل صنف' : 'إضافة صنف');

      const actRow = database.prepare(
        'SELECT 1 FROM activities WHERE tenant_id = ? AND id = ?'
      ).get(actor.tenantId, activityId);
      if (!actRow) {
        throw new Error(`النشاط التجاري (${activityId}) غير موجود.`);
      }

      const purchaseUnits = parseScaledInt(product.purchasePrice ?? 0, MONEY_SCALE, 'purchasePrice');
      const sellUnits = parseScaledInt(product.sellPrice ?? 0, MONEY_SCALE, 'sellPrice');
      if (purchaseUnits < 0n || sellUnits < 0n) {
        throw new Error('أسعار الشراء والبيع لا يجوز أن تكون سالبة.');
      }

      const id = String(product.id || '').trim() || randomUUID();
      const normalizedInput = {
        ...product,
        id,
        tenantId: actor.tenantId,
        code,
        nameAr,
        activityId,
      };
      const nowIso = new Date().toISOString();
      const entryDate = nowIso.split('T')[0];
      let persisted;

      database.exec('BEGIN IMMEDIATE');
      try {
        const existed = database.prepare(
          'SELECT activity_id,data_json FROM products WHERE tenant_id = ? AND id = ?'
        ).get(actor.tenantId, id);
        if (existed?.activity_id) {
          assertActivityAccess(actor, existed.activity_id, 'تعديل صنف');
          const existingProduct = parseRowJson(existed);
          if (existingProduct.unit !== normalizedInput.unit) {
            const alternateUnitCount = database.prepare(
              'SELECT COUNT(*) AS count FROM product_units WHERE tenant_id = ? AND product_id = ?'
            ).get(actor.tenantId, id).count;
            if (alternateUnitCount > 0) {
              throw new Error('لا يمكن تغيير وحدة المخزون الأساسية بعد تعريف وحدات بديلة لهذا الصنف.');
            }
          }
        }
        persisted = syncProductAndBatchesTx(database, actor.tenantId, normalizedInput);
        enqueueOutboxTx(database, actor, {
          entityType: 'PRODUCT',
          entityId: persisted.id,
          action: existed || isUpdate ? 'UPDATE' : 'CREATE',
          payload: persisted,
          nowIso,
        });

        if (!existed && !isUpdate) {
          const openingValUnits = computeProductStockCostUnits(persisted);
          if (openingValUnits > 0n) {
            const openingValNum = unitsToNumber(openingValUnits, MONEY_SCALE);
            const activeBranch = resolveBranchTx(database, core, actor, product.branchId);
            const terminalCode = getTerminalCodeValue(database, actor.tenantId);
            const invCode = ACTIVITY_INVENTORY_ACCOUNTS[persisted.activityId] || '11041';
            const invAcc = ensureCanonicalAccountTx(database, actor.tenantId, invCode);
            const eqAcc = ensureCanonicalAccountTx(database, actor.tenantId, '3101');
            const entryNumber = allocateSequenceTx(
              database,
              actor.tenantId,
              'JV',
              activeBranch.code,
              terminalCode,
              nowIso
            );
            const { persisted: openingJv, linesWithUnits } = insertJournalEntryTx(database, actor.tenantId, {
              id: randomUUID(),
              entryNumber,
              date: entryDate,
              description: `قيد رصيد افتتاحي للمخزون - ${persisted.nameAr} (${persisted.code})`,
              costCenterId: persisted.activityId,
              branchId: activeBranch.id,
              lines: [
                {
                  id: randomUUID(),
                  accountCode: invCode,
                  accountName: invAcc?.nameAr || 'مخزون النشاط',
                  debit: openingValNum,
                  credit: 0,
                  costCenterId: persisted.activityId,
                  memo: `إثبات رصيد افتتاحي: ${persisted.nameAr}`,
                },
                {
                  id: randomUUID(),
                  accountCode: '3101',
                  accountName: eqAcc?.nameAr || 'رأس المال المخصص',
                  debit: 0,
                  credit: openingValNum,
                  costCenterId: 'general',
                  memo: `مقابل رصيد مخزون افتتاحي: ${persisted.nameAr}`,
                },
              ],
              status: 'POSTED',
              referenceType: 'INVENTORY',
              referenceId: persisted.id,
              isAutoGenerated: true,
            });
            for (const line of linesWithUnits) {
              updateAccountBalanceByLineTx(database, actor.tenantId, line.accountCode, line._debitUnits, line._creditUnits);
            }
            enqueueOutboxTx(database, actor, {
              entityType: 'JOURNAL_ENTRY',
              entityId: openingJv.id,
              action: 'CREATE',
              payload: openingJv,
              priority: 4,
              dependsOn: [persisted.id],
              idempotencyKey: `${actor.tenantId}_JOURNAL_ENTRY_${openingJv.id}_CREATE`,
              branchId: activeBranch.id,
              nowIso,
            });
          }
        }

        writeAuditLogTx(
          database,
          actor,
          existed || isUpdate ? 'تعديل صنف' : 'إضافة صنف',
          `${existed || isUpdate ? 'تحديث' : 'إضافة'} الصنف ${persisted.nameAr} بكود ${persisted.code}`,
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }

      return persisted;
    },

    deleteProductAtomic(actor, productId) {
      assertPermission(actor, 'inventory:delete', 'حذف صنف');
      const id = String(productId || '').trim();
      if (!id) throw new Error('معرف الصنف مطلوب للحذف.');
      const nowIso = new Date().toISOString();

      database.exec('BEGIN IMMEDIATE');
      try {
        const existing = loadProductWithBatches(database, actor.tenantId, id);
        if (!existing) {
          database.exec('COMMIT');
          return;
        }
        assertActivityAccess(actor, existing.activityId, 'حذف صنف');
        const linkedImages = database.prepare(
          'SELECT COUNT(*) AS count FROM product_images WHERE tenant_id = ? AND product_id = ?'
        ).get(actor.tenantId, id).count;
        if (linkedImages > 0) {
          throw new Error('لا يمكن حذف الصنف حتى تكتمل مزامنة حذف جميع صوره؛ تحقق من اتصال الإنترنت وحالة المزامنة.');
        }
        const usedInInvoices = database.prepare(
          'SELECT 1 FROM invoice_items WHERE tenant_id = ? AND product_id = ? LIMIT 1'
        ).get(actor.tenantId, id);
        const usedInDeductions = database.prepare(
          'SELECT 1 FROM invoice_stock_deductions WHERE tenant_id = ? AND product_id = ? LIMIT 1'
        ).get(actor.tenantId, id);
        if (usedInInvoices || usedInDeductions) {
          throw new Error('لا يمكن حذف صنف مرتبط بفواتير مرحلة حفاظاً على سلامة السجل المالي.');
        }

        const remainingValUnits = computeProductStockCostUnits(existing);
        const hasInvJv = database.prepare(
          "SELECT 1 FROM journal_entries WHERE tenant_id = ? AND reference_type = 'INVENTORY' AND reference_id = ? LIMIT 1"
        ).get(actor.tenantId, id);
        if (remainingValUnits > 0n && hasInvJv) {
          const remainingValNum = unitsToNumber(remainingValUnits, MONEY_SCALE);
          const activeBranch = resolveBranchTx(database, core, actor, existing.branchId);
          const terminalCode = getTerminalCodeValue(database, actor.tenantId);
          const invCode = ACTIVITY_INVENTORY_ACCOUNTS[existing.activityId] || '11041';
          const invAcc = ensureCanonicalAccountTx(database, actor.tenantId, invCode);
          const eqAcc = ensureCanonicalAccountTx(database, actor.tenantId, '3101');
          const entryNumber = allocateSequenceTx(
            database,
            actor.tenantId,
            'REV',
            activeBranch.code,
            terminalCode,
            nowIso
          );
          const { persisted: delJv, linesWithUnits } = insertJournalEntryTx(database, actor.tenantId, {
            id: randomUUID(),
            entryNumber,
            date: nowIso.split('T')[0],
            description: `إلغاء أثر رصيد مخزون محذوف - ${existing.nameAr} (${existing.code})`,
            costCenterId: existing.activityId,
            branchId: activeBranch.id,
            lines: [
              {
                id: randomUUID(),
                accountCode: '3101',
                accountName: eqAcc?.nameAr || 'رأس المال المخصص',
                debit: remainingValNum,
                credit: 0,
                costCenterId: 'general',
                memo: `إلغاء رصيد صنف محذوف: ${existing.nameAr}`,
              },
              {
                id: randomUUID(),
                accountCode: invCode,
                accountName: invAcc?.nameAr || 'مخزون النشاط',
                debit: 0,
                credit: remainingValNum,
                costCenterId: existing.activityId,
                memo: `تخفيض مخزون صنف محذوف: ${existing.nameAr}`,
              },
            ],
            status: 'POSTED',
            referenceType: 'INVENTORY',
            referenceId: id,
            isAutoGenerated: true,
          });
          for (const line of linesWithUnits) {
            updateAccountBalanceByLineTx(database, actor.tenantId, line.accountCode, line._debitUnits, line._creditUnits);
          }
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: delJv.id,
            action: 'CREATE',
            payload: delJv,
            priority: 4,
            branchId: activeBranch.id,
            nowIso,
          });
        }

        database.prepare('DELETE FROM product_batches WHERE tenant_id = ? AND product_id = ?')
          .run(actor.tenantId, id);
        database.prepare('DELETE FROM products WHERE tenant_id = ? AND id = ?')
          .run(actor.tenantId, id);
        enqueueOutboxTx(database, actor, {
          entityType: 'PRODUCT',
          entityId: id,
          action: 'DELETE',
          payload: { id },
          nowIso,
        });
        writeAuditLogTx(
          database,
          actor,
          'حذف صنف',
          `تم حذف الصنف ${existing.nameAr} (${id})`,
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    adjustProductStockAtomic(actor, params) {
      assertPermission(actor, 'inventory:adjust', 'تسوية مخزنية ذرية');
      if (!params || typeof params !== 'object') {
        throw new Error('بيانات التسوية غير صالحة.');
      }
      const productId = String(params.productId || '').trim();
      const reason = String(params.reason || '').trim();
      const deltaUnits = parseScaledInt(params.deltaQuantity, QTY_SCALE, 'deltaQuantity');
      if (!productId) throw new Error('معرف الصنف مطلوب.');
      if (deltaUnits === 0n) {
        throw new Error('كمية التسوية الجردية يجب أن تكون رقماً غير صفري.');
      }
      if (!reason) {
        throw new Error('سبب التسوية الجردية مطلوب رقابياً.');
      }

      const nowIso = new Date().toISOString();
      let persisted;

      database.exec('BEGIN IMMEDIATE');
      try {
        const product = loadProductWithBatches(database, actor.tenantId, productId);
        if (!product) {
          throw new Error(`الصنف ذو المعرف ${productId} غير موجود.`);
        }
        assertActivityAccess(actor, product.activityId, 'تسوية مخزنية');

        const batches = Array.isArray(product.batches)
          ? product.batches.map((b) => ({
              ...b,
              _qtyUnits: parseScaledInt(b.quantity, QTY_SCALE, 'batchQty'),
              _costUnits: parseScaledInt(b.costPrice ?? product.purchasePrice ?? 0, QTY_SCALE, 'batchCost'),
            }))
          : [];
        const hasBatches = batches.length > 0;
        const currentStockUnits = parseScaledInt(product.currentStock, QTY_SCALE, 'currentStock');
        const productPurchaseUnits = parseScaledInt(product.purchasePrice ?? 0, QTY_SCALE, 'purchasePrice');
        let adjustmentCostRawUnits = 0n;

        if (hasBatches) {
          const sumUnits = batches.reduce((sum, b) => sum + b._qtyUnits, 0n);
          if (sumUnits !== currentStockUnits) {
            throw new Error(`تعارض كميات الصنف (${product.nameAr}) قبل التسوية.`);
          }
        }

        if (deltaUnits < 0n) {
          const deductUnits = -deltaUnits;
          if (currentStockUnits < deductUnits) {
            throw new Error(
              `الرصيد المتاح (${unitsToNumber(currentStockUnits, QTY_SCALE)}) أقل من كمية الخصم المطلوبة (${unitsToNumber(deductUnits, QTY_SCALE)}).`
            );
          }

          if (hasBatches) {
            const targetNumber = params.batchNumber ? String(params.batchNumber).trim() : '';
            if (targetNumber) {
              const targetBatch = batches.find((b) => b.batchNumber === targetNumber);
              if (!targetBatch) {
                throw new Error(`التشغيلة (${targetNumber}) غير موجودة.`);
              }
              if (targetBatch._qtyUnits < deductUnits) {
                throw new Error(
                  `الكمية المتاحة في التشغيلة (${targetNumber}) هي ${unitsToNumber(targetBatch._qtyUnits, QTY_SCALE)} فقط.`
                );
              }
              targetBatch._qtyUnits -= deductUnits;
              adjustmentCostRawUnits += mulScaledHalfUp(deductUnits, targetBatch._costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            } else {
              let remaining = deductUnits;
              const sorted = [...batches]
                .filter((b) => b._qtyUnits > 0n)
                .sort((a, b) => String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31')));
              for (const b of sorted) {
                if (remaining === 0n) break;
                const take = b._qtyUnits < remaining ? b._qtyUnits : remaining;
                b._qtyUnits -= take;
                remaining -= take;
                adjustmentCostRawUnits += mulScaledHalfUp(take, b._costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
              }
              if (remaining > 0n) {
                throw new Error('تعذر استيفاء كمية الخصم بالكامل من التشغيلات.');
              }
            }
            const nextSum = batches.reduce((sum, b) => sum + b._qtyUnits, 0n);
            product.batches = batches.map(({ _qtyUnits, _costUnits, ...rest }) => ({
              ...rest,
              quantity: unitsToNumber(_qtyUnits, QTY_SCALE),
            }));
            product.currentStock = unitsToNumber(nextSum, QTY_SCALE);
          } else {
            product.currentStock = unitsToNumber(currentStockUnits - deductUnits, QTY_SCALE);
            adjustmentCostRawUnits = mulScaledHalfUp(deductUnits, productPurchaseUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
          }
        } else {
          if (product.trackExpiry || hasBatches) {
            const batchNumber = String(params.batchNumber || '').trim();
            const expiryDate = String(params.expiryDate || '').trim();
            if (!batchNumber || !expiryDate) {
              throw new Error(
                'الأصناف المتتبعة بالتشغيلات تتطلب تحديد رقم تشغيلة وتاريخ صلاحية عند الزيادة الجردية.'
              );
            }
            const existingBatch = batches.find((b) => b.batchNumber === batchNumber);
            if (existingBatch) {
              existingBatch._qtyUnits += deltaUnits;
              adjustmentCostRawUnits = mulScaledHalfUp(deltaUnits, existingBatch._costUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            } else {
              batches.push({
                id: randomUUID(),
                productId: product.id,
                batchNumber,
                expiryDate,
                costPrice: product.purchasePrice,
                quantity: unitsToNumber(deltaUnits, QTY_SCALE),
                _qtyUnits: deltaUnits,
                _costUnits: productPurchaseUnits,
              });
              adjustmentCostRawUnits = mulScaledHalfUp(deltaUnits, productPurchaseUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
            }
            const nextSum = batches.reduce((sum, b) => sum + b._qtyUnits, 0n);
            product.batches = batches.map(({ _qtyUnits, _costUnits, ...rest }) => ({
              ...rest,
              quantity: unitsToNumber(_qtyUnits, QTY_SCALE),
            }));
            product.currentStock = unitsToNumber(nextSum, QTY_SCALE);
          } else {
            product.currentStock = unitsToNumber(currentStockUnits + deltaUnits, QTY_SCALE);
            adjustmentCostRawUnits = mulScaledHalfUp(deltaUnits, productPurchaseUnits, QTY_SCALE, QTY_SCALE, TOTALS_SCALE);
          }
        }

        persisted = syncProductAndBatchesTx(database, actor.tenantId, product);
        enqueueOutboxTx(database, actor, {
          entityType: 'PRODUCT',
          entityId: persisted.id,
          action: 'UPDATE',
          payload: persisted,
          nowIso,
        });

        const adjMoneyUnits = divBigIntHalfUp(adjustmentCostRawUnits * MONEY_SCALE, TOTALS_SCALE);
        if (adjMoneyUnits > 0n) {
          const adjValNum = unitsToNumber(adjMoneyUnits, MONEY_SCALE);
          const activeBranch = resolveBranchTx(database, core, actor, params.branchId);
          const terminalCode = getTerminalCodeValue(database, actor.tenantId);
          const invCode = ACTIVITY_INVENTORY_ACCOUNTS[persisted.activityId] || '11041';
          const invAcc = ensureCanonicalAccountTx(database, actor.tenantId, invCode);
          const adjExpAcc = ensureCanonicalAccountTx(database, actor.tenantId, '5205');
          const entryNumber = allocateSequenceTx(
            database,
            actor.tenantId,
            'JV',
            activeBranch.code,
            terminalCode,
            nowIso
          );
          const isShortage = deltaUnits < 0n;
          const adjLines = isShortage
            ? [
                {
                  id: randomUUID(),
                  accountCode: '5205',
                  accountName: adjExpAcc?.nameAr || 'فروقات وتسويات وتلف المخزون',
                  debit: adjValNum,
                  credit: 0,
                  costCenterId: persisted.activityId,
                  memo: `عجز/تلف تسوية مخزنية: ${persisted.nameAr} - ${reason}`,
                },
                {
                  id: randomUUID(),
                  accountCode: invCode,
                  accountName: invAcc?.nameAr || 'مخزون النشاط',
                  debit: 0,
                  credit: adjValNum,
                  costCenterId: persisted.activityId,
                  memo: `تخفيض مخزون بالتسوية: ${persisted.nameAr}`,
                },
              ]
            : [
                {
                  id: randomUUID(),
                  accountCode: invCode,
                  accountName: invAcc?.nameAr || 'مخزون النشاط',
                  debit: adjValNum,
                  credit: 0,
                  costCenterId: persisted.activityId,
                  memo: `زيادة جردية للمخزون: ${persisted.nameAr} - ${reason}`,
                },
                {
                  id: randomUUID(),
                  accountCode: '5205',
                  accountName: adjExpAcc?.nameAr || 'فروقات وتسويات وتلف المخزون',
                  debit: 0,
                  credit: adjValNum,
                  costCenterId: persisted.activityId,
                  memo: `فائض تسوية جردية: ${persisted.nameAr}`,
                },
              ];

          const { persisted: adjJv, linesWithUnits } = insertJournalEntryTx(database, actor.tenantId, {
            id: randomUUID(),
            entryNumber,
            date: nowIso.split('T')[0],
            description: `قيد تسوية مخزنية (${isShortage ? 'نقص/تلف' : 'زيادة جردية'}) - ${persisted.nameAr}: ${reason}`,
            costCenterId: persisted.activityId,
            branchId: activeBranch.id,
            lines: adjLines,
            status: 'POSTED',
            referenceType: 'INVENTORY',
            referenceId: persisted.id,
            isAutoGenerated: true,
          });
          for (const line of linesWithUnits) {
            updateAccountBalanceByLineTx(database, actor.tenantId, line.accountCode, line._debitUnits, line._creditUnits);
          }
          enqueueOutboxTx(database, actor, {
            entityType: 'JOURNAL_ENTRY',
            entityId: adjJv.id,
            action: 'CREATE',
            payload: adjJv,
            priority: 4,
            dependsOn: [persisted.id],
            idempotencyKey: `${actor.tenantId}_JOURNAL_ENTRY_${adjJv.id}_CREATE`,
            branchId: activeBranch.id,
            nowIso,
          });
        }

        writeAuditLogTx(
          database,
          actor,
          'تسوية مخزنية ذرية',
          `صنف ${persisted.nameAr}: تعديل (${deltaUnits > 0n ? '+' : ''}${unitsToNumber(deltaUnits, QTY_SCALE)})، السبب: ${reason}`,
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }

      return persisted;
    },

    // --- العملاء والموردون ---
    getParties(actor, type) {
      assertPermission(actor, 'party:view', 'عرض العملاء والموردين');
      const hasAdvCol = database.prepare('PRAGMA table_info(parties)').all().some((c) => c.name === 'advance_balance_decimal');
      const cols = hasAdvCol
        ? 'tenant_id,id,party_type,name_ar,phone,balance_decimal,advance_balance_decimal,data_json'
        : 'tenant_id,id,party_type,name_ar,phone,balance_decimal,data_json';
      const rows = type && VALID_PARTY_TYPES.has(type)
        ? database.prepare(
            `SELECT ${cols} FROM parties WHERE tenant_id = ? AND party_type = ? ORDER BY name_ar`
          ).all(actor.tenantId, type)
        : database.prepare(
            `SELECT ${cols} FROM parties WHERE tenant_id = ? ORDER BY name_ar`
          ).all(actor.tenantId);

      return rows.map((row) => {
        const parsed = parseRowJson(row);
        return {
          ...parsed,
          id: row.id,
          tenantId: row.tenant_id,
          type: row.party_type,
          nameAr: row.name_ar,
          phone: row.phone || '',
          balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'partyBalance'), MONEY_SCALE),
          advanceBalance: unitsToNumber(
            parseScaledInt(row.advance_balance_decimal ?? parsed.advanceBalance ?? '0', MONEY_SCALE, 'partyAdvance'),
            MONEY_SCALE
          ),
        };
      });
    },

    getPartyById(actor, id) {
      assertPermission(actor, 'party:view', 'عرض بيانات العميل/المورد');
      if (!id) return undefined;
      const hasAdvCol = database.prepare('PRAGMA table_info(parties)').all().some((c) => c.name === 'advance_balance_decimal');
      const cols = hasAdvCol
        ? 'tenant_id,id,party_type,name_ar,phone,balance_decimal,advance_balance_decimal,data_json'
        : 'tenant_id,id,party_type,name_ar,phone,balance_decimal,data_json';
      const row = database.prepare(
        `SELECT ${cols} FROM parties WHERE tenant_id = ? AND id = ?`
      ).get(actor.tenantId, String(id));
      if (!row) return undefined;
      const parsed = parseRowJson(row);
      return {
        ...parsed,
        id: row.id,
        tenantId: row.tenant_id,
        type: row.party_type,
        nameAr: row.name_ar,
        phone: row.phone || '',
        balance: unitsToNumber(parseScaledInt(row.balance_decimal, MONEY_SCALE, 'partyBalance'), MONEY_SCALE),
        advanceBalance: unitsToNumber(
          parseScaledInt(row.advance_balance_decimal ?? parsed.advanceBalance ?? '0', MONEY_SCALE, 'partyAdvance'),
          MONEY_SCALE
        ),
      };
    },

    savePartyAtomic(actor, party, isUpdate = false) {
      assertPermission(actor, isUpdate ? 'party:write' : 'party:create', isUpdate ? 'تعديل عميل/مورد' : 'إضافة عميل/مورد');
      if (!party || typeof party !== 'object') {
        throw new Error('بيانات العميل أو المورد غير صالحة.');
      }
      const nameAr = String(party.nameAr || '').trim();
      const type = String(party.type || '').trim();
      if (!nameAr) {
        throw new Error('اسم العميل أو المورد مطلوب.');
      }
      if (!VALID_PARTY_TYPES.has(type)) {
        throw new Error('نوع الطرف غير صالح (CUSTOMER أو SUPPLIER).');
      }

      const id = String(party.id || '').trim() || randomUUID();
      const nowIso = new Date().toISOString();
      let persisted;

      database.exec('BEGIN IMMEDIATE');
      try {
        const hasAdvCol = database.prepare('PRAGMA table_info(parties)').all().some((c) => c.name === 'advance_balance_decimal');
        const existingRow = hasAdvCol
          ? database.prepare('SELECT balance_decimal, advance_balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?').get(actor.tenantId, id)
          : database.prepare('SELECT balance_decimal, data_json FROM parties WHERE tenant_id = ? AND id = ?').get(actor.tenantId, id);

        if (existingRow && !isUpdate) {
          throw new Error('لا يمكن لصلاحية الإضافة فقط تعديل عميل مسجل مسبقاً.');
        }

        // Preserve audited balance and advanceBalance on update; only allow initial values on create.
        const existingParsed = existingRow ? parseRowJson(existingRow) : null;
        const balanceUnits = existingRow
          ? parseScaledInt(existingRow.balance_decimal, MONEY_SCALE, 'existingPartyBalance')
          : parseScaledInt(party.balance ?? 0, MONEY_SCALE, 'initialPartyBalance');
        const advanceUnits = existingRow
          ? parseScaledInt(existingRow.advance_balance_decimal ?? existingParsed?.advanceBalance ?? '0', MONEY_SCALE, 'existingPartyAdvance')
          : parseScaledInt(party.advanceBalance ?? 0, MONEY_SCALE, 'initialPartyAdvance');
        if (advanceUnits < 0n) {
          throw new Error('الرصيد المقدم للطرف لا يجوز أن يكون سالباً.');
        }

        const balanceNum = unitsToNumber(balanceUnits, MONEY_SCALE);
        const balanceDec = formatScaledInt(balanceUnits, MONEY_SCALE);
        const advanceNum = unitsToNumber(advanceUnits, MONEY_SCALE);
        const advanceDec = formatScaledInt(advanceUnits, MONEY_SCALE);

        persisted = {
          ...party,
          id,
          tenantId: actor.tenantId,
          type,
          nameAr,
          phone: String(party.phone || '').trim(),
          balance: balanceNum,
          advanceBalance: advanceNum,
        };

        if (hasAdvCol) {
          database.prepare(
            `INSERT INTO parties (tenant_id,id,party_type,name_ar,phone,balance_decimal,advance_balance_decimal,data_json)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(tenant_id,id) DO UPDATE SET
               party_type=excluded.party_type,
               name_ar=excluded.name_ar,
               phone=excluded.phone,
               data_json=excluded.data_json`
          ).run(
            actor.tenantId,
            persisted.id,
            persisted.type,
            persisted.nameAr,
            persisted.phone,
            balanceDec,
            advanceDec,
            JSON.stringify(persisted)
          );
        } else {
          database.prepare(
            `INSERT INTO parties (tenant_id,id,party_type,name_ar,phone,balance_decimal,data_json)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(tenant_id,id) DO UPDATE SET
               party_type=excluded.party_type,
               name_ar=excluded.name_ar,
               phone=excluded.phone,
               data_json=excluded.data_json`
          ).run(
            actor.tenantId,
            persisted.id,
            persisted.type,
            persisted.nameAr,
            persisted.phone,
            balanceDec,
            JSON.stringify(persisted)
          );
        }

        const actualUpdate = Boolean(existingRow) || isUpdate;
        enqueueOutboxTx(database, actor, {
          entityType: 'PARTY',
          entityId: persisted.id,
          action: actualUpdate ? 'UPDATE' : 'CREATE',
          payload: persisted,
          priority: 2,
          nowIso,
        });
        writeAuditLogTx(
          database,
          actor,
          `${actualUpdate ? 'تعديل' : 'إضافة'} ${persisted.type === 'CUSTOMER' ? 'عميل' : 'مورد'}`,
          `الطرف: ${persisted.nameAr}`,
          nowIso
        );
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }

      return persisted;
    },
  };
}
