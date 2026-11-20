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

if (failures.length) {
  console.error('FAIL: UI data-service boundary check');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('PASS: ' + migratedScreens.length + ' UI modules use the IDataService boundary (' +
    requiredContractMethods.length + ' required atomic methods verified)');
}
