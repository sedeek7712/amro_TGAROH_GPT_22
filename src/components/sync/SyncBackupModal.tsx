/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * مركز المزامنة السحابية وتعدد الأجهزة وطابور Outbox وإدارة الفروع
 * يدعم المزامنة ثنائية الاتجاه مع Django REST Framework و PostgreSQL / Supabase
 */

import React, { useState } from 'react';
import {
  RefreshCw,
  Download,
  Upload,
  Database,
  Server,
  Cloud,
  CheckCircle,
  AlertCircle,
  Copy,
  Check,
  RotateCcw,
  FileCode,
  Layers,
  Clock,
  ShieldAlert,
  Trash2,
  Activity,
  Wifi,
  WifiOff,
  Smartphone,
  ShieldCheck,
  ArrowDownUp,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  Plus,
  Store,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { dexieDataService } from '../../services/dexieDataService';
import { djangoSync, DjangoSyncConfig } from '../../services/djangoSyncService';
import { supabaseSync } from '../../services/supabaseSyncService';
import { syncQueueService } from '../../services/syncQueueService';
import { useNetworkStatus } from '../../services/networkMonitor';
import { useLiveOutbox, useLiveOutboxStats, useLiveConflicts, useLiveBranches } from '../../hooks/useLiveDexie';
import { OutboxQueueItem, SupabaseSyncConfig, CloudSyncResult, SyncConflict, Branch } from '../../types/erp';
import { SUPABASE_RLS_SQL } from '../../db/supabaseRlsPolicies';

interface SyncBackupModalProps {
  onRefresh: () => void;
}

type SyncTab = 'outbox' | 'branches' | 'supabase' | 'conflicts' | 'backup' | 'django';

export const SyncBackupModal: React.FC<SyncBackupModalProps> = ({ onRefresh }) => {
  const { isOnline } = useNetworkStatus();
  const outboxStats = useLiveOutboxStats();
  const conflicts = useLiveConflicts();
  const branches = useLiveBranches();
  const [activeTab, setActiveTab] = useState<SyncTab>('outbox');
  const [outboxFilter, setOutboxFilter] = useState<OutboxQueueItem['status'] | 'all'>('all');
  const liveOutboxItems = useLiveOutbox(outboxFilter);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    danger?: boolean;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  // حالة الفروع ونقاط البيع
  const [activeBranchId, setActiveBranchId] = useState<string>(() => storage.getActiveBranchId());
  const [showAddBranch, setShowAddBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchCode, setNewBranchCode] = useState('');
  const [newBranchAddress, setNewBranchAddress] = useState('');
  const [newBranchPhone, setNewBranchPhone] = useState('');
  const [newBranchIsMain, setNewBranchIsMain] = useState(false);

  // حالة Supabase
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseSyncConfig>(supabaseSync.getConfig());
  const [supabaseTestStatus, setSupabaseTestStatus] = useState<{
    tested: boolean;
    success?: boolean;
    message?: string;
    latencyMs?: number;
  }>({ tested: false });
  const [isTestingSupabase, setIsTestingSupabase] = useState(false);
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [cloudSyncResult, setCloudSyncResult] = useState<CloudSyncResult | null>(null);
  const [showRlsViewer, setShowRlsViewer] = useState(false);
  const [copiedRls, setCopiedRls] = useState(false);

  // حالة Django
  const [syncConfig, setSyncConfig] = useState<DjangoSyncConfig>(djangoSync.getConfig());
  const [connectionStatus, setConnectionStatus] = useState<{
    tested: boolean;
    success?: boolean;
    message?: string;
  }>({ tested: false });
  const [isTesting, setIsTesting] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [showSqlViewer, setShowSqlViewer] = useState(false);
  const [isSyncingOutbox, setIsSyncingOutbox] = useState(false);
  const [syncOutboxResult, setSyncOutboxResult] = useState<string | null>(null);
  const [isSyncingDjango, setIsSyncingDjango] = useState(false);
  const [djangoSyncStats, setDjangoSyncStats] = useState<{
    pushed: number;
    pulled: number;
    conflicts: number;
    errors: string[];
  } | null>(null);

  const sqlScript = storage.exportPostgreSqlSchemaAndData();

  const handleSyncAllDjango = async () => {
    setIsSyncingDjango(true);
    setDjangoSyncStats(null);
    try {
      const res = await djangoSync.syncAll();
      setDjangoSyncStats(res);
      onRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'خطأ غير متوقع';
      setDjangoSyncStats({ pushed: 0, pulled: 0, conflicts: 0, errors: [msg] });
    } finally {
      setIsSyncingDjango(false);
    }
  };

  // معالجة مزامنة طابور Outbox المحلي
  const handleSyncOutbox = async () => {
    setIsSyncingOutbox(true);
    setSyncOutboxResult(null);
    try {
      const res = await djangoSync.processOutboxQueue();
      if (res.processed === 0) {
        setSyncOutboxResult('لا توجد حركات معلقة أو حان موعد إرسالها في طابور Outbox.');
      } else if (res.failed === 0) {
        setSyncOutboxResult(`تمت مزامنة ${res.succeeded} حركة بنجاح مع مركز البيانات!`);
      } else {
        setSyncOutboxResult(`تم إرسال ${res.succeeded}، وفشل ${res.failed} حركة.`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'خطأ غير متوقع';
      setSyncOutboxResult(`فشل تشغيل المعالجة: ${msg}`);
    } finally {
      setIsSyncingOutbox(false);
      onRefresh();
    }
  };

  const handleRetryFailed = async () => {
    setFeedback(null);
    const count = await syncQueueService.retryFailedItems();
    if (count > 0) {
      setFeedback({ type: 'success', text: `تمت إعادة جدولة ${count} حركة متعثرة لإعادة المحاولة فوراً.` });
    } else {
      setFeedback({ type: 'info', text: 'لا توجد حركات متعثرة حالياً.' });
    }
    onRefresh();
  };

  const handlePurgeOldSynced = () => {
    setConfirmModal({
      title: 'تنظيف سجلات المزامنة القديمة',
      message: 'هل ترغب بتنظيف سجلات طابور المزامنة الناجحة التي مر عليها أكثر من 30 يوماً؟ لن يتم مس أي سجل معلق أو فاشل.',
      onConfirm: async () => {
        const count = await syncQueueService.purgeOldSyncedRecords(30);
        setFeedback({ type: 'success', text: `تم تنظيف ${count} سجل مزامنة ناجح وقديم.` });
        onRefresh();
      },
    });
  };

  // دوال إدارة الفروع ونقاط البيع
  const handleSelectActiveBranch = async (branchId: string) => {
    setFeedback(null);
    try {
      await dexieDataService.setActiveBranchId(branchId);
      setActiveBranchId(branchId);
      const cfg = djangoSync.getConfig();
      cfg.branchId = branchId;
      djangoSync.saveConfig(cfg);
      setFeedback({
        type: 'success',
        text: `تم تحويل نقطة البيع / الجهاز الحالي ليعمل تحت مظلة الفرع: ${branches.find((b) => b.id === branchId)?.nameAr || branchId}`,
      });
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'غير مصرح بالوصول إلى هذا الفرع.';
      setFeedback({ type: 'error', text: msg });
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!newBranchName.trim()) {
      setFeedback({ type: 'error', text: 'يرجى كتابة اسم الفرع.' });
      return;
    }
    const cleanCode = (newBranchCode.trim() || `BR${String(branches.length + 1).padStart(2, '0')}`).toUpperCase();
    if (branches.some((b) => b.code === cleanCode)) {
      setFeedback({
        type: 'error',
        text: `كود الفرع (${cleanCode}) مسجل مسبقاً! يرجى اختيار كود فريد لمنع تداخل أرقام الفواتير.`,
      });
      return;
    }

    const branch: Branch = {
      id: storage.generateUUID(),
      code: cleanCode,
      nameAr: newBranchName.trim(),
      isMain: newBranchIsMain,
      address: newBranchAddress.trim() || undefined,
      phone: newBranchPhone.trim() || undefined,
      active: true,
      createdAt: new Date().toISOString(),
    };

    try {
      await dexieDataService.addBranch(branch);
      setShowAddBranch(false);
      setNewBranchName('');
      setNewBranchCode('');
      setNewBranchAddress('');
      setNewBranchPhone('');
      setNewBranchIsMain(false);
      setFeedback({
        type: 'success',
        text: `تمت إضافة الفرع (${branch.nameAr}) بنجاح وتسجيله في طابور Outbox!`,
      });
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر إضافة الفرع.';
      setFeedback({ type: 'error', text: msg });
    }
  };

  // دوال Supabase
  const handleTestSupabase = async () => {
    setIsTestingSupabase(true);
    const res = await supabaseSync.testConnection();
    setSupabaseTestStatus({
      tested: true,
      success: res.success,
      message: res.message,
      latencyMs: res.latencyMs,
    });
    setIsTestingSupabase(false);
  };

  const handleSaveSupabaseConfig = () => {
    supabaseSync.saveConfig(supabaseConfig);
    setFeedback({ type: 'success', text: 'تم حفظ إعدادات الربط السحابي (Supabase) واسم الجهاز بنجاح.' });
  };

  const handleFullCloudSync = async () => {
    setIsSyncingCloud(true);
    setCloudSyncResult(null);
    try {
      const res = await supabaseSync.performFullBiDirectionalSync();
      setCloudSyncResult(res);
      setSupabaseConfig(supabaseSync.getConfig());
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'خطأ غير متوقع';
      setCloudSyncResult({
        pushedCount: 0,
        pulledCount: 0,
        conflictsCount: 0,
        errors: [msg],
        durationMs: 0,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsSyncingCloud(false);
    }
  };

  const handlePullDeltaOnly = async () => {
    setIsSyncingCloud(true);
    setFeedback(null);
    try {
      const res = await supabaseSync.pullDeltaFromSupabase();
      setFeedback({
        type: res.errors.length > 0 ? 'error' : 'success',
        text: `اكتمل جلب التحديثات السحابية: تم تنزيل وتحديث ${res.pulled} سجل، ورُصد ${res.conflicts} تعارض لحماية التعديلات المحلية.${res.errors.length ? ' (' + res.errors[0] + ')' : ''}`,
      });
      setSupabaseConfig(supabaseSync.getConfig());
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'خطأ غير متوقع';
      setFeedback({ type: 'error', text: `فشل جلب التحديثات: ${msg}` });
    } finally {
      setIsSyncingCloud(false);
    }
  };

  const handleCopyRlsSql = () => {
    navigator.clipboard.writeText(SUPABASE_RLS_SQL);
    setCopiedRls(true);
    setTimeout(() => setCopiedRls(false), 2000);
  };

  const handleDownloadRlsSql = () => {
    const blob = new Blob([SUPABASE_RLS_SQL], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `multi_activity_erp_supabase_rls_schema.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // دوال Django
  const handleTestConnection = async () => {
    setIsTesting(true);
    const res = await djangoSync.testConnection(syncConfig.serverUrl);
    setConnectionStatus({ tested: true, success: res.success, message: res.message });
    setIsTesting(false);
  };

  const handleSaveConfig = () => {
    djangoSync.saveConfig(syncConfig);
    setFeedback({ type: 'success', text: 'تم حفظ إعدادات خادم Django بنجاح.' });
  };

  // النسخ الاحتياطي JSON عبر المحرك الذري Dexie
  const handleDownloadJsonBackup = async () => {
    setFeedback(null);
    setIsWorking(true);
    try {
      const jsonStr = await dexieDataService.exportBackupJSON();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `multi_activity_erp_backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setFeedback({ type: 'success', text: 'تم تصدير النسخة الاحتياطية الكاملة مع التحقق Checksum بنجاح.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر تصدير النسخة الاحتياطية.';
      setFeedback({ type: 'error', text: msg });
    } finally {
      setIsWorking(false);
    }
  };

  const handleImportJsonBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setConfirmModal({
          title: 'تأكيد استعادة النسخة الاحتياطية',
          message: 'تنبيه: سيؤدي استيراد النسخة الاحتياطية إلى استبدال البيانات الحالية في IndexedDB بعد التحقق من سلامة Checksum. هل ترغب بالاستمرار؟',
          danger: true,
          onConfirm: async () => {
            const res = await dexieDataService.importBackupJSON(content);
            if (res.success) {
              setFeedback({ type: 'success', text: 'تمت استعادة النسخة الاحتياطية بنجاح!' });
              onRefresh();
            } else {
              setFeedback({
                type: 'error',
                text: `فشل استيراد النسخة الاحتياطية: ${res.error || 'الملف تالف أو غير صالح'}`,
              });
            }
          },
        });
      }
    };
    reader.readAsText(file);
  };

  const handleCopySql = () => {
    navigator.clipboard.writeText(sqlScript);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  const handleResetCleanBooks = () => {
    setConfirmModal({
      title: 'تحذير: تصفير الدفاتر التشغيلية',
      message: 'تحذير فائق الأهمية: هل أنت متأكد من تصفير كافة المعاملات والبدء بدفاتر بيضاء نظيفة تماماً؟ لا يمكن التراجع عن هذه العملية.',
      danger: true,
      onConfirm: async () => {
        try {
          await dexieDataService.resetToCleanBooks();
          setFeedback({ type: 'success', text: 'تمت تهيئة الدفاتر من جديد نظيفة وبيضاء بنجاح.' });
          onRefresh();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'تعذر تصفير الدفاتر.';
          setFeedback({ type: 'error', text: msg });
        }
      },
    });
  };

  const entityLabels: Record<string, string> = {
    INVOICE: 'فاتورة',
    JOURNAL_ENTRY: 'قيد محاسبي',
    PRODUCT: 'صنف / مخزون',
    AMANAT: 'سند أمانة',
    VOUCHER: 'سند مالي',
    PARTY: 'عميل / مورد',
    ACCOUNT: 'حساب',
    CASHBOX: 'صندوق',
  };

  const actionLabels: Record<string, { text: string; color: string }> = {
    CREATE: { text: 'إنشاء', color: 'bg-emerald-100 text-emerald-800' },
    UPDATE: { text: 'تعديل', color: 'bg-blue-100 text-blue-800' },
    DELETE: { text: 'حذف', color: 'bg-rose-100 text-rose-800' },
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto select-none">
      {/* Top Header & Connection Bar */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <span>مركز المزامنة السحابية وتعدد الأجهزة (Multi-Device ERP Sync)</span>
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                isOnline ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
              }`}
            >
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span>{isOnline ? 'الشبكة متصلة' : 'وضع دون إنترنت (Offline-First)'}</span>
            </span>
          </h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            محرك تخزين محلي ذري (Dexie IndexedDB) يضمن عدم فقدان المعاملات، مع مزامنة سحابية ثنائية الاتجاه مع Supabase وPostgreSQL تدعم عزل المؤسسات التام (RLS).
          </p>
        </div>

        {/* Global Quick Sync Action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleFullCloudSync}
            disabled={isSyncingCloud || !isOnline}
            className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:from-slate-200 disabled:to-slate-300 disabled:text-slate-500 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all shadow-xs"
          >
            <Cloud className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-bounce' : ''}`} />
            <span>{isSyncingCloud ? 'جارٍ التزامن السحابي...' : 'مزامنة السحابة الشاملة'}</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          role="alert"
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs font-bold ${
            feedback.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-blue-50 border-blue-200 text-blue-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'error' ? (
              <AlertCircle className="w-4 h-4 shrink-0" />
            ) : (
              <CheckCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-current opacity-70 hover:opacity-100 px-2"
          >
            إغلاق
          </button>
        </div>
      )}

      {/* Tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('outbox')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
            activeTab === 'outbox'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>طابور Outbox الذري</span>
          {outboxStats.pending > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500 text-white font-mono">
              {outboxStats.pending}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('branches')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
            activeTab === 'branches'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <Building2 className="w-4 h-4 text-emerald-500" />
          <span>الفروع ونقاط البيع</span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-mono font-bold">
            {branches.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('supabase')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
            activeTab === 'supabase'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <Cloud className="w-4 h-4 text-emerald-400" />
          <span>مزامنة السحابة وتعدد الأجهزة (Supabase / RLS)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('conflicts')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
            activeTab === 'conflicts'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <ShieldAlert className="w-4 h-4 text-rose-500" />
          <span>سجل التعارضات والتسوية</span>
          {conflicts.filter((c) => c.status === 'PENDING_REVIEW').length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-rose-600 text-white font-mono">
              {conflicts.filter((c) => c.status === 'PENDING_REVIEW').length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('backup')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
            activeTab === 'backup'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <Database className="w-4 h-4 text-blue-500" />
          <span>النسخ الاحتياطي اليدوي والدفاتر</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('django')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
            activeTab === 'django'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <Server className="w-4 h-4 text-amber-500" />
          <span>خادم Django REST (اختياري)</span>
        </button>
      </div>

      {/* =========================================================================
          TAB 1: OUTBOX QUEUE
      ========================================================================= */}
      {activeTab === 'outbox' && (
        <div className="space-y-6">
          {/* Controls Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
            <div className="text-xs text-slate-600">
              <span className="font-bold text-slate-800">حالة الطابور:</span> كل حركة تجارية تُحفظ أولاً في Dexie مع مفتاح عدم تكرار (Idempotency Key).
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSyncOutbox}
                disabled={isSyncingOutbox || outboxStats.pending === 0}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all shadow-xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingOutbox ? 'animate-spin' : ''}`} />
                <span>رفع المعلق الآن ({outboxStats.pending})</span>
              </button>

              {outboxStats.failed > 0 && (
                <button
                  type="button"
                  onClick={handleRetryFailed}
                  className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>إعادة المحاولة ({outboxStats.failed})</span>
                </button>
              )}

              {outboxStats.synced > 0 && (
                <button
                  type="button"
                  onClick={handlePurgeOldSynced}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                  <span>تنظيف المؤكدة القديمة</span>
                </button>
              )}
            </div>
          </div>

          {syncOutboxResult && (
            <div className="p-3 text-xs rounded-xl bg-slate-900 text-emerald-300 font-mono flex items-center justify-between border border-slate-800">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <span>{syncOutboxResult}</span>
              </div>
              <button onClick={() => setSyncOutboxResult(null)} className="text-slate-400 hover:text-white text-xs px-2 py-0.5">
                إغلاق
              </button>
            </div>
          )}

          {/* Outbox Metrics Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div
              onClick={() => setOutboxFilter('all')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                outboxFilter === 'all'
                  ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                  : 'bg-white border-slate-200 hover:border-slate-300 text-slate-800'
              }`}
            >
              <div className="text-[11px] font-semibold opacity-80">إجمالي الحركات</div>
              <div className="text-xl font-bold font-mono mt-1">{outboxStats.total}</div>
            </div>

            <div
              onClick={() => setOutboxFilter('PENDING')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                outboxFilter === 'PENDING'
                  ? 'bg-teal-600 border-teal-600 text-white shadow-xs'
                  : 'bg-white border-slate-200 hover:border-teal-200 text-slate-800'
              }`}
            >
              <div className="text-[11px] font-semibold text-teal-700">معلقة بانتظار الرفع</div>
              <div className="text-xl font-bold font-mono mt-1 text-teal-800">{outboxStats.pending}</div>
            </div>

            <div
              onClick={() => setOutboxFilter('SYNCING')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                outboxFilter === 'SYNCING'
                  ? 'bg-blue-600 border-blue-600 text-white shadow-xs'
                  : 'bg-white border-slate-200 hover:border-blue-200 text-slate-800'
              }`}
            >
              <div className="text-[11px] font-semibold text-blue-700">قيد الرفع اللحظي</div>
              <div className="text-xl font-bold font-mono mt-1 text-blue-800">{outboxStats.syncing}</div>
            </div>

            <div
              onClick={() => setOutboxFilter('SYNCED')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                outboxFilter === 'SYNCED'
                  ? 'bg-emerald-700 border-emerald-700 text-white shadow-xs'
                  : 'bg-white border-slate-200 hover:border-emerald-200 text-slate-800'
              }`}
            >
              <div className="text-[11px] font-semibold text-emerald-700">مؤكدة بالخادم (Synced)</div>
              <div className="text-xl font-bold font-mono mt-1 text-emerald-800">{outboxStats.synced}</div>
            </div>

            <div
              onClick={() => setOutboxFilter('FAILED')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                outboxFilter === 'FAILED'
                  ? 'bg-rose-700 border-rose-700 text-white shadow-xs'
                  : 'bg-white border-slate-200 hover:border-rose-200 text-slate-800'
              }`}
            >
              <div className="text-[11px] font-semibold text-rose-700">بحاجة لإعادة محاولة</div>
              <div className="text-xl font-bold font-mono mt-1 text-rose-800">{outboxStats.failed}</div>
            </div>
          </div>

          {/* Outbox Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-slate-700" />
                <h3 className="font-bold text-xs sm:text-sm text-slate-900">
                  سجلات طابور Outbox الحية ({liveOutboxItems.length})
                </h3>
              </div>
              <div className="text-[11px] text-slate-500">
                مرتبة حسب الأولوية: P1 الحركات المالية، P2 المخزون، P3 البيانات المرجعية
              </div>
            </div>

            {liveOutboxItems.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs">
                لا توجد حركات مسجلة تطابق التصفية الحالية.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 sticky top-0 font-bold">
                    <tr>
                      <th className="p-2.5">الأولوية</th>
                      <th className="p-2.5">المؤسسة</th>
                      <th className="p-2.5">نوع الكيان</th>
                      <th className="p-2.5">العملية</th>
                      <th className="p-2.5">التبعيات</th>
                      <th className="p-2.5">مفتاح عدم التكرار (Idempotency Key)</th>
                      <th className="p-2.5">الحالة</th>
                      <th className="p-2.5">المحاولات</th>
                      <th className="p-2.5">وقت الإنشاء</th>
                      <th className="p-2.5">تفاصيل الخطأ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {liveOutboxItems.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="p-2.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              item.priority === 1
                                ? 'bg-purple-100 text-purple-800'
                                : item.priority === 2
                                ? 'bg-blue-100 text-blue-800'
                                : item.priority === 3
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            P{item.priority || 3}
                          </span>
                        </td>
                        <td className="p-2.5 text-slate-700">{item.tenantId || 'tenant_default'}</td>
                        <td className="p-2.5 font-sans font-semibold text-slate-800">
                          {entityLabels[item.entityType] || item.entityType}
                        </td>
                        <td className="p-2.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-sans font-bold ${actionLabels[item.action]?.color}`}>
                            {actionLabels[item.action]?.text || item.action}
                          </span>
                        </td>
                        <td className="p-2.5 font-sans">
                          {item.dependsOn && item.dependsOn.length > 0 ? (
                            <span
                              className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-900 border border-amber-200 text-[10px] font-semibold"
                              title={`مرتبطة بـ: ${item.dependsOn.join(', ')}`}
                            >
                              مرتبطة بـ ({item.dependsOn.length})
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[10px]">مستقلة</span>
                          )}
                        </td>
                        <td className="p-2.5 text-[11px] text-slate-600 truncate max-w-[180px]" title={item.idempotencyKey}>
                          {item.idempotencyKey}
                        </td>
                        <td className="p-2.5 font-sans">
                          {item.status === 'PENDING' && (
                            <span className="inline-flex items-center gap-1 text-teal-700 font-bold text-[11px]">
                              <Clock className="w-3 h-3" /> بانتظار
                            </span>
                          )}
                          {item.status === 'SYNCING' && (
                            <span className="inline-flex items-center gap-1 text-blue-700 font-bold text-[11px]">
                              <RefreshCw className="w-3 h-3 animate-spin" /> قيد الرفع
                            </span>
                          )}
                          {item.status === 'SYNCED' && (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-bold text-[11px]">
                              <CheckCircle className="w-3 h-3" /> مؤكد
                            </span>
                          )}
                          {item.status === 'FAILED' && (
                            <span className="inline-flex items-center gap-1 text-rose-700 font-bold text-[11px]">
                              <AlertCircle className="w-3 h-3" /> فشل
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-slate-700">{item.retryCount}</td>
                        <td className="p-2.5 text-slate-500 text-[11px]">
                          {new Date(item.createdAt).toLocaleTimeString('ar-SA')}
                        </td>
                        <td className="p-2.5 text-rose-600 text-[11px] truncate max-w-[160px]" title={item.errorMessage}>
                          {item.errorMessage || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB: BRANCHES & POS MANAGEMENT (PHASE 5)
      ========================================================================= */}
      {activeTab === 'branches' && (
        <div className="space-y-6">
          {/* Header Card */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-emerald-600" />
                <h3 className="font-bold text-sm sm:text-base text-slate-900">
                  إدارة الفروع ونقاط البيع والأجهزة (Multi-Branch Engine)
                </h3>
              </div>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                يدعم تشغيل فروع ونقاط بيع متعددة تعمل بصورة مستقلة تماماً دون إنترنت (Offline-First) مع ترقيم فواتير مانع للتصادم (Collision-Proof) وربط كل حركة بفرعها.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowAddBranch(!showAddBranch)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all self-start sm:self-auto shrink-0 shadow-xs"
            >
              <Plus className="w-4 h-4" />
              <span>{showAddBranch ? 'إلغاء الإضافة' : 'إضافة فرع جديد'}</span>
            </button>
          </div>

          {/* New Branch Form */}
          {showAddBranch && (
            <form onSubmit={handleCreateBranch} className="bg-emerald-50/50 p-5 rounded-xl border border-emerald-200 space-y-4">
              <h4 className="text-xs font-bold text-emerald-900 flex items-center gap-1.5">
                <Store className="w-4 h-4 text-emerald-700" />
                <span>تسجيل فرع تجاري أو مستودع جديد</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    اسم الفرع <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder="مثال: فرع الشرقية / مستودع الحديدة"
                    className="w-full text-xs p-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    كود الفرع (بادئة الترقيم) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newBranchCode}
                    onChange={(e) => setNewBranchCode(e.target.value.toUpperCase())}
                    placeholder="مثال: BR02, BR03"
                    className="w-full text-xs p-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none font-mono"
                  />
                  <span className="text-[10px] text-slate-500 mt-0.5 block">
                    يستخدم لتوليد فواتير مستقلة: INV-BR02-2026-00001
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    العنوان / الموقع
                  </label>
                  <input
                    type="text"
                    value={newBranchAddress}
                    onChange={(e) => setNewBranchAddress(e.target.value)}
                    placeholder="المدينة، الشارع"
                    className="w-full text-xs p-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    هاتف الفرع
                  </label>
                  <input
                    type="text"
                    value={newBranchPhone}
                    onChange={(e) => setNewBranchPhone(e.target.value)}
                    placeholder="05XXXXXXXX"
                    className="w-full text-xs p-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <label className="inline-flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={newBranchIsMain}
                    onChange={(e) => setNewBranchIsMain(e.target.checked)}
                    className="rounded text-emerald-600 focus:ring-emerald-500"
                  />
                  <span>تعيين كفرع رئيسي للمنشأة</span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddBranch(false)}
                    className="px-3 py-1.5 bg-white text-slate-600 hover:bg-slate-100 border border-slate-300 rounded-lg text-xs font-semibold"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs"
                  >
                    حفظ الفرع في النظام
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Branches Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {branches.map((b) => {
              const isCurrentDeviceBranch = b.id === activeBranchId;

              return (
                <div
                  key={b.id}
                  className={`p-5 rounded-xl border transition-all ${
                    isCurrentDeviceBranch
                      ? 'bg-emerald-50/40 border-emerald-400 shadow-xs ring-1 ring-emerald-400'
                      : 'bg-white border-slate-200 hover:border-slate-300 shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-sm text-slate-900">{b.nameAr}</h4>
                        {b.isMain && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900">
                            الفرع الرئيسي
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-mono font-bold">
                          كود: {b.code}
                        </span>
                        <span className="text-xs text-slate-500">
                          بادئة الفواتير: {storage.generateBranchInvoiceNumber('INV', b.code)}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0">
                      {isCurrentDeviceBranch ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-xs">
                          <Check className="w-3.5 h-3.5" />
                          <span>الجهاز الحالي</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSelectActiveBranch(b.id)}
                          className="px-3 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-lg text-xs font-semibold transition-colors"
                        >
                          تحديد لهذا الجهاز
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Branch Details */}
                  <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-600 space-y-1">
                    {b.address && <div><span className="text-slate-400">العنوان:</span> {b.address}</div>}
                    {b.phone && <div><span className="text-slate-400">الهاتف:</span> {b.phone}</div>}
                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                      <span>تاريخ الإنشاء: {new Date(b.createdAt).toLocaleDateString('ar-SA')}</span>
                      <span className="text-emerald-700 font-semibold font-mono">UUID: {b.id.slice(0, 12)}...</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Technical Architecture Info Box */}
          <div className="bg-slate-900 text-white p-5 rounded-xl border border-slate-800 space-y-3">
            <h4 className="text-xs font-bold text-emerald-400 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>ضمانات معمارية الفروع المستقلة (Collision-Free Offline Guarantee)</span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-300 leading-relaxed">
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="font-bold text-white block mb-1">1. المفتاح الأساسي UUID v4</span>
                كل فاتورة وقيد وسند يحمل UUID فريد عالمياً لا يتكرر أبداً بين الأجهزة أو الفروع حتى لو عملت جميعها أشهراً بدون اتصال.
              </div>
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="font-bold text-white block mb-1">2. ترقيم الفواتير بكود الفرع</span>
                أرقام الفواتير الرسمية تعتمد النمط: <code className="text-emerald-300 font-mono">INV-BR01-2026-00001</code> و <code className="text-emerald-300 font-mono">INV-BR02-2026-00001</code>، مما يمنع تعارض الأرقام التسلسلية نهائياً.
              </div>
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="font-bold text-white block mb-1">3. عزل الحركات ومزامنة Outbox</span>
                كل حركة تسجل في طابور Outbox مع ترويسة <code className="text-amber-300 font-mono">X-Branch-ID</code> لضمان استقرار الخزائن والحسابات ومراكز التكلفة المحاسبية.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 2: SUPABASE & MULTI-DEVICE CLOUD SYNC (PHASE 5)
      ========================================================================= */}
      {activeTab === 'supabase' && (
        <div className="space-y-6">
          {/* Cloud Sync Status Banner */}
          {cloudSyncResult && (
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-white space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-sm text-emerald-400">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  <span>اكتملت دورة المزامنة السحابية بنجاح ({cloudSyncResult.durationMs}ms)</span>
                </div>
                <button
                  type="button"
                  onClick={() => setCloudSyncResult(null)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  إغلاق
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-2 text-xs">
                <div className="bg-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1">
                    <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" /> الحركات المرفوعة:
                  </span>
                  <span className="font-bold font-mono text-emerald-400 text-sm">{cloudSyncResult.pushedCount}</span>
                </div>

                <div className="bg-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1">
                    <ArrowDownLeft className="w-3.5 h-3.5 text-blue-400" /> السجلات المنزلة:
                  </span>
                  <span className="font-bold font-mono text-blue-400 text-sm">{cloudSyncResult.pulledCount}</span>
                </div>

                <div className="bg-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> تعارضات محمية:
                  </span>
                  <span className="font-bold font-mono text-amber-400 text-sm">{cloudSyncResult.conflictsCount}</span>
                </div>
              </div>

              {cloudSyncResult.errors.length > 0 && (
                <div className="mt-2 p-2 rounded bg-rose-950/60 border border-rose-800/50 text-[11px] text-rose-300 font-mono">
                  {cloudSyncResult.errors.map((err, i) => (
                    <div key={i}>• {err}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Section: Multi-Tenancy & Device Identity */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
                <Smartphone className="w-5 h-5 text-emerald-600" />
                <span>هوية الجهاز وعزل المؤسسة (Multi-Tenancy & Device Registration)</span>
              </div>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                UUID الثابت مفعل
              </span>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              وفق قواعد معمارية النظام، لكل جهاز معرف ثابت (Device UUID) لا يتغير، ولكل مؤسسة معرّف مستقل (tenant_id) يضمن عزل بياناتها المالية والمخزنية بالكامل ومنع أي تسرب بين المؤسسات.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  معرّف المؤسسة / المستأجر (Tenant ID):
                </label>
                <input
                  type="text"
                  value={supabaseConfig.tenantId}
                  onChange={(e) => setSupabaseConfig({ ...supabaseConfig, tenantId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  placeholder="tenant_default"
                />
                <span className="text-[10px] text-slate-400 block mt-1">يُحقن في كافة الترويسات وسياسات RLS</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  اسم الجهاز / نقطة البيع (Device Name):
                </label>
                <input
                  type="text"
                  value={supabaseConfig.deviceName}
                  onChange={(e) => setSupabaseConfig({ ...supabaseConfig, deviceName: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  placeholder="كاشير الصيدلية 1"
                />
                <span className="text-[10px] text-slate-400 block mt-1">يظهر في سجلات الرقابة وتتبع الحركات</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  معرّف الجهاز الثابت (Hardware Device UUID):
                </label>
                <input
                  type="text"
                  readOnly
                  value={supabaseConfig.deviceId}
                  className="w-full px-3 py-2 border border-slate-200 bg-slate-50 text-slate-600 rounded-lg text-xs font-mono cursor-not-allowed"
                />
                <span className="text-[10px] text-slate-400 block mt-1">معرّف آمن ثابت مخصص لهذا المتصفح</span>
              </div>
            </div>
          </div>

          {/* Section: Supabase Connection Configuration */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
                <Cloud className="w-5 h-5 text-teal-600" />
                <span>بيانات خادم Supabase السحابي (PostgREST API)</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowRlsViewer(true)}
                  className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors border border-slate-200"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>عرض سكريبت سياسات RLS</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  رابط مشروع Supabase (Project URL):
                </label>
                <input
                  type="text"
                  value={supabaseConfig.supabaseUrl}
                  onChange={(e) => setSupabaseConfig({ ...supabaseConfig, supabaseUrl: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  placeholder="https://xyzcompany.supabase.co"
                />
                <span className="text-[10px] text-slate-400 block mt-1">الرابط الخاص بمشروعك على منصة Supabase</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  المفتاح العام للمشروع (Anon Public Key):
                </label>
                <input
                  type="password"
                  value={supabaseConfig.supabaseAnonKey}
                  onChange={(e) => setSupabaseConfig({ ...supabaseConfig, supabaseAnonKey: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                />
                <span className="text-[10px] text-slate-400 block mt-1">يُستخدم للتحقق المشفر من قبل سياسات Row-Level Security</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={supabaseConfig.autoSync}
                    onChange={(e) => setSupabaseConfig({ ...supabaseConfig, autoSync: e.target.checked })}
                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-xs font-bold text-slate-800">
                    مزامنة سحابية دورية تلقائية (كل {supabaseConfig.syncIntervalSeconds} ثانية)
                  </span>
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleTestSupabase}
                  disabled={isTestingSupabase}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isTestingSupabase ? 'animate-spin' : ''}`} />
                  <span>فحص الاتصال والزمن</span>
                </button>

                <button
                  type="button"
                  onClick={handleSaveSupabaseConfig}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors shadow-xs"
                >
                  حفظ الإعدادات
                </button>
              </div>
            </div>

            {supabaseTestStatus.tested && (
              <div
                className={`p-3 rounded-lg border flex items-center gap-2 text-xs ${
                  supabaseTestStatus.success
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                {supabaseTestStatus.success ? (
                  <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
                )}
                <span>{supabaseTestStatus.message}</span>
              </div>
            )}
          </div>

          {/* Section: Action Center for Multi-Device Sync */}
          <div className="bg-slate-900 text-white rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 font-bold text-sm text-emerald-400">
                <ArrowDownUp className="w-5 h-5" />
                <span>مركز المزامنة اللحظية بين الأجهزة (Bi-Directional Cloud Engine)</span>
              </div>
              <div className="text-xs text-slate-400">
                آخر رفع: {supabaseConfig.lastPushTimestamp ? new Date(supabaseConfig.lastPushTimestamp).toLocaleTimeString('ar-SA') : 'لم يتم بعد'} | آخر تنزيل: {supabaseConfig.lastPullTimestamp ? new Date(supabaseConfig.lastPullTimestamp).toLocaleTimeString('ar-SA') : 'لم يتم بعد'}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              <div className="p-4 rounded-lg bg-slate-800/80 border border-slate-700 space-y-2">
                <div className="flex items-center gap-2 font-bold text-xs text-white">
                  <ArrowUpRight className="w-4 h-4 text-emerald-400" />
                  <span>المزامنة الكاملة ثنائية الاتجاه (Push Outbox + Pull Delta)</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  رفع كافة المعاملات المالية والمخزنية المحلية المعلقة بضمان تأكيد الخادم (Idempotency Key)، ثم سحب التحديثات الصادرة من الأجهزة ونقاط البيع الأخرى.
                </p>
                <button
                  type="button"
                  onClick={handleFullCloudSync}
                  disabled={isSyncingCloud || !isOnline}
                  className="w-full mt-2 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-xs"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-spin' : ''}`} />
                  <span>بدء المزامنة الشاملة الآن</span>
                </button>
              </div>

              <div className="p-4 rounded-lg bg-slate-800/80 border border-slate-700 space-y-2">
                <div className="flex items-center gap-2 font-bold text-xs text-white">
                  <ArrowDownLeft className="w-4 h-4 text-blue-400" />
                  <span>سحب التحديثات السحابية فقط (Delta Pull)</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  تنزيل الفواتير والأصناف والعملاء الجدد الذين تم تسجيلهم من أجهزة أخرى دون التأثير على الحركات المحلية غير المرفوعة ودون تغيير معرّفات UUIDs.
                </p>
                <button
                  type="button"
                  onClick={handlePullDeltaOnly}
                  disabled={isSyncingCloud || !isOnline}
                  className="w-full mt-2 py-2.5 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all"
                >
                  <ArrowDownLeft className="w-3.5 h-3.5 text-blue-400" />
                  <span>تنزيل تحديثات الأجهزة الأخرى</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB: CONFLICTS & FINANCIAL RECONCILIATION
      ========================================================================= */}
      {activeTab === 'conflicts' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
                <ShieldAlert className="w-5 h-5 text-rose-600" />
                <span>سجل التعارضات والتسوية المحاسبية (Conflict Reconciliation Log)</span>
              </div>
              <span className="text-xs px-2.5 py-1 bg-slate-100 text-slate-700 font-mono rounded-full font-bold">
                إجمالي التعارضات: {conflicts.length}
              </span>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              وفقاً للمعايير المحاسبية المعتمدة، يمنع النظام استبدال أو تعديل القيود والفواتير المرحّلة تلقائياً (منع LWW الأعمى).
              في حال تعارض بيانات بين أكثر من جهاز، يتم توثيق الحالة هنا بالكامل لتمكين المحاسب من مراجعة الطرفين وتسويتها بقيد عكسي أو إقرار يدوي موثق.
            </p>

            {conflicts.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto mb-2 opacity-80" />
                <p className="font-bold text-slate-800">لا توجد أي تعارضات مسجلة حالياً</p>
                <p className="text-[11px] text-slate-500 mt-1">كافة الحركات المالية والمخزنية متوافقة تماماً ومتسقة بين الأجهزة.</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[500px] border border-slate-200 rounded-lg">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold sticky top-0">
                    <tr>
                      <th className="p-3">نوع الكيان</th>
                      <th className="p-3">المعرف</th>
                      <th className="p-3">وقت الرصد</th>
                      <th className="p-3">الحالة</th>
                      <th className="p-3">سبب وملاحظة التعارض</th>
                      <th className="p-3 text-center">إجراء التسوية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    {conflicts.map((conf) => (
                      <tr key={conf.id} className="hover:bg-slate-50">
                        <td className="p-3 font-sans font-bold text-slate-800">
                          {entityLabels[conf.entityType] || conf.entityType}
                        </td>
                        <td className="p-3 text-slate-600 truncate max-w-[120px]" title={conf.entityId}>
                          {conf.entityId}
                        </td>
                        <td className="p-3 text-slate-500">
                          {new Date(conf.detectedAt).toLocaleString('ar-SA')}
                        </td>
                        <td className="p-3 font-sans">
                          {conf.status === 'PENDING_REVIEW' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-rose-100 text-rose-800 font-bold">
                              بانتظار المراجعة
                            </span>
                          )}
                          {conf.status === 'RESOLVED_LOCAL' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-bold">
                              اعتُمِد المحلي
                            </span>
                          )}
                          {conf.status === 'RESOLVED_REMOTE' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-800 font-bold">
                              اعتُمِد السحابي
                            </span>
                          )}
                          {conf.status === 'RESOLVED_MERGED' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-purple-100 text-purple-800 font-bold">
                              تمت التسوية
                            </span>
                          )}
                        </td>
                        <td className="p-3 font-sans text-slate-700 max-w-[240px]">
                          <p className="truncate" title={conf.notes}>{conf.notes || 'تعارض في الحركة'}</p>
                        </td>
                        <td className="p-3 font-sans text-center">
                          {conf.status === 'PENDING_REVIEW' ? (
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  await syncQueueService.resolveConflict(
                                    conf.id,
                                    'RESOLVED_LOCAL',
                                    'تم الإقرار باعتماد السجل المحلي دون تعديل'
                                  );
                                  onRefresh();
                                }}
                                className="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded text-[10px] font-bold"
                              >
                                اعتماد المحلي
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await syncQueueService.resolveConflict(
                                    conf.id,
                                    'RESOLVED_MERGED',
                                    'تمت التسوية المحاسبية وتوثيق الفارق'
                                  );
                                  onRefresh();
                                }}
                                className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 rounded text-[10px] font-bold"
                              >
                                تسوية وقيد
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-400 text-[10px]">مكتمل وموثق</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 3: BACKUP & BOOKS
      ========================================================================= */}
      {activeTab === 'backup' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Local Backup & Export (JSON) */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
              <div className="flex items-center gap-2 text-slate-900 font-bold text-sm border-b border-slate-100 pb-3">
                <Database className="w-5 h-5 text-blue-600" />
                <span>النسخ الاحتياطي الشامل للبيانات (Offline Backup)</span>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                يمكنك حفظ نسخة احتياطية مشفرة ومكتملة لكافة سجلات الدليل المحاسبي، المخزون، الفواتير، الأمانات، والعملاء،
                واستعادتها على أي جهاز كمبيوتر أو متصفح دون اتصال وبشكل آمن تماماً.
              </p>

              <div className="space-y-3 pt-2">
                <button
                  onClick={handleDownloadJsonBackup}
                  className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-xs"
                >
                  <Download className="w-4 h-4 text-emerald-400" />
                  <span>تحميل نسخة احتياطية كاملة (تنزيل ملف JSON)</span>
                </button>

                <div className="relative">
                  <input
                    type="file"
                    accept=".json"
                    id="backup-upload"
                    onChange={handleImportJsonBackup}
                    className="hidden"
                  />
                  <label
                    htmlFor="backup-upload"
                    className="w-full py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 rounded-lg text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <Upload className="w-4 h-4 text-slate-600" />
                    <span>استعادة البيانات من ملف نسخة احتياطية (رفع JSON)</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Clean Books Initialization */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-slate-900 font-bold text-sm border-b border-slate-100 pb-3">
                  <ShieldAlert className="w-5 h-5 text-rose-600" />
                  <span>تهيئة الدفاتر المحاسبية (Clean Books)</span>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed mt-3">
                  إعادة ضبط النظام إلى دفاتر نظيفة وبيضاء مع الاحتفاظ بشجرة الحسابات المعيارية والصناديق ومستخدم النظام المدير، ومسح كافة فواتير المبيعات والمشتريات التجريبية.
                </p>
              </div>

              <div className="pt-4">
                <button
                  onClick={handleResetCleanBooks}
                  className="w-full py-2.5 px-4 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>تصفير المعاملات والبدء بدفاتر بيضاء نظيفة</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 4: DJANGO REST CONFIG
      ========================================================================= */}
      {activeTab === 'django' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
                <Server className="w-5 h-5 text-amber-600" />
                <span>إعدادات خادم Django REST Framework</span>
              </div>
              <button
                type="button"
                onClick={() => setShowSqlViewer(!showSqlViewer)}
                className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors border border-slate-200"
              >
                <FileCode className="w-3.5 h-3.5 text-amber-600" />
                <span>استعراض سكريبت Django DDL</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">عنوان خادم Django REST:</label>
                <input
                  type="text"
                  value={syncConfig.serverUrl}
                  onChange={(e) => setSyncConfig({ ...syncConfig, serverUrl: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  placeholder="http://localhost:8000/api/v1"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">رمز المصادقة (Token / API Key):</label>
                <input
                  type="password"
                  value={syncConfig.apiToken || ''}
                  onChange={(e) => setSyncConfig({ ...syncConfig, apiToken: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  placeholder="Token xxxxxxxxxxxxxxxxxxxxx"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">معرف الفرع (Branch ID):</label>
                <input
                  type="text"
                  value={syncConfig.branchId}
                  onChange={(e) => setSyncConfig({ ...syncConfig, branchId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
                <span>فحص الاتصال بخادم Django</span>
              </button>

              <button
                type="button"
                onClick={handleSaveConfig}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors shadow-xs"
              >
                حفظ الإعدادات
              </button>
            </div>

            {connectionStatus.tested && (
              <div
                className={`p-3 rounded-lg border flex items-center gap-2 text-xs ${
                  connectionStatus.success
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                {connectionStatus.success ? (
                  <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
                )}
                <span>{connectionStatus.message}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL: SUPABASE RLS SECURITY POLICIES VIEWER
      ========================================================================= */}
      {showRlsViewer && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm">
                  سكريبت أمان صفوف الجداول وعزل المؤسسات (Supabase & PostgreSQL RLS)
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyRlsSql}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors border border-slate-700"
                >
                  {copiedRls ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedRls ? 'تم النسخ!' : 'نسخ الكود'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadRlsSql}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>تنزيل ملف .sql</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowRlsViewer(false)}
                  className="px-3 py-1.5 text-slate-400 hover:text-white text-xs"
                >
                  إغلاق
                </button>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-b border-slate-200 text-xs text-slate-700 leading-relaxed space-y-1">
              <div>
                • <strong>عزل المؤسسات التام (Multi-Tenancy):</strong> تفعيل <code className="bg-slate-200 px-1 rounded">ENABLE ROW LEVEL SECURITY</code> وفرض شرط <code className="bg-slate-200 px-1 rounded">tenant_id = current_app_tenant_id()</code> على كل جدول.
              </div>
              <div>
                • <strong>منع التكرار (Idempotency):</strong> قيد فريد <code className="bg-slate-200 px-1 rounded">(tenant_id, idempotency_key)</code> يمنع أي قيد محاسبي أو خصم مخزني مزدوج.
              </div>
              <div>
                • <strong>حظر الكاشير من القيود والأرباح:</strong> سياسة RLS تمنع الكاشير على مستوى قاعدة البيانات من استعراض قيود اليومية العامة أو تقارير الأرباح.
              </div>
            </div>

            <div className="p-4 overflow-y-auto flex-1 bg-slate-950 font-mono text-emerald-400 text-xs leading-relaxed select-text">
              <pre>{SUPABASE_RLS_SQL}</pre>
            </div>
          </div>
        </div>
      )}

      {/* Django SQL Viewer Modal */}
      {showSqlViewer && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode className="w-5 h-5 text-amber-400" />
                <h3 className="font-bold text-sm">مخطط جداول PostgreSQL لـ Django</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopySql}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors border border-slate-700"
                >
                  {copiedSql ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedSql ? 'تم النسخ!' : 'نسخ الكود'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowSqlViewer(false)}
                  className="px-3 py-1.5 text-slate-400 hover:text-white text-xs"
                >
                  إغلاق
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto flex-1 bg-slate-950 font-mono text-amber-300 text-xs leading-relaxed select-text">
              <pre>{sqlScript}</pre>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal replacing window.confirm */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className={`p-2 rounded-lg ${confirmModal.danger ? 'bg-rose-100 text-rose-700' : 'bg-blue-100 text-blue-700'}`}>
                <ShieldAlert className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-sm text-slate-900">{confirmModal.title}</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">{confirmModal.message}</p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isWorking}
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isWorking}
                onClick={async () => {
                  setIsWorking(true);
                  try {
                    await confirmModal.onConfirm();
                  } finally {
                    setIsWorking(false);
                    setConfirmModal(null);
                  }
                }}
                className={`px-4 py-2 text-xs font-bold text-white rounded-lg ${
                  confirmModal.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-800'
                }`}
              >
                {isWorking ? 'جارٍ التنفيذ...' : 'تأكيد'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
