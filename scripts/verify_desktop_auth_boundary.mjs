import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const failures = [];
const app = read('src/App.tsx');
const loginRouter = read('src/components/auth/LoginScreen.tsx');
const desktopLogin = read('src/components/auth/DesktopLoginScreen.tsx');
const adapter = read('src/services/desktopAuthAdapter.ts');

const dataServiceSource = read('src/services/dataService.ts');

if (!/if\s*\(isDesktopRuntime\)\s*return;[\s\S]{0,220}dexieDataService\.initialize\(\)/.test(app)) {
  failures.push('Windows runtime must not initialize the Dexie application database.');
}
if (/واجهة البيع والمخزون والمحاسبة لم تُربط بعد بخدمات SQLite/.test(app)) {
  failures.push('Temporary desktop blocker banner must be removed once SQLite data provider cutover is active.');
}
if (!/desktopSession\.hydrate\s*\(/.test(app) || !/onAuthInvalidated/.test(app)) {
  failures.push('App.tsx must hydrate desktopSession on desktop login and subscribe to onAuthInvalidated.');
}
if (!/sqliteDataService/.test(dataServiceSource) || !/amroDesktop/.test(dataServiceSource) || !/\?\s*sqliteDataService\s*:\s*dexieDataService/.test(dataServiceSource)) {
  failures.push('dataService.ts must select sqliteDataService in Electron runtime while keeping dexieDataService on Web.');
}
if (!/desktopAuthAdapter\.isAvailable\(\)/.test(loginRouter) || !/DesktopLoginScreen/.test(loginRouter)) {
  failures.push('Login router must select the dedicated Electron authentication screen.');
}
if (/dexieDataService|db\.users|authService\.(authenticate|completeInitialAdminSetup|completeMandatoryPasswordChange)/.test(desktopLogin)) {
  failures.push('Desktop login must never authenticate or persist users through Dexie/browser auth.');
}
if (!/getAuthSetupStatus\(\)/.test(adapter) || !/login\(input/.test(adapter) || !/completeMandatoryPasswordChange\(input/.test(adapter)) {
  failures.push('Desktop adapter is missing required typed authentication operations.');
}
if (/localStorage|sessionStorage|indexedDB/.test(adapter + desktopLogin)) {
  failures.push('Desktop authentication token/provider must not use browser storage.');
}
if (!/requireBridge\(\)/.test(adapter)) {
  failures.push('Desktop adapter must fail closed when the Electron bridge is absent.');
}

if (!/if\s*\(typeof window !== 'undefined' && window\.amroDesktop\) return;[\s\S]{0,180}let isMounted = true;/.test(read('src/hooks/useLiveDexie.ts'))) {
  failures.push('Live Dexie hooks must not open IndexedDB in the Electron runtime.');
}
if (!/if\s*\(typeof window !== 'undefined' && window\.amroDesktop\) return;[\s\S]{0,150}const timer = setInterval/.test(read('src/hooks/useLiveDexie.ts'))) {
  failures.push('Dexie init polling must be disabled in the Electron runtime.');
}

if (failures.length) {
  console.error('FAIL: desktop authentication & SQLite cutover boundary');
  failures.forEach((message) => console.error(' - ' + message));
  process.exitCode = 1;
} else {
  console.log('PASS: Windows authentication & SQLite data provider are isolated from Dexie and browser session storage.');
}
