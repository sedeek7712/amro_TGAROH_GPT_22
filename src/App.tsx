/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * المكون الرئيسي للتطبيق (Root Application Component)
 * متجاوب بالكامل مع شاشات الهواتف والتابلت والكمبيوتر
 */

import React, { useState, useEffect, useCallback } from 'react';
import { storage } from './services/storageService';
import { dexieDataService } from './services/dexieDataService';
import { useLiveCashBoxes } from './hooks/useLiveDexie';
import { ActivityId, SystemUser } from './types/erp';
import { Sidebar, ActiveView } from './components/layout/Sidebar';
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
  ShieldCheck,
  Menu,
  Smartphone,
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
  const [showMobileBanner, setShowMobileBanner] = useState(() => {
    if (typeof window !== 'undefined') {
      const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true;
      return !isStandalone;
    }
    return true;
  });

  const [currentUser, setCurrentUser] = useState<SystemUser>(() => storage.getCurrentUser());
  const cashBoxes = useLiveCashBoxes();

  // مصفوفة الصلاحيات لحماية مسارات الواجهة ومنع تجاوز الكاشير
  const ROLE_ALLOWED_VIEWS: Record<string, ActiveView[]> = {
    ADMIN: ['dashboard', 'pos', 'inventory', 'purchases', 'amanat', 'accounting', 'parties', 'cash', 'reports', 'users', 'sync', 'settings'],
    ACCOUNTANT: ['dashboard', 'pos', 'inventory', 'purchases', 'amanat', 'accounting', 'parties', 'cash', 'reports', 'sync'],
    INVENTORY_KEEPER: ['dashboard', 'inventory', 'purchases'],
    CASHIER: ['dashboard', 'pos', 'inventory'],
  };
  const isViewAllowed = (ROLE_ALLOWED_VIEWS[currentUser?.role || 'CASHIER'] || ROLE_ALLOWED_VIEWS.CASHIER).includes(activeView);

  useEffect(() => {
    dexieDataService.initialize().catch((err) => {
      console.warn('[App] Error initializing Dexie storage:', err);
    });
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
    setCurrentUser(storage.getCurrentUser());
  }, []);

  const handleLogout = useCallback(() => {
    setIsLoggedIn(false);
    setActiveView('dashboard');
  }, []);

  // إذا لم يكن مسجلاً دخوله اعرض شاشة الدخول
  if (!isLoggedIn) {
    return (
      <LoginScreen
        onLogin={(user) => {
          setCurrentUser(user);
          setIsLoggedIn(true);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900 font-sans antialiased select-none" dir="rtl">
      {/* Sidebar Navigation (Drawer on Mobile, Fixed on Desktop) */}
      <Sidebar
        activeView={activeView}
        setActiveView={setActiveView}
        selectedActivity={selectedActivity}
        setSelectedActivity={setSelectedActivity}
        currentUser={currentUser}
        isMobileOpen={isMobileMenuOpen}
        setIsMobileOpen={setIsMobileMenuOpen}
        onOpenInstallModal={() => setIsInstallModalOpen(true)}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Top Header Bar */}
        <TopBar
          activeView={activeView}
          setActiveView={setActiveView}
          selectedActivity={selectedActivity}
          currentUser={currentUser}
          cashBoxes={cashBoxes}
          onOpenMobileMenu={() => setIsMobileMenuOpen(true)}
          onOpenInstallModal={() => setIsInstallModalOpen(true)}
        />

        {/* Mobile Install Promotion Banner */}
        {showMobileBanner && (
          <div className="lg:hidden bg-gradient-to-r from-emerald-800 via-teal-800 to-emerald-900 text-white px-3 py-2 flex items-center justify-between gap-2 text-xs shadow-md shrink-0 border-b border-emerald-700/50 select-none animate-fadeIn">
            <div
              onClick={() => setIsInstallModalOpen(true)}
              className="flex items-center gap-2 cursor-pointer flex-1 min-w-0"
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
        <main className="flex-1 overflow-y-auto bg-slate-50/60 pb-20 lg:pb-6">
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
              key={refreshKey}
              selectedActivity={selectedActivity}
              setSelectedActivity={setSelectedActivity}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'inventory' && (
            <InventoryManager
              key={refreshKey}
              selectedActivity={selectedActivity}
              setSelectedActivity={setSelectedActivity}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'purchases' && (
            <PurchasesManager key={refreshKey} onRefresh={handleRefresh} />
          )}

          {activeView === 'amanat' && (
            <AmanatManager key={refreshKey} onRefresh={handleRefresh} />
          )}

          {activeView === 'accounting' && (
            <AccountingModule key={refreshKey} onRefresh={handleRefresh} />
          )}

          {activeView === 'parties' && (
            <PartiesManager key={refreshKey} onRefresh={handleRefresh} />
          )}

          {activeView === 'cash' && (
            <CashManager key={refreshKey} onRefresh={handleRefresh} />
          )}

          {activeView === 'reports' && (
            <ReportsManager key={refreshKey} />
          )}

          {activeView === 'users' && (
            <UserPermissionsManager
              key={refreshKey}
              currentUser={currentUser}
              setCurrentUser={setCurrentUser}
              onRefresh={handleRefresh}
            />
          )}

          {activeView === 'sync' && (
            <SyncBackupModal key={refreshKey} onRefresh={handleRefresh} />
          )}
          {activeView === 'settings' && (
            <CompanySettings key={refreshKey} onRefresh={handleRefresh} />
          )}
            </>
          )}
        </main>

        {/* Mobile Bottom Navigation Bar (Barre inférieure pour mobile) */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-slate-950 text-slate-300 border-t border-slate-800 z-30 flex items-center justify-around py-1.5 px-2 shadow-2xl">
          <button
            onClick={() => setActiveView('dashboard')}
            className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
              activeView === 'dashboard' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
            }`}
          >
            <LayoutDashboard className="w-5 h-5" />
            <span>الرئيسية</span>
          </button>

          <button
            onClick={() => setActiveView('pos')}
            className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
              activeView === 'pos' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
            }`}
          >
            <ShoppingCart className="w-5 h-5" />
            <span>نقطة بيع</span>
          </button>

          <button
            onClick={() => setActiveView('inventory')}
            className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
              activeView === 'inventory' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Package className="w-5 h-5" />
            <span>المخزون</span>
          </button>

          <button
            onClick={() => setActiveView('amanat')}
            className={`flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold transition-colors ${
              activeView === 'amanat' ? 'text-purple-400' : 'text-slate-400 hover:text-white'
            }`}
          >
            <ShieldCheck className="w-5 h-5" />
            <span>الأمانات</span>
          </button>

          <button
            onClick={() => setIsInstallModalOpen(true)}
            className="flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-bold text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <Smartphone className="w-5 h-5" />
            <span>تثبيت</span>
          </button>

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
      <PWAInstallModal
        isOpen={isInstallModalOpen}
        onClose={() => setIsInstallModalOpen(false)}
      />
    </div>
  );
}
