# التصميم الهندسي المقترح لدليل المنتجات والمتغيرات والوحدات
## PRODUCT CATALOG, VARIANTS & UNITS — TECHNICAL DESIGN

- **معرّف المهمة:** PVAR-002
- **يرتبط بـ:** PRODUCT_CATALOG_VARIANTS_SPEC.md وPRODUCT_CATALOG_VARIANTS_PLAN.md
- **تاريخ إعداد التصميم:** 2026-11-28
- **الحالة:** مسودة تصميم هندسي للمراجعة؛ ليست موافقة على تنفيذ Schema أو تعديل المحرك المالي.
- **نطاق الفحص:** قراءة فقط للكود الحالي في main عند SHA b1352053bab7f5769d0620843245a4791c6012f6.

---

## 1. الخلاصة التنفيذية

التصميم الأقل خطورة هو **إبقاء جدول Product الحالي كما هو باعتباره الصنف القابل للبيع والتخزين (SKU)**، وإضافة كيانات جانبية اختيارية تربط بعض الأصناف في مجموعة واحدة وتضيف العلامة التجارية ووحدات البيع والشراء.

بهذا القرار:
- لا يتحول Product القديم إلى كيان أب.
- لا تتغير معرفات المنتجات القديمة.
- تبقى الدفعات والصور والفواتير والقيود مرتبطة بمعرّف SKU الحالي.
- المنتج البسيط يظل Product مستقلًا، ولا يحتاج سجل مجموعة.
- متغيرات القميص أو قطع الغيار تكون Products مستقلة مرتبطة بمجموعة اختيارية.
- لا تحصل المجموعة الأب على رصيد مخزون أو سعر بيع أو قيد افتتاحي مستقل.
- تحويل الوحدة يتم في خدمة المجال الموثوقة، ويحفظ داخل الفاتورة كلقطة تاريخية.

**توصية التصميم:** اعتماد سجل وسيط اختياري product_catalog_meta لربط Product بمجموعة/علامة/قيم متغيرات، بدل تعديل هيكل Product الأساسي في أول Migration. هذا يقلل كسر التوافق، لكنه ما زال يحتاج مراجعة قيود قاعدة البيانات والنسخ والمزامنة.

## 2. أدلة من الكود الحالي

تم فحص ما يلي في main:

| الملف | ما يثبته |
|---|---|
| src/types/erp.ts | Product الحالي هو الصنف المخزني، وProductBatch مرتبط به، وInvoiceItem يحمل productId وunit وquantity وunitPrice |
| src/db/erpDatabase.ts | Dexie schema الحالي يصل إلى الإصدار 7؛ products وproductBatches جداول منفصلة |
| electron/sqlite/migrations/001_initial.sql | SQLite الأساسية تحتوي products وproduct_batches وinvoice_items وinvoice_stock_deductions |
| electron/sqlite/migrations/003_product_images.sql | صور الصنف مرتبطة بـ product_id مع FK يمنع حذف الصنف ذي الصور |
| electron/sqlite/modules/inventory-parties-service.mjs | حفظ Product ودفعاته يتم داخل SQLite transaction؛ المخزون محفوظ بوحدة كمية دقيقة |
| electron/sqlite/modules/financial-service.mjs | البيع يتحقق من تطابق كمية بنود الفاتورة وخصم المخزون حسب productId؛ الشراء يحدث الرصيد والدفعات والتكلفة |
| src/components/pos/PointOfSale.tsx | السلة حاليًا تنشئ بندًا من Product واحد، وتستخدم product.unit وproduct.sellPrice |
| src/components/purchases/PurchasesManager.tsx | بند الشراء الحالي يستخدم كمية ووحدة الصنف الحالية وتكلفة الوحدة نفسها |
| src/services/dataService.ts | عقود البيع والشراء والمرتجعات تمرر كميات مرتبطة بـ productId، ولا تتضمن unitId أو تحويلًا تاريخيًا |
| src/services/dexieDataService.ts | مسار Dexie ينفذ عمليات البيع والشراء والمرتجعات ضمن معاملات Dexie |
| electron/sqlite/modules/backup-sync-service.mjs وlegacy-backup-importer.mjs | تصدير/استيراد SQLite يجب أن يُحدّث صراحةً لأي جداول/كيانات جديدة |
| src/types/erp.ts وsrc/services/supabaseSyncService.ts | طابور المزامنة الحالي يعرف PRODUCT وPRODUCT_IMAGE، ولا يعرف بعد أنواع كيانات عائلة المنتج ووحداته |

### ملاحظة كمية حاسمة

