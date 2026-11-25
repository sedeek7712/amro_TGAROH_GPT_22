/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * المكون الرئيسي للتطبيق (Root Application Component)
 * متجاوب بالكامل مع شاشات الهواتف والتابلت والكمبيوتر
 */

import React, { useState, useEffect, useCallback } from 'react';
import { storage } from './services/storageService';
import { authService } from './services/authService';
import { desktopAuthAdapter } from './services/desktopAuthAdapter';
import { desktopSession } from './services/desktopSession';
import { djangoSync } from './services/djangoSyncService';
import { supabaseSync } from './services/supabaseSyncService';
import { dexieDataService } from './services/dexieDataService';
import { useDexieInitStatus, useLiveCashBoxes, useLiveUsers } from './hooks/useLiveDexie';
import { ActivityId, SystemUser } from './types/erp';
import { ActiveView, canAccessView } from './config/rbac';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { LoginScreen } from './components/auth/LoginScreen';
import { CompanySettings } from './components/settings/CompanySettings';
import { ExecutiveDashboard } from './components/dashboard/ExecutiveDashboard';
import { PointOfSale } from './components/pos/PointOfSale';
import { InventoryManager } from './components/inventory/InventoryManager';
import { PurchasesManager } from './components/purchases/PurchasesManager';
import { AmanatManager } from './components/amanat/AmanatManager';
import { AccountingModule } from './components/accounting/AccountingModule';
import { PartiesManager } from './components/parties/PartiesManager';
import { CashManager } from './components/cash/CashManager';
import { ReportsManager } from './components/reports/ReportsManager';
import { UserPermissionsManager } from './components/users/UserPermissionsManager';
import { SyncBackupModal } from './components/sync/SyncBackupModal';
import { PWAInstallModal } from './components/common/PWAInstallModal';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Smartphone,
  Menu,
  X,
  ShieldAlert,
} from 'lucide-react';

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('dashboard');
  const [selectedActivity, setSelectedActivity] = useState<ActivityId | 'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [desktopToken, setDesktopToken] = useState<string | null>(null);
  const [desktopHydrating, setDesktopHydrating] = useState<boolean>(false);
  const [desktopAuthNotice, setDesktopAuthNotice] = useState<string | null>(null);
  const isDesktopRuntime = desktopAuthAdapter.isAvailable();
  const [showMobileBanner, setShowMobileBanner] = useState(() => {
    if (isDesktopRuntime) return false;
    if (typeof window !== 'undefined') {
      const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true;
      return !isStandalone;
    }
    return true;
  });

  const [currentUser, setCurrentUser] = useState<SystemUser>(() => desktopAuthAdapter.isAvailable()
    ? { id: '', username: '', fullName: '', role: 'CASHIER', allowedActivities: [], active: false }
    : authService.getCurrentActorSync() || storage.getCurrentUser());
  const cashBoxes = useLiveCashBoxes();
  const liveUsers = useLiveUsers();
  const initStatus = useDexieInitStatus();

  const isViewAllowed = canAccessView(currentUser?.role, activeView);

  useEffect(() => {
    if (isDesktopRuntime) return;
    dexieDataService.initialize().catch((err) => {
      console.error('[App] Error initializing Dexie storage:', err);
    });
  }, [isDesktopRuntime]);

  // استعادة جلسات الويب فقط؛ جلسة Windows تعيش داخل Electron main والذاكرة فقط
  useEffect(() => {
    if (isDesktopRuntime || initStatus.state !== 'READY' || liveUsers.length === 0) return;
    let cancelled = false;
    authService.validateSession(liveUsers).then((res) => {
      if (cancelled) return;
      if (res.valid && res.user) {
        setCurrentUser(res.user);
        setIsLoggedIn(true);
      } else if (isLoggedIn && !authService.getCurrentActorSync()) {
        setIsLoggedIn(false);
        setActiveView('dashboard');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, initStatus.state, liveUsers]);

  useEffect(() => {
    if (isDesktopRuntime) return;
    const onStorage = () => {
      if (initStatus.state !== 'READY' || liveUsers.length === 0) return;
      authService.validateSession(liveUsers).then((res) => {
        if (!res.valid || !res.user) {
          setIsLoggedIn(false);
          setActiveView('dashboard');
        } else {
          setCurrentUser(res.user);
        }
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isDesktopRuntime, initStatus.state, liveUsers]);

  useEffect(() => {
    if (!isDesktopRuntime || !window.amroDesktop) return;
    const unsubSession = desktopSession.subscribe((domains) => {
      if (domains.includes('session') || domains.includes('all')) {
        const actor = desktopSession.getActor();
        if (actor) setCurrentUser(actor);
        setDesktopToken(desktopSession.getToken());
      }
    });
    const unsubInvalidated = window.amroDesktop.onAuthInvalidated((reason) => {
      desktopSession.clear();
      setDesktopToken(null);
      setIsLoggedIn(false);
      setActiveView('dashboard');
      setDesktopAuthNotice(reason || 'تم إنهاء الجلسة تلقائياً لحماية قاعدة البيانات.');
    });
    return () => {
      unsubSession();
      unsubInvalidated();
    };
  }, [isDesktopRuntime]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
    const actor = authService.getCurrentActorSync();
    if (actor) setCurrentUser(actor);
  }, []);

  const handleLogout = useCallback(() => {
    if (isDesktopRuntime && desktopToken) {
      desktopAuthAdapter.logout(desktopToken).catch((error) => {
        console.error('[App] Desktop logout failed:', error);
      });
      desktopSession.clear();
    } else if (!isDesktopRuntime) {
      authService.logout();
    }
    setDesktopToken(null);
    setDesktopAuthNotice(null);
    setIsLoggedIn(false);
    setActiveView('dashboard');
  }, [desktopToken, isDesktopRuntime]);

  // حظر التمهيد عند فشل قاعدة البيانات (DB-03)
  if (initStatus.state === 'FAILED') {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 text-white p-6" dir="rtl">
        <div className="max-w-md w-full bg-slate-900 border border-rose-500/40 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
          <div className="w-12 h-12 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <h1 className="text-base font-bold text-white">تعذر تهيئة قاعدة البيانات المحلية</h1>
          <p className="text-xs text-slate-300 leading-relaxed">
            {initStatus.error || 'حدث خطأ أثناء فتح قاعدة البيانات المحاسبية. لحماية البيانات من الفقدان أو التضارب، تم إيقاف الكتابة لحين معالجة الخطأ.'}
          </p>
          <button
            onClick={() => {
              dexieDataService.resetForTests();
              dexieDataService.initialize().catch(() => {});
            }}
            className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition-colors"
          >
            إعادة محاولة التهيئة
          </button>
        </div>
      </div>
    );
  }

  // إذا لم يكن مسجلاً دخوله اعرض شاشة الدخول
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen w-full relative">
        {desktopAuthNotice && (
          <div
            dir="rtl"
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-lg w-[92%] bg-amber-950/95 border border-amber-500/50 text-amber-100 px-4 py-3 rounded-xl shadow-2xl flex items-center justify-between gap-3 text-xs"
          >
            <span>{desktopAuthNotice}</span>
            <button
              type="button"
              onClick={() => setDesktopAuthNotice(null)}
              className="p-1 text-amber-300 hover:text-white rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <LoginScreen
          onLogin={async (user, token) => {
            setDesktopAuthNotice(null);
            if (isDesktopRuntime && token) {
              setDesktopHydrating(true);
              try {
                desktopSession.setActorSession(token, user);
                await desktopSession.hydrate(token, user);
                await Promise.all([
                  djangoSync.refreshConfigFromDesktop(),
                  supabaseSync.refreshConfigFromDesktop(),
                ]);
                setDesktopToken(token);
                setCurrentUser(desktopSession.getActor() || user);
                setIsLoggedIn(true);
              } catch (err: unknown) {
                desktopSession.clear();
                setDesktopToken(null);
                setIsLoggedIn(false);
                setDesktopAuthNotice(
                  err instanceof Error
                    ? `تعذر تحميل بيانات جلسة SQLite: ${err.message}`
                    : 'تعذر تحميل بيانات الجلسة المكتبية من SQLite.'
                );
              } finally {
                setDesktopHydrating(false);
              }
              return;
            }
            setCurrentUser(user);
            setIsLoggedIn(true);
          }}
        />
        {desktopHydrating && (
          <div
            dir="rtl"
            className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center text-white text-sm font-bold"
          >
            جارٍ تهيئة جلسة SQLite المحلية وتحميل إعدادات الفروع...
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell-root flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900 font-sans antialiased select-none" dir="rtl">
      {/* Sidebar Navigation (Drawer on Mobile, Fixed on Desktop) */}
      <Sidebar
        activeView={activeView}
        setActiveView={setActiveView}
        selectedActivity={selectedActivity}
        setSelectedActivity={setSelectedActivity}
        currentUser={currentUser}
        isMobileOpen={isMobileMenuOpen}
        setIsMobileOpen={setIsMobileMenuOpen}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <div className="app-shell-content flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Top Header Bar */}
        <TopBar
          activeView={activeView}
          setActiveView={setActiveView}
          selectedActivity={selectedActivity}
          currentUser={currentUser}
          cashBoxes={cashBoxes}
        />

        {/* Mobile Install Promotion Banner */}
        {!isDesktopRuntime && showMobileBanner && (
          <div className="app-chrome-only lg:hidden bg-gradient-to-r from-emerald-800 via-teal-800 to-emerald-900 text-white px-3 py-2 flex items-center justify-between gap-2 text-xs shadow-md shrink-0 border-b border-emerald-700/50 select-none animate-fadeIn">
            <div
              className="flex items-center gap-2 flex-1 min-w-0"
            >
              <div className="w-7 h-7 rounded-lg bg-emerald-500/30 flex items-center justify-center shrink-0 border border-emerald-400/30">
                <Smartphone className="w-4 h-4 text-emerald-200" />
              </div>
              <div className="truncate">
                <span className="font-bold text-white text-[11px] block truncate">
                  تثبيت التطبيق على شاشة الهاتف
                </span>
                <span className="text-[10px] text-emerald-200 block truncate">
                  تشغيل فوري بملء الشاشة والعمل دون إنترنت
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setIsInstallModalOpen(true)}
                className="px-2.5 py-1 bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-lg text-[11px] font-bold shadow transition-colors"
              >
                تثبيت
              </button>
              <button
                onClick={() => setShowMobileBanner(false)}
                className="p-1 text-slate-300 hover:text-white rounded"
                title="إغلاق"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Viewport Content with RBAC Protection */}
        <main className="app-shell-main flex-1 overflow-y-auto bg-slate-50/60 pb-20 lg:pb-6">
          {!isViewAllowed ? (
            <div className="p-8 max-w-xl mx-auto my-12 bg-white rounded-2xl border border-rose-200 shadow-sm text-center space-y-4">
              <div className="w-12 h-12 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-slate-900">حظر برمجي: ليس لديك صلاحية الوصول لهذه الوحدة</h3>
              <p className="text-xs text-slate-600">
                حسابك مسجل بدور ({currentUser.role === 'CASHIER' ? 'كاشير نقطة بيع' : currentUser.role === 'INVENTORY_KEEPER' ? 'أمين مخزن' : currentUser.role}) وهو غير مصرح له بفتح هذه الوحدة حفاظاً على سرية البيانات المحاسبية وأمان المنشأة.
              </p>
              <button
                onClick={() => setActiveView('dashboard')}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800 transition-colors"
              >
                العودة للوحة الرئيسية
              </button>
            </div>
          ) : (
            <>
              {activeView === 'dashboard' && (
                <ExecutiveDashboard
                  key={refreshKey}
                  setActiveView={setActiveView}
                  setSelectedActivity={setSelectedActivity}
                  onRefresh={handleRefresh}
                />
              )}

          {activeView === 'pos' && (
            <PointOfSale
              selectedActivity={selectedActivity}
              setSelectedActivity={setSelectedActivity}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'inventory' && (
            <InventoryManager
              selectedActivity={selectedActivity}
              setSelectedActivity={setSelectedActivity}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'purchases' && (
            <PurchasesManager
              key={selectedActivity}
              selectedActivity={selectedActivity}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'amanat' && (
            <AmanatManager onRefresh={handleRefresh} />
          )}

          {activeView === 'accounting' && (
            <AccountingModule onRefresh={handleRefresh} />
          )}

          {activeView === 'parties' && (
            <PartiesManager onRefresh={handleRefresh} />
          )}

          {activeView === 'cash' && (
            <CashManager onRefresh={handleRefresh} />
          )}

          {activeView === 'reports' && (
            <ReportsManager key={selectedActivity} selectedActivity={selectedActivity} />
          )}

          {activeView === 'users' && (
            <UserPermissionsManager
              currentUser={currentUser}
              setCurrentUser={setCurrentUser}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'sync' && (
            <SyncBackupModal onRefresh={handleRefresh} />
          )}
          {activeView === 'settings' && (
            <CompanySettings onRefresh={handleRefresh} />
          )}
            </>
          )}
        </main>

        {/* Mobile Bottom Navigation Bar (Barre inférieure pour mobile) */}
        <nav className="app-chrome-only lg:hidden fixed bottom-0 inset-x-0 bg-slate-950 text-slate-300 border-t border-slate-800 z-30 flex items-center justify-around py-1.5 px-2 shadow-2xl">
          <button
            onClick={() => setActiveView('dashboard')}
            className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
              activeView === 'dashboard' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
            }`}
          >
            <LayoutDashboard className="w-5 h-5" />
            <span>الرئيسية</span>
          </button>

          {canAccessView(currentUser.role, 'pos') && (
            <button
              onClick={() => setActiveView('pos')}
              className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
                activeView === 'pos' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              <ShoppingCart className="w-5 h-5" />
              <span>نقطة بيع</span>
            </button>
          )}

          {canAccessView(currentUser.role, 'inventory') && (
            <button
              onClick={() => setActiveView('inventory')}
              className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
                activeView === 'inventory' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Package className="w-5 h-5" />
              <span>المخزون</span>
            </button>
          )}

          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold text-slate-400 hover:text-white transition-colors"
          >
            <Menu className="w-5 h-5" />
            <span>القائمة</span>
          </button>
        </nav>
      </div>

      {/* PWA Mobile App Installation Modal */}
      {!isDesktopRuntime && (
        <PWAInstallModal
          isOpen={isInstallModalOpen}
          onClose={() => setIsInstallModalOpen(false)}
        />
      )}
    </div>
  );
}
