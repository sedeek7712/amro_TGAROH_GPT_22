import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migratedScreens = [
  'src/components/pos/PointOfSale.tsx',
  'src/components/purchases/PurchasesManager.tsx',
  'src/components/inventory/InventoryManager.tsx',
  'src/components/accounting/AccountingModule.tsx',
  'src/components/cash/CashManager.tsx',
  'src/components/amanat/AmanatManager.tsx',
  'src/components/parties/PartiesManager.tsx',
  'src/components/users/UserPermissionsManager.tsx',
  'src/components/sync/SyncBackupModal.tsx',
];

const requiredContractMethods = [
  'createSalesInvoiceAtomic',
  'createPurchaseInvoiceAtomic',
  'saveProductAtomic',
  'deleteProductAtomic',
  'adjustProductStockAtomic',
  'createAccountAtomic',
  'createJournalEntryAtomic',
  'reverseJournalEntryAtomic',
  'createCashBoxAtomic',
  'createCashVoucherAtomic',
  'createAmanatDepositAtomic',
  'returnAmanatAtomic',
  'savePartyAtomic',
  'saveUserAtomic',
  'createUserAtomic',
];

const failures = [];
for (const relativePath of migratedScreens) {
  const absolutePath = path.join(root, relativePath);
  let source;
  try {
    source = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    failures.push(relativePath + ': unable to read file (' + error.message + ')');
    continue;
  }

  if (/from\s+['"][^'"]*services\/dexieDataService['"]/.test(source) ||
      /\bdexieDataService\s*\./.test(source)) {
    failures.push(relativePath + ': UI must use dataService, not dexieDataService directly');
  }
  if (!/from\s+['"][^'"]*services\/dataService['"]/.test(source)) {
    failures.push(relativePath + ': missing dataService contract import');
  }
}

const contract = readFileSync(path.join(root, 'src/services/dataService.ts'), 'utf8');
const contractBody = contract.slice(contract.indexOf('export interface IDataService'), contract.indexOf('// تصدير تطبيق'));
for (const method of requiredContractMethods) {
  const signature = new RegExp('\\b' + method + '\\s*\\(');
  if (!signature.test(contractBody)) failures.push('IDataService missing method: ' + method);
}
if (!/export const dataService:\s*IDataService\s*=/.test(contract)) {
  failures.push('dataService provider is not typed as IDataService');
}

const storageSource = readFileSync(path.join(root, 'src/services/storageService.ts'), 'utf8');
if (!/isDesktopElectronRuntime/.test(storageSource) || !/if\s*\(\s*isDesktopElectronRuntime\(\)\s*\)\s*return/.test(storageSource)) {
  failures.push('storageService.ts must isolate initialize() and legacy browser migration from Electron runtime');
}

const syncModalSource = readFileSync(path.join(root, 'src/components/sync/SyncBackupModal.tsx'), 'utf8');
if (/showSqlViewer\s*\?\s*storage\.exportPostgreSqlSchemaAndData\(\)/.test(syncModalSource) && !/!isDesktop\s*&&\s*showSqlViewer/.test(syncModalSource)) {
  failures.push('SyncBackupModal.tsx must guard legacy PostgreSQL DDL viewer from Electron runtime');
}

const inventoryManagerSource = readFileSync(path.join(root, 'src/components/inventory/InventoryManager.tsx'), 'utf8');
if (!/isDesktop\s*\?\s*''\s*:\s*inventory\.generateProductCode/.test(inventoryManagerSource)) {
  failures.push('InventoryManager.tsx must delegate product code generation on Electron instead of localStorage counter');
}

const familyModalSource = readFileSync(path.join(root, 'src/components/inventory/ProductFamilyModal.tsx'), 'utf8');
if (!/existingCodes:\s*existingCodes/.test(familyModalSource) || !/autoGenerateCode:\s*true/.test(familyModalSource)) {
  failures.push('ProductFamilyModal.tsx must pass existingCodes in direct submit path and delegate auto SKU codes in Electron');
}

const docLogSource = readFileSync(path.join(root, 'src/services/documents/notificationLogService.ts'), 'utf8');
if (!/sqliteDataService/.test(docLogSource) || !/DOCUMENT_OPERATION_AUDIT_ACTION/.test(docLogSource)) {
  failures.push('notificationLogService.ts must persist and read Electron document operation logs via SQLite audit provider');
}

if (failures.length) {
  console.error('FAIL: UI data-service boundary check');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('PASS: ' + migratedScreens.length + ' UI modules use the IDataService boundary (' +
    requiredContractMethods.length + ' required atomic methods and Electron data integrity boundaries verified)');
}