الكود الحالي في SQLite يستخدم:
- QTY_SCALE = 10000 لدقة الكميات.
- MONEY_SCALE = 100 لدقة المبالغ.
- TOTALS_SCALE = 1000000 للحسابات المجمعة.
- عمليات BigInt وتقريب HALF_UP.

والبيع الحالي يقارن InvoiceItem.quantity مع كمية خصم المخزون. هذا يعمل عندما تكون وحدة الفاتورة هي نفسها وحدة المخزون. لا يصلح كما هو عندما تكون كمية الفاتورة "كرتون" وكمية المخزون "حبة".

هذه الملاحظة تستلزم تغيير عقد حركة المخزون والفاتورة في مرحلة تنفيذ مستقلة، ولا يجوز حلها بتغيير نص الوحدة في الواجهة فقط.

## 3. نموذج المجال المقترح

### 3.1 الكيانات

| الكيان | دوره | هل يحمل مخزونًا؟ |
|---|---|---|
| Product | الصنف الحالي القابل للبيع والتخزين، ويصبح SKU عند ربطه بمجموعة | نعم |
| ProductFamily | مجموعة وصفية اختيارية تجمع SKU متشابهة | لا |
| ProductCatalogMeta | ربط اختياري للصنف بمجموعة أو علامة وتسجيل خصائص المتغير | لا |
| Brand | دليل العلامات التجارية الاختياري | لا |
| ProductUnit | وحدة شراء/بيع بديلة تخص SKU واحدة ومعاملها | لا؛ حركة المخزون تبقى على Product |
| ProductBatch | التشغيلة الحالية التابعة لـ SKU | نعم، ضمن رصيد SKU |

### 3.2 رسم العلاقات

\`\`\`mermaid
erDiagram
    TENANT ||--o{ BRAND : owns
    TENANT ||--o{ PRODUCT_FAMILY : owns
    ACTIVITY ||--o{ PRODUCT_FAMILY : scopes
    BRAND o|--o{ PRODUCT_FAMILY : labels
    PRODUCT ||--o| PRODUCT_CATALOG_META : has
    PRODUCT_FAMILY o|--o{ PRODUCT_CATALOG_META : groups
    BRAND o|--o{ PRODUCT_CATALOG_META : labels_simple_product
    PRODUCT ||--o{ PRODUCT_UNIT : has_alternate_units
    PRODUCT ||--o{ PRODUCT_BATCH : has
    PRODUCT ||--o{ PRODUCT_IMAGE : has
    PRODUCT ||--o{ INVOICE_ITEM : sold_or_bought
    INVOICE ||--|{ INVOICE_ITEM : contains
    INVOICE ||--o{ INVOICE_STOCK_DEDUCTION : records
    INVOICE_ITEM o|--o{ INVOICE_STOCK_DEDUCTION : traces_line
\`\`\`

الرسم منطقي/مفاهيمي. أسماء الجداول النهائية وقيودها تحتاج تثبيتًا بعد مراجعة التصميم وقاعدة البيانات الفعلية.

### 3.3 كيف نمثل المنتج البسيط؟

- يبقى سجل Product كالمعتاد.
- لا يحتاج ProductFamily.
- لا يحتاج ProductCatalogMeta إلا إذا اختار المستخدم علامة تجارية أو بيانات كتالوج إضافية.
- وحدة Product.unit الحالية تعامل باعتبارها وحدة المخزون الأساسية التاريخية.
- وحدات بديلة يمكن إضافتها لاحقًا في ProductUnit.
- لا ينشأ سجل أب لمجرد دعم ميزة المتغيرات.

### 3.4 كيف نمثل المنتج المتغير؟

مثال مجموعة "قميص رجالي":
- ProductFamily واحد للاسم المشترك والنشاط والتصنيف وخيارات اللون والمقاس.
- عدة سجلات Product، مثل أبيض-M وأسود-L، ولكل واحد Product.id وكود وباركود ورصيد وأسعار.
- سجل ProductCatalogMeta لكل SKU تابع، يحوي familyId وvariantAttributes وvariantKey.
- لا ينشأ رصيد للمجموعة، ولا تدخل المجموعة في بيع/شراء مستقل.

**قيد مجال:** يجب أن يطابق نشاط SKU نشاط المجموعة. وفي النسخة الأولى يجب أن يتوافق التصنيف والعلامة بين أفراد المجموعة، أو تُدار من المجموعة مع منع التباين غير المقصود. لا يسمح بتجميع صنف من نشاط مختلف.

## 4. تصميم التخزين المقترح

> الجداول أدناه مقترحة وليست Migration جاهزة. لم تُنشأ أو تُنفذ أي منها.

### 4.1 brands

دليل اختياري للعلامات التجارية داخل المؤسسة.

الحقول المنطقية:
- tenant_id
- id
- name_ar
- normalized_name
- is_active
- data_json

القيود:
- مفتاح أساسي مركب (tenant_id, id).
- الاسم المعياري فريد داخل المؤسسة بعد التطبيع.
- لا تحذف العلامة إذا ارتبطت بمنتجات؛ أرشفها.
- تطبيع الاسم يكون بدالة واحدة مشتركة تختبر المسافات وحالة الأحرف وتطبيع Unicode دون حذف اختلافات عربية ذات معنى.

### 4.2 product_families

مجموعة المنتج الاختيارية.

الحقول المنطقية:
- tenant_id
- id
- activity_id
- name_ar
- category_snapshot
- brand_id اختياري
- option_schema_json
- is_active
- created_at / updated_at
- data_json

مثال option_schema_json:
\`\`\`json
[
  {"key":"color","labelAr":"اللون","values":["أبيض","أسود","أزرق"],"required":true,"sortOrder":1},
  {"key":"size","labelAr":"المقاس","values":["M","L","XL"],"required":true,"sortOrder":2}
]
\`\`\`

النسخة الأولى تدعم خيارات اختيارية ذات قيم محددة (Select). لا نضيف في نفس المرحلة نظامًا عامًا للحقول الحرة أو المعادلات أو القياسات المتقدمة.

### 4.3 product_catalog_meta

سجل جانبي اختياري لكل Product يحتاج بيانات كتالوج جديدة.

الحقول المنطقية:
- tenant_id
- product_id
- family_id قابل لأن يكون NULL
- brand_id قابل لأن يكون NULL للمنتج البسيط
- variant_key قابل لأن يكون NULL للمنتج المستقل
- variant_attributes_json
- data_json

القيود:
- Product واحد لا ينتمي إلا لمجموعة واحدة.
- إذا كان family_id فارغًا، يكون variant_key فارغًا ويمثل السجل منتجًا مستقلًا.
- إذا كان family_id موجودًا، يجب أن توجد variant_key صالحة وقيم متغيرات مطابقة لمخطط المجموعة.
- لا يجمع السجل بين brand_id مستقل وfamily_id في أول تصميم؛ علامة المتغيرات تُقرأ من المجموعة، أما المنتج البسيط فيمكن أن يحمل brand_id.
- مفتاح فريد مقترح: (tenant_id, family_id, variant_key) عند family_id غير فارغ.
- يحسب backend الـ variant_key من قيم مرتبة ومطبّعة، ولا يقبلها كقيمة موثوقة من renderer.

**سبب استخدام جدول جانبي:** لا نحتاج إضافة family_id وvariant fields إلى جدول products الأساسي أو إعادة بناء الجدول الحالي. تبقى سجلات المنتجات القديمة بلا meta وتُعامل كمنتجات مستقلة.

### 4.4 product_units

وحدات بديلة خاصة بكل SKU.

الحقول المنطقية:
- tenant_id
- id
- product_id
- code
- name_ar
- conversion_numerator
- conversion_denominator
- barcode اختياري
- is_sale_enabled
- is_purchase_enabled
- is_active
- sell_price_override_decimal اختياري
- purchase_price_override_decimal اختياري
- data_json

**الوحدة الأساسية لا تحتاج سجلًا جديدًا:** تظل Product.unit الحالية هي الوحدة الأساسية، ومعاملها دائمًا 1/1. وحدات ProductUnit كلها وحدات بديلة. هذا يحافظ على المنتجات القديمة دون ترحيل جماعي.

مثال:
- Product.unit = "حبة"
- ProductUnit = "كرتون"
- conversion_numerator = "24"
- conversion_denominator = "1"

بمعنى أن كل كرتون يساوي 24 وحدة أساسية.

### 4.5 فهارس وقيود مقترحة في SQLite

- brands: UNIQUE (tenant_id, normalized_name).
- product_families: FK إلى activities وbrands مع tenant_id.
- product_catalog_meta: FK إلى products وproduct_families وbrands باستخدام tenant_id، مع UNIQUE جزئي على (tenant_id, family_id, variant_key) عندما تكون family_id غير NULL.
- product_units: FK إلى products باستخدام tenant_id، وUNIQUE (tenant_id, product_id, code).
- فهرس barcode على product_units مع تحقق backend من عدم تعارضه مع products.barcode وأي وحدة أخرى في النطاق المقرر.
- كل عمليات الأرشفة تحتفظ بالتاريخ ولا تحذف سجلات مرتبطة بمستندات.

لا يمكن منع تعارض باركود بين جدول products وجدول product_units بقيد UNIQUE عادي واحد عبر الجدولين؛ لذلك يجب أن يكون هناك فحص مركزي ذري في خدمة المجال، مع فهارس مساعدة واختبار تزامن.

## 5. تصميم الوحدات والتحويل الدقيق

### 5.1 التمثيل الحسابي

التوصية الأولية تخزين معامل التحويل كنسبة صحيحة:
- conversion_numerator: نص عدد صحيح موجب.
- conversion_denominator: نص عدد صحيح موجب.

مثال:
- كرتون = 24/1 حبة.
- نصف صندوق = 12/1 حبة.
- وحدة تعبئة = 1/4 لتر، إذا كانت وحدة المخزون لترًا.

سبب ذلك تجنب تخزين معامل عشري عائم وتراكم أخطاء الكسور. الحساب يتم في backend باستخدام BigInt، ثم يحول الناتج إلى دقة الكمية الحالية QTY_SCALE=10000 وفق سياسة تقريب محددة ومختبرة. يجب رفض المعامل الصفري أو السالب أو غير الصحيح.

### 5.2 مثال حسابي

| الحركة | وحدة المستند | معامل التحويل | الكمية الأساسية | الرصيد |
|---|---:|---:|---:|---:|
| رصيد البداية | — | — | — | 0 حبة |
| شراء | 2 كرتون | 24 | +48 حبة | 48 |
| بيع | 3 حبات | 1 | -3 حبات | 45 |
| بيع | 1 كرتون | 24 | -24 حبة | 21 |

كل رصيد Product وBatch يبقى بوحدة المخزون الأساسية فقط.

### 5.3 الأسعار

- Product.sellPrice وProduct.purchasePrice الحاليان يبقيان سعر الوحدة الأساسية.
- يمكن لوحدة بديلة أن تحمل سعر بيع/شراء مقترحًا مستقلًا اختياريًا.
- إذا لم يوجد سعر بديل، يمكن عرض سعر محسوب من السعر الأساسي × معامل التحويل، مع تقريب العملة الحالية؛ لكن السعر النهائي يُراجع ويُتحقق منه قبل حفظ المستند.
- في فاتورة الشراء، تكلفة الوحدة التي يدخلها المستخدم هي تكلفة وحدة المستند. يحسب backend إجمالي السطر، ثم يكشف تكلفة الوحدة الأساسية من الكمية الأساسية، مع الحفاظ على سياسة المتوسط المرجح/الدفعات الحالية.
- لا يُسمح بتغيير معادلة المتوسط المرجح أو سياسة FEFO أو حساب تكلفة المبيعات ضمن هذا التصميم.

### 5.4 قواعد الإدخال

- المعامل موجب وغير قابل للتعديل بعد استخدامه في مستند مرحّل إلا بإنشاء إصدار/معامل جديد وفق سياسة معتمدة.
- لا يسمح بوحدة غير نشطة في مستند جديد.
- يمنع البيع بوحدة غير مفعلة للبيع والشراء بوحدة غير مفعلة للشراء.
- التعديلات على إعدادات الوحدة تؤثر على المستندات الجديدة فقط.
- رصيد الحد الأدنى والتسويات المخزنية والدفعات تظل بوحدة Product الأساسية في النسخة الأولى.

## 6. لقطة الوحدة داخل الفاتورة

هذه أهم نقطة في سلامة التاريخ.

### 6.1 حقول جديدة مقترحة داخل InvoiceItem

تظل الحقول القديمة كما هي:
- productId
- productName
- productCode
- batchNumber
- expiryDate
- unit
- quantity
- unitPrice
- discount
- total

ويضاف للمستند الجديد فقط:
- unitId: معرف وحدة المستند، أو BASE للوحدة الأساسية.
- unitNameSnapshot: اسم الوحدة عند إصدار الفاتورة.
- baseUnitNameSnapshot: اسم وحدة المخزون الأساسية وقت المستند.
- conversionNumeratorSnapshot.
- conversionDenominatorSnapshot.
- baseQuantity: الكمية المحولة إلى الوحدة الأساسية.

تبقى الحقول الجديدة اختيارية لأن الفواتير القديمة لا تحملها. لا تنفذ Migration لتعبئة تاريخ الفواتير القديمة بالافتراض.

### 6.2 معنى الكميات

- InvoiceItem.quantity: الكمية التي أدخلها الموظف بوحدة المستند.
- InvoiceItem.unitPrice: السعر لكل وحدة مستند.
- InvoiceItem.total: إجمالي السطر المحاسبي وفق الكمية والسعر والخصم.
- InvoiceItem.baseQuantity: كمية المخزون الأساسية الناتجة عن التحويل.
- StockDeductionRecorded.quantity: كمية المخزون الأساسية التي خُصمت أو أعيدت.
- StockDeductionRecorded.unitCost: تكلفة الوحدة الأساسية.

إذن لا يجوز مقارنة InvoiceItem.quantity مباشرة بخصم المخزون عند اختلاف الوحدة. المقارنة الجديدة تكون على InvoiceItem.baseQuantity، مع fallback واضح للسطر القديم الذي لا يحتوي عليها.

### 6.3 ربط الخصم بسطر الفاتورة

يضاف invoiceItemId اختياري إلى StockDeductionRecorded:
- إلزامي في السطور الجديدة ذات التحويل.
- اختياري للبيانات القديمة.
- يربط كمية الخصم وتكلفته بسطر الفاتورة المحدد، وليس بالمنتج وحده.

هذا مهم عندما يكون SKU نفسه موجودًا في سطرين مختلفين بوحدتين أو بدفعتين مختلفتين.

## 7. عقود الواجهات المقترحة

هذه عقود منطقية لـ TypeScript؛ لا تُنسخ إلى الكود قبل اعتماد التصميم النهائي.

### 7.1 الأنواع

\`\`\`ts
type VariantAttributeValues = Record<string, string>;

interface ProductFamily {
  id: string;
  tenantId: string;
  activityId: CommercialActivityId;
  nameAr: string;
  categorySnapshot?: string;
  brandId?: string;
  optionSchema: Array<{
    key: string;
    labelAr: string;
    values: string[];
    required: boolean;
    sortOrder: number;
  }>;
  isActive: boolean;
  updatedAt: string;
}

interface Brand {
  id: string;
  tenantId: string;
  nameAr: string;
  normalizedName: string;
  isActive: boolean;
}

interface ProductCatalogMeta {
  id: string;
  tenantId: string;
  productId: string;
  familyId?: string;
  brandId?: string; // للمنتج البسيط فقط في التصميم الأولي
  variantKey?: string;
  variantAttributes: VariantAttributeValues;
}

interface ProductUnit {
  id: string;
  tenantId: string;
  productId: string;
  code: string;
  nameAr: string;
  conversionNumerator: string;
  conversionDenominator: string;
  barcode?: string;
  isSaleEnabled: boolean;
  isPurchaseEnabled: boolean;
  isActive: boolean;
  sellPriceOverride?: number;
  purchasePriceOverride?: number;
}

interface ProductCatalogEntry {
  product: Product;
  family?: ProductFamily;
  variantAttributes: VariantAttributeValues;
  brand?: Brand;
  units: ProductUnit[]; // الوحدات البديلة فقط؛ base تأتي من Product.unit
}
\`\`\`

الهدف من ProductCatalogEntry أن لا نفرض على كل مكونات النظام معرفة تفاصيل التخزين الجانبي؛ تحافظ واجهة العرض على Product الحالي، وتطلب بيانات الكتالوج عند الحاجة.

### 7.2 واجهات IDataService المقترحة

- getProductCatalog(activityId?)
- getProductCatalogEntry(productId)
- createProductFamilyWithSkus(input) — عملية ذرية تحفظ المجموعة وSKU التابعة وبيانات الربط دون رصيد أب.
- updateProductFamily(input)
- archiveProductFamily(familyId)
- saveProductUnits(productId, units) — تحقق ذري من الوحدة والتكرار والباركود.
- resolveProductScanCode(code) — يعيد SKU والوحدة المطابقة، سواء كان الباركود للمنتج أو لوحدة بديلة.

لا تحذف العقود الحالية getProducts/saveProductAtomic/createSalesInvoiceAtomic وغيرها. تضاف العقود الجديدة تدريجيًا مع إبقاء التوافق.

### 7.3 عقد البيع المقترح

طلب البيع الجديد يحدد:
- invoice item id.
- productId (SKU).
- unitId أو BASE.
- quantity المدخلة بوحدة المستند.
- batchNumber عند اللزوم.

الخدمة الموثوقة:
1. تتحقق من وجود SKU ومن نشاطه وصلاحية المستخدم.
2. تحمل تعريف الوحدة الحالية المملوك لنفس SKU.
3. تتحقق أن الوحدة فعالة ومسموح بها للبيع.
4. تحسب baseQuantity بنفسها باستخدام BigInt.
5. تحفظ لقطة التحويل في InvoiceItem.
6. تخصم baseQuantity من Product/Batch مع تسجيل invoiceItemId.
7. تحتسب COGS من سياسة المخزون الحالية على كمية الأساس.
8. تنفذ الفاتورة والمخزون والقيد وOutbox في المعاملة الذرية القائمة.

لا تثق في conversion factor أو baseQuantity أرسلها renderer؛ هذه القيم يحسبها backend من تعريف الوحدة الموثوق ويحفظها كلقطة.

### 7.4 عقد الشراء المقترح

طلب الشراء يحدد لكل سطر:
- invoiceItemId.
- productId.
- unitId أو BASE.
- entered quantity.
- costPrice لكل وحدة مستند.
- batchNumber وexpiryDate عند الحاجة.

الخدمة تتحقق من الوحدة ثم تحسب baseQuantity، وتضيف المخزون الأساسي إلى SKU/Batch، وتحسب تكلفة الوحدة الأساسية من إجمالي السطر والكمية الأساسية، مع عدم تغيير سياسة landed cost أو المتوسط المرجح الحالية.

### 7.5 عقد المرتجعات المقترح

لكل مرتجع جديد:
- originalInvoiceId.
- originalInvoiceItemId.
- quantity المراد ردها بوحدة السطر الأصلي.
- batch/سبب/طريقة رد حسب العقد الحالي.

تستخرج الخدمة معامل التحويل من السطر الأصلي، لا من تعريف الوحدة الحالي. وبذلك لا يتغير معنى المرتجع إذا تغير معامل الكرتون بعد إصدار الفاتورة.

للتوافق:
- السطر القديم بلا unit snapshot يبقى على مسار legacy الحالي.
- لا تفرض invoiceItemId على بيانات تاريخية لم تكن تحفظه.
- أي مرتجع جديد لمستند جديد يستخدم ارتباط السطر الأصلي لمنع الخلط بين سطرين لنفس SKU.

## 8. طبقات التنفيذ التي يجب أن تتغير مستقبلًا

### الواجهة ومصدر البيانات
- src/types/erp.ts: الأنواع الجديدة وحقول اللقطة الاختيارية.
- src/services/dataService.ts: عقود الكتالوج والوحدات والفواتير والمرتجعات.
- src/services/dexieDataService.ts: تنفيذ معاملات Dexie.
- src/services/sqliteDataService.ts: تمرير العقود إلى Desktop bridge.
- src/hooks/useLiveDexie.ts: Hooks لبيانات الكتالوج والوحدات عند الحاجة.
- src/types/desktop.d.ts: أنواع IPC الآمنة.
- electron/preload.cjs: expose methods محددة فقط.
- electron/main.mjs: IPC handlers مع assertTrustedMainFrame.
- electron/sqlite/desktop-backend.mjs: تحقق الجلسة والفاعل وتنسيق الخدمات.
- electron/sqlite/modules/inventory-parties-service.mjs: إدارة المجموعات والـ SKU والوحدات والتحقق منها.
- electron/sqlite/modules/financial-service.mjs: التحويل والبيع والشراء والمرتجعات وحفظ اللقطات.

### الواجهات التي تحتاج التوصيل
- src/components/inventory/InventoryManager.tsx
- src/components/pos/PointOfSale.tsx
- src/components/purchases/PurchasesManager.tsx
- مكونات البحث والباركود والإيصالات والتقارير التي تعرض بيانات SKU.

### الأمان
- صلاحية inventory write/read الحالية لا تعني تلقائيًا صلاحية تغيير العلامات أو تكوين المتغيرات.
- يجب التحقق من tenant/activity/branch في خدمات المجال.
- يجب رفض familyId أو productId تابع لمؤسسة أو نشاط غير مصرح.
- يجب أن يكون حفظ مجموعة مع عدة SKU عملية ذرية؛ لا تترك مجموعة بلا أفراد أو أفرادًا بلا ربط بسبب فشل جزئي.

## 9. SQLite وDexie وMigration المقترحة

### 9.1 SQLite
الإصدار الحالي الذي راجعناه يحتوي migrations حتى 003. المرشح التالي مبدئيًا هو:
004_product_catalog_variants_units.sql

ينشئ - بعد الموافقة - الجداول:
- brands
- product_families
- product_catalog_meta
- product_units

ويضيف الفهارس والقيود المناسبة. لا يُعدّل جدول products أو invoice_items الحالي إلا إذا أثبت التصميم التفصيلي أن هناك حاجة لعمود مفهرس إضافي؛ حقول لقطات المستند يمكن أولًا أن تبقى ضمن data_json مع تحديث hydrate/insert والتحقق من التوافق. لا تقم بإعادة بناء جدول invoices أو products لمجرد إضافة حقول اختيارية.

### 9.2 Dexie
الإصدار الحالي الذي راجعناه هو 7. المرشح المبدئي هو schema v8 لإضافة:
- brands
- productFamilies
- productCatalogMeta
- productUnits

مع فهارس مركبة وفريدة مساوية لقواعد SQLite قدر الإمكان. لا تعمل Upgrade يكتب قيمًا افتراضية في كل المنتجات القديمة. عدم وجود meta يعني منتجًا مستقلًا قديمًا.

### 9.3 عقد التوافق
- SQLite وDexie يجب أن يرجعا ProductCatalogEntry متكافئًا في السلوك.
- فحوص النشاط والمؤسسة والصلاحية تُطبق في خدمة المجال في كلا المسارين.
- لا تستخدم localStorage لتخزين بيانات الوحدات أو المتغيرات.
- لا تضف اعتمادًا جديدًا على Supabase أو خدمة سحابية لمسار Windows المحلي.
- يجب عدم إهمال مسار المزامنة التاريخي إذا كانت نسخة الويب ما زالت تستخدمه؛ قبل تفعيل مزامنة هذه الكيانات يجب تصميم Outbox entity types وترتيب dependencies والخرائط البعيدة. لا يُسمح بأن تزامن Products دون Family/Unit ثم تظهر بيانات ناقصة على جهاز آخر.

## 10. النسخ الاحتياطي والاستيراد والصور

- Dexie backup JSON الحالي يصدر جداول Products وProductBatches وInvoices وغيرها كمصفوفات منفصلة؛ يلزم إضافة arrays الجديدة إلى export/import مع default فارغ عند قراءة نسخة قديمة.
- SQLite backup-sync-service وlegacy-backup-importer يحفظان/يستعيدان جداول محددة؛ يجب تحديثهما لإدراج brands وfamilies وmeta وunits بترتيب FK صحيح.
- استيراد نسخة قديمة لا تحتوي هذه الكيانات يظل صالحًا، وتبقى منتجاتها مستقلة.
- صور Product الحالية مرتبطة بـ Product.id وproduct_images. في أول إصدار تظل صور SKU كما هي. صورة المجموعة العامة مؤجلة إلى قرار منفصل حتى لا نغير نظام ملفات الصور والنسخ والاستعادة بالتوازي دون ضرورة.
- اختبار restore يجب أن يثبت بقاء علاقات العائلة وSKU والوحدات والباركودات.

## 11. التوافق مع المزامنة التاريخية

المشروع يحتوي Outbox/Sync قديمًا ويعرف حاليًا أنواعًا مثل PRODUCT وPRODUCT_IMAGE. كيانات المجموعات والعلامات والوحدات لن تنتقل تلقائيًا بمجرد حفظها في SQLite أو Dexie.

قرار التصميم المقترح:
- Windows المحلي يعمل كاملًا دون اتصال ودون اعتماد Supabase جديد.
- لا تُحذف خدمات المزامنة الموجودة.
- أي إطلاق للميزة على مسار يستخدم المزامنة يجب أن يضيف أحداثًا ومخططات بعيدة واعتمادات وترتيب مزامنة مناسبًا، أو يثبت أن كل هذه المعلومات جزء من payload موثوق ومكتمل لمنتج/كتالوج.
- لا تعلن دعم المزامنة لهذه الميزة قبل اختبار إنشاء Family ثم SKU ثم Unit ثم Invoice على جهاز آخر.

يظل هذا قرارًا مفتوحًا لمرحلة التنفيذ، وليس إذنًا لتعديل تكاملات سحابية الآن.

## 12. خطة الترحيل والتوافق بلا فقد

1. أنشئ نسخة احتياطية سليمة من قاعدة اختبارية.
2. طبّق Migration على نسخة اختبارية فقط.
3. أضف الجداول الجديدة دون لمس سجلات Products القديمة.
4. تحقق أن كل Product قديم ما زال يظهر كمنتج مستقل.
5. أنشئ مجموعة جديدة وSKU جديدة ووحدات بديلة اصطناعية.
6. اختبر بيعًا وشراءً ومرتجعًا.
7. احسب أعداد Products وBatches وInvoices وInvoiceItems والقيود قبل/بعد.
8. قارن مجموع current stock وbatch quantities وقيم المخزون والقيود.
9. اختبر نسخة احتياطية واستعادة.
10. اختبر rollback من نسخة التطبيق التي سبقت Migration.
11. لا تطبق على بيانات مستخدم فعلية قبل موافقة المالك.

لا يوجد backfill مطلوب للمنتجات القديمة في هذا التصميم الأولي.

## 13. مصفوفة الاختبارات الهندسية

| المجال | الحالة المطلوبة | النتيجة المنتظرة |
|---|---|---|
| المنتج البسيط | إنشاء منتج دون Family | يعمل كما الحالي |
| المجموعة | إنشاء Family بنشاط واحد | لا رصيد أو قيد للأب |
| المتغيرات | إضافة أبيض-M وأسود-L | Product IDs مستقلة |
| التفرد | تكرار نفس تركيبة الخيارات | رفض واضح |
| العزل | SKU من tenant آخر | رفض من الخدمة |
| الباركود | مسح barcode لوحدة كرتون | إرجاع SKU + unitId الصحيح |
| تحويل الشراء | 2 كرتون × 24 | إضافة 48 للوحدة الأساسية |
| تحويل البيع | بيع 3 حبات ثم كرتون | الرصيد 45 ثم 21 |
| التكلفة | شراء بوحدة بديلة | حساب التكلفة لكل وحدة أساسية دون تغيير سياسة التقييم |
| الدفعات | صنف متتبع صلاحية | دفعاته بوحدة الأساس وFEFO يبقى صحيحًا |
| المرتجع | تغير معامل الوحدة بعد البيع | المرتجع يستخدم لقطة الفاتورة الأصلية |
| سطران لنفس SKU | وحدتان/دفعتان مختلفتان | المرتجع يحدد invoiceItemId الصحيح |
| legacy | فاتورة قديمة بلا unit snapshot | تظل قابلة للقراءة والمرتجع حسب مسارها القديم |
| Backup | نسخ واستعادة كيانات جديدة | عودة كل العلاقات |
| Dexie/SQLite | نفس السيناريو على المزودين | نتائج مجال متطابقة |
| التزامن | عائلة + SKU + وحدة + فاتورة | لا بيانات يتيمة ولا اعتماد ترتيب مفقود |
| ذرية | فشل منتصف حفظ Family وأبنائها | rollback كامل |
| محاسبة | بيع وشراء ومرتجع | القيد متوازن ونتائج المبالغ القديمة لا تتغير |

## 14. قرارات تحتاج موافقة/حسم قبل PVAR-004

هذه الخيارات لا ينبغي أن يحسمها المطور بصمت:

1. **الحد الأدنى لنطاق النسخة الأولى:** هل نعتمد مجموعة متغيرات + وحدات بديلة + علامة تجارية كلها في أول إصدار، أم نقسمها إلى إصدارات أصغر؟
2. **دقة التحويل:** هل نعتمد النسبة الصحيحة (numerator/denominator) مع تقريب HALF_UP إلى 4 منازل كما دقة المخزون الحالية، أم نرفض التحويل الذي لا ينتج كمية قابلة للتمثيل بدقة المخزون؟
3. **باركود وحدة التغليف:** هل نسمح لذات SKU بباركود للحبة وباركود آخر للكرتون؟ التوصية نعم، مع حل المسح إلى SKU + unit.
4. **السعر لكل وحدة:** التوصية أن يكون لكل وحدة سعر مستقل اختياري؛ وإذا لم يحدد، يُحسب افتراضيًا من سعر الأساس × معامل التحويل.
5. **الخصائص والصور:** التوصية أن تكون صور SKU وخصائص الأنشطة الحالية ضمن الإصدار الأول، وتأجيل صورة المجموعة والتتبع التسلسلي العام.
6. **المزامنة:** هل المطلوب تمكين Family/Unit sync بين الأجهزة في نفس الإصدار، أم يكفي حفظ محلي في Windows وDexie مع تعطيل أي ادعاء بالمزامنة حتى يكتمل عقدها؟

## 15. ما لم يحدث في PVAR-002

- لم تُنشأ Migration 004 أو Dexie v8.
- لم يتغير Product أو InvoiceItem في TypeScript.
- لم تتغير خدمات البيع أو الشراء أو المرتجعات.
- لم يتغير حساب التكلفة أو FEFO أو أي قيد محاسبي.
- لم تُعدل أي قاعدة مستخدم أو بيانات عمل.
- لم يُنفذ Build أو اختبار مجال لهذه الوثيقة.
- هذه وثيقة تصميم للمراجعة وليست ادعاء بأن الميزة موجودة.

## 16. بوابة الاستمرار

بعد مراجعة هذه الوثيقة:
1. يجيب المالك عن القرارات الستة في القسم 14 أو يعتمد التوصيات المقترحة.
2. تُقفل PVAR-002 بوصفها تصميمًا معتمدًا.
3. تبدأ PVAR-003 بإعداد fixtures واختبارات baseline على بيانات اصطناعية.
4. لا تبدأ PVAR-004 (Schema/Migrations) إلا بموافقة صريحة على التصميم النهائي وخطة backup/rollback.

**القرار الهندسي المركزي:** Product الحالي يظل SKU. المجموعة وصف وتجميع فقط. كل مخزون وحركة وفاتورة وتكلفة تظل على SKU. كل تحويل وحدة يحفظ تاريخيًا في سطر المستند، ويحسبه backend الموثوق.