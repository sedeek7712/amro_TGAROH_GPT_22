/**
 * النظام المحاسبي المتكامل بالقيد المزدوج (Double-Entry Accounting & Ledger Module)
 * يشمل: دليل الحسابات الشجري، دفتر اليومية العامة، إنشاء القيود، ميزان المراجعة، وقائمة الدخل
 */

import React, { useState } from 'react';
import {
  Calculator,
  Plus,
  Search,
  BookOpen,
  PieChart,
  FileText,
  AlertCircle,
  CheckCircle,
  X,
  Check,
  ChevronDown,
  ChevronRight,
  Filter,
  DollarSign,
  ArrowRightLeft,
  Building2,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { accounting } from '../../services/accountingEngine';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { hasPermission } from '../../config/rbac';
import { getActiveCurrencyConfig, roundMoney } from '../../config/currency';
import { useLiveAccounts, useLiveJournalEntries } from '../../hooks/useLiveDexie';
import { Account, JournalEntry, JournalEntryLine, ActivityId, AccountType } from '../../types/erp';

interface AccountingModuleProps {
  onRefresh: () => void;
}

export const AccountingModule: React.FC<AccountingModuleProps> = ({ onRefresh }) => {
  const [activeTab, setActiveTab] = useState<'chart' | 'journal' | 'new_entry' | 'trial_balance' | 'income_statement'>('chart');
  const [selectedCostCenter, setSelectedCostCenter] = useState<ActivityId | 'general' | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // نموذج القيد العكسي (Reversal Entry)
  const [reversalModalEntry, setReversalModalEntry] = useState<JournalEntry | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [reversalError, setReversalError] = useState<string | null>(null);

  // نموذج قيد يدوي مركب
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [entryDescription, setEntryDescription] = useState('');
  const [entryCostCenter, setEntryCostCenter] = useState<ActivityId | 'general'>('general');
  const [entryLines, setEntryLines] = useState<
    Array<{
      accountCode: string;
      debit: string;
      credit: string;
      memo: string;
    }>
  >([
    { accountCode: '1101', debit: '', credit: '', memo: '' },
    { accountCode: '4101', debit: '', credit: '', memo: '' },
  ]);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entrySuccess, setEntrySuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // نموذج إضافة حساب جديد للشجرة
  const [isAddAccountModalOpen, setIsAddAccountModalOpen] = useState(false);
  const [newAccCode, setNewAccCode] = useState('');
  const [newAccName, setNewAccName] = useState('');
  const [newAccType, setNewAccType] = useState<AccountType>('ASSET');
  const [newAccParent, setNewAccParent] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);

  const actor = authService.getCurrentActorSync() || storage.getCurrentUser();
  const canViewProfits = hasPermission(actor, 'view:profits');
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const accounts = useLiveAccounts();
  const journalEntries = useLiveJournalEntries();
  const trialBalanceData = accounting.getTrialBalance(accounts, journalEntries);
  const incomeStatementData = accounting.getIncomeStatement(
    selectedCostCenter === 'all' ? undefined : selectedCostCenter,
    accounts,
    journalEntries
  );

  // حساب توازن القيد اليدوي لحظياً
  const totalDebit = entryLines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = entryLines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanceDifference = Math.abs(totalDebit - totalCredit);
  const isBalanced = balanceDifference < 0.009 && totalDebit > 0;

  const handleAddLine = () => {
    setEntryLines((prev) => [...prev, { accountCode: '', debit: '', credit: '', memo: '' }]);
  };

  const handleRemoveLine = (index: number) => {
    if (entryLines.length <= 2) return;
    setEntryLines((prev) => prev.filter((_, i) => i !== index));
  };

  const handleLineChange = (index: number, field: string, value: string) => {
    setEntryLines((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const handleSubmitJournalEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setEntryError(null);
    setEntrySuccess(null);

    if (!entryDescription.trim()) {
      setEntryError('يرجى كتابة شرح وبيان القيد المحاسبي.');
      return;
    }

    const lines: JournalEntryLine[] = entryLines.map((l) => {
      const acc = accounts.find((a) => a.code === l.accountCode);
      return {
        id: storage.generateUUID(),
        accountCode: l.accountCode,
        accountName: acc?.nameAr || l.accountCode,
        debit: roundMoney(Number(l.debit) || 0),
        credit: roundMoney(Number(l.credit) || 0),
        costCenterId: entryCostCenter,
        memo: l.memo || entryDescription.trim(),
      };
    });

    setIsSubmitting(true);
    try {
      const activeBranchId = storage.getActiveBranchId();
      const persisted = await dataService.createJournalEntryAtomic({
        id: storage.generateUUID(),
        entryNumber: '',
        date: entryDate,
        description: entryDescription.trim(),
        costCenterId: entryCostCenter,
        branchId: activeBranchId,
        lines,
        status: 'POSTED',
        referenceType: 'MANUAL',
        isAutoGenerated: false,
      });

      setEntrySuccess(`تم ترحيل القيد بنجاح برقم: ${persisted.entryNumber}`);
      setEntryDescription('');
      setEntryLines([
        { accountCode: '1101', debit: '', credit: '', memo: '' },
        { accountCode: '4101', debit: '', credit: '', memo: '' },
      ]);
      onRefresh();
    } catch (err: unknown) {
      setEntryError(err instanceof Error ? err.message : 'فشل في حفظ القيد');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveNewAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setAccountError(null);
    if (!newAccCode.trim() || !newAccName.trim()) {
      setAccountError('رمز الحساب واسمه مطلوبان.');
      return;
    }

    if (accounts.some((a) => a.code === newAccCode.trim())) {
      setAccountError('كود الحساب موجود مسبقاً في الدليل المحاسبي.');
      return;
    }

    const newAccount: Account = {
      code: newAccCode.trim(),
      nameAr: newAccName.trim(),
      type: newAccType,
      parentCode: newAccParent || null,
      isLeaf: true,
      balance: 0,
    };

    setIsSubmitting(true);
    try {
      await dataService.createAccountAtomic(newAccount);
      setIsAddAccountModalOpen(false);
      setNewAccCode('');
      setNewAccName('');
      setAccountError(null);
      onRefresh();
    } catch (err: unknown) {
      setAccountError(err instanceof Error ? err.message : 'تعذر إضافة الحساب.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredJournalEntries = journalEntries.filter((entry) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !searchQuery.trim() ||
      entry.entryNumber.toLowerCase().includes(q) ||
      entry.description.toLowerCase().includes(q);

    if (!matchesSearch) return false;

    if (selectedCostCenter !== 'all') {
      return entry.costCenterId === selectedCostCenter;
    }

    return true;
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Accounting Tabs Header */}
      <div className="flex items-center justify-between bg-white p-2.5 rounded-xl border border-slate-200">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            onClick={() => setActiveTab('chart')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'chart'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            شجرة ودليل الحسابات
          </button>
          <button
            onClick={() => setActiveTab('journal')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'journal'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            دفتر اليومية العامة ({journalEntries.length})
          </button>
          <button
            onClick={() => setActiveTab('new_entry')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'new_entry'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
            }`}
          >
            + قيد يومية يدوي جديد
          </button>
          <button
            onClick={() => setActiveTab('trial_balance')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === 'trial_balance'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            ميزان المراجعة
          </button>
          {canViewProfits && (
            <button
              onClick={() => setActiveTab('income_statement')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'income_statement'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              قائمة الدخل والأرباح
            </button>
          )}
        </div>

        {activeTab === 'chart' && (
          <button
            onClick={() => setIsAddAccountModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>إضافة حساب فرعي</span>
          </button>
        )}
      </div>

      {/* VIEW 1: شجرة الحسابات (Chart of Accounts) */}
      {activeTab === 'chart' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-slate-900">الدليل المحاسبي الشجري الموحد</h3>
              <p className="text-[11px] text-slate-500">
                مبني وفق معايير المحاسبة الدولية (الأصول، الخصوم، حقوق الملكية، الإيرادات، المصروفات)
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 font-bold">{accounts.length} حساب مسجل</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-100/60">
                  <th className="py-2.5 px-4">رقم / كود الحساب</th>
                  <th className="py-2.5 px-4">اسم الحساب</th>
                  <th className="py-2.5 px-4">النوع الرئيسي</th>
                  <th className="py-2.5 px-4">الحساب الأب</th>
                  <th className="py-2.5 px-4">مركز التكلفة المرتبط</th>
                  <th className="py-2.5 px-4 text-center">الرصيد الدفتري الحالي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.map((acc) => {
                  const typeColors: Record<AccountType, string> = {
                    ASSET: 'text-blue-700 bg-blue-50',
                    LIABILITY: 'text-purple-700 bg-purple-50',
                    EQUITY: 'text-amber-700 bg-amber-50',
                    REVENUE: 'text-emerald-700 bg-emerald-50',
                    EXPENSE: 'text-rose-700 bg-rose-50',
                  };

                  const typeLabels: Record<AccountType, string> = {
                    ASSET: 'أصول',
                    LIABILITY: 'خصوم',
                    EQUITY: 'حقوق ملكية',
                    REVENUE: 'إيرادات',
                    EXPENSE: 'مصروفات',
                  };

                  return (
                    <tr
                      key={acc.code}
                      className={`hover:bg-slate-50 ${!acc.isLeaf ? 'bg-slate-50/40 font-semibold' : ''}`}
                    >
                      <td className="py-2.5 px-4 font-mono font-bold text-slate-900">
                        <span style={{ marginRight: `${(acc.code.length - 1) * 8}px` }}>{acc.code}</span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span className={acc.isLeaf ? 'text-slate-800' : 'text-slate-950 font-bold'}>
                          {acc.nameAr}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${typeColors[acc.type]}`}>
                          {typeLabels[acc.type]}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-500">{acc.parentCode || 'رئيسي'}</td>
                      <td className="py-2.5 px-4 text-slate-600">
                        {acc.costCenterId ? (
                          <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 font-semibold">
                            {acc.costCenterId === 'pharmacy'
                              ? 'الصيدلية'
                              : acc.costCenterId === 'grocery'
                              ? 'البقالة'
                              : acc.costCenterId === 'bike_parts'
                              ? 'قطع الدراجات'
                              : acc.costCenterId === 'equipment_parts'
                              ? 'قطع المعدات'
                              : 'الإدارة العامة'}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-center font-mono tabular-nums font-bold text-slate-900">
                        {acc.balance.toFixed(2)} {currencySymbol}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 2: دفتر اليومية العامة (General Journal) */}
      {activeTab === 'journal' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث برقم القيد أو البيان..."
                className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">مركز التكلفة:</span>
              <select
                value={selectedCostCenter}
                onChange={(e) => setSelectedCostCenter(e.target.value as ActivityId | 'general' | 'all')}
                className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800"
              >
                <option value="all">كافة المراكز (الكل)</option>
                <option value="general">الإدارة العامة (CC-100)</option>
                <option value="pharmacy">الصيدلية (CC-101)</option>
                <option value="grocery">البقالة (CC-102)</option>
                <option value="bike_parts">قطع الدراجات (CC-103)</option>
                <option value="equipment_parts">قطع المعدات (CC-104)</option>
              </select>
            </div>
          </div>

          <div className="space-y-3">
            {filteredJournalEntries.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
                <BookOpen className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                <p className="font-semibold text-xs">لا توجد قيود مسجلة في هذا المركز</p>
                <p className="text-[11px] text-slate-400 mt-1">تتولد القيود تلقائياً عند إجراء المبيعات، المشتريات، والسندات</p>
              </div>
            ) : (
              filteredJournalEntries.map((entry) => {
                const entryTotal = entry.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
                return (
                  <div
                    key={entry.id}
                    className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm hover:border-slate-300 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 mb-3 border-b border-slate-100 gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono font-extrabold text-xs text-slate-900 bg-slate-100 px-2.5 py-1 rounded">
                          {entry.entryNumber}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          entry.status === 'REVERSED'
                            ? 'bg-rose-100 text-rose-800 border border-rose-200'
                            : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                        }`}>
                          {entry.status === 'REVERSED' ? 'معكوس / ملغى' : 'مرحّل قطعي'}
                        </span>
                        <span className="text-xs font-bold text-slate-800">{entry.description}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-slate-500">{entry.date}</span>
                        <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 font-semibold text-slate-700">
                          {entry.costCenterId === 'pharmacy'
                            ? 'الصيدلية (CC-101)'
                            : entry.costCenterId === 'grocery'
                            ? 'البقالة (CC-102)'
                            : entry.costCenterId === 'bike_parts'
                            ? 'قطع الدراجات (CC-103)'
                            : entry.costCenterId === 'equipment_parts'
                            ? 'قطع المعدات (CC-104)'
                            : 'الإدارة العامة (CC-100)'}
                        </span>
                        <span className="font-mono tabular-nums font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded">
                          {entryTotal.toFixed(2)} {currencySymbol}
                        </span>
                        {entry.status !== 'REVERSED' && (
                          <button
                            onClick={() => {
                              setReversalError(null);
                              setReversalModalEntry(entry);
                              setReversalReason('');
                            }}
                            className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 transition-colors"
                            title="إنشاء قيد عكسي لتصحيح هذا القيد المرحل"
                          >
                            عكس القيد
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Entry Lines Table */}
                    <table className="w-full text-right text-xs">
                      <thead>
                        <tr className="text-slate-500 text-[11px]">
                          <th className="py-1 px-2">الحساب</th>
                          <th className="py-1 px-2 text-center w-28">مدين (Debit)</th>
                          <th className="py-1 px-2 text-center w-28">دائن (Credit)</th>
                          <th className="py-1 px-2">ملاحظات</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {entry.lines.map((line) => (
                          <tr key={line.id}>
                            <td className="py-1.5 px-2">
                              <span className="font-mono text-slate-500 ml-1.5">{line.accountCode}</span>
                              <span className="font-semibold text-slate-900">{line.accountName}</span>
                            </td>
                            <td className="py-1.5 px-2 text-center font-mono tabular-nums text-slate-900">
                              {line.debit > 0 ? (
                                <span className="font-bold">{line.debit.toFixed(2)}</span>
                              ) : (
                                <span className="text-slate-300">-</span>
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-center font-mono tabular-nums text-slate-900">
                              {line.credit > 0 ? (
                                <span className="font-bold">{line.credit.toFixed(2)}</span>
                              ) : (
                                <span className="text-slate-300">-</span>
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-slate-500 text-[11px]">{line.memo || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: قيد يومية يدوي جديد (New Manual Journal Entry) */}
      {activeTab === 'new_entry' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm max-w-4xl mx-auto">
          <div className="border-b border-slate-200 pb-4 mb-6 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">إنشاء قيد يومية مركب يدوي (Manual Journal Entry)</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                تطبيق صارم للقيد المزدوج: لن يقبل النظام ترحيل القيد إلا بتطابق تام بين طرفي المدين والدائن
              </p>
            </div>
            <div
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 ${
                isBalanced
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : 'bg-rose-100 text-rose-900 border border-rose-300'
              }`}
            >
              {isBalanced ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              <span>{isBalanced ? 'القيد متوازن وجاهز' : `فارق عدم توازن: ${balanceDifference.toFixed(2)} ${currencySymbol}`}</span>
            </div>
          </div>

          <form onSubmit={handleSubmitJournalEntry} className="space-y-5 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">تاريخ القيد *</label>
                <input
                  type="date"
                  required
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">مركز التكلفة *</label>
                <select
                  value={entryCostCenter}
                  onChange={(e) => setEntryCostCenter(e.target.value as ActivityId | 'general')}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                >
                  <option value="general">الإدارة العامة والمشتركة (CC-100)</option>
                  <option value="pharmacy">نشاط الصيدلية (CC-101)</option>
                  <option value="grocery">نشاط المواد الغذائية والبقالة (CC-102)</option>
                  <option value="bike_parts">نشاط قطع غيار الدراجات (CC-103)</option>
                  <option value="equipment_parts">نشاط قطع غيار المعدات (CC-104)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان والشرح العام للقيد *</label>
                <input
                  type="text"
                  required
                  value={entryDescription}
                  onChange={(e) => setEntryDescription(e.target.value)}
                  placeholder="مثال: تسوية نقدية، إثبات أصل، استهلاك..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                />
              </div>
            </div>

            {/* Entry Lines */}
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="py-2.5 px-3">الحساب الدفتري *</th>
                    <th className="py-2.5 px-3 text-center w-32">مدين (Debit)</th>
                    <th className="py-2.5 px-3 text-center w-32">دائن (Credit)</th>
                    <th className="py-2.5 px-3">ملاحظات السطر</th>
                    <th className="py-2.5 px-3 text-center w-12">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entryLines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="py-2 px-3">
                        <select
                          value={line.accountCode}
                          onChange={(e) => handleLineChange(idx, 'accountCode', e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-900"
                        >
                          <option value="">-- اختر الحساب من الدليل --</option>
                          {accounts
                            .filter((a) => a.isLeaf)
                            .map((a) => (
                              <option key={a.code} value={a.code}>
                                {a.code} - {a.nameAr}
                              </option>
                            ))}
                        </select>
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={line.debit}
                          onChange={(e) => handleLineChange(idx, 'debit', e.target.value)}
                          placeholder="0.00"
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-center font-mono font-bold text-slate-900"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={line.credit}
                          onChange={(e) => handleLineChange(idx, 'credit', e.target.value)}
                          placeholder="0.00"
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-center font-mono font-bold text-slate-900"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={line.memo}
                          onChange={(e) => handleLineChange(idx, 'memo', e.target.value)}
                          placeholder="شرح فرعي..."
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-slate-700"
                        />
                      </td>
                      <td className="py-2 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => handleRemoveLine(idx)}
                          className="text-slate-400 hover:text-rose-600"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 border-t border-slate-200 font-bold font-mono">
                  <tr>
                    <td className="py-3 px-3 text-slate-800">إجمالي طرفي القيد:</td>
                    <td className="py-3 px-3 text-center text-slate-950 tabular-nums">{totalDebit.toFixed(2)}</td>
                    <td className="py-3 px-3 text-center text-slate-950 tabular-nums">{totalCredit.toFixed(2)}</td>
                    <td colSpan={2} className="py-3 px-3 text-center">
                      <span className={isBalanced ? 'text-emerald-700' : 'text-rose-700'}>
                        {isBalanced ? 'متوازن' : `فارق: ${balanceDifference.toFixed(2)} ${currencySymbol}`}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleAddLine}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold rounded-lg flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>إضافة سطر طرف جديد للقيد</span>
              </button>

              <button
                type="submit"
                disabled={!isBalanced || isSubmitting}
                className={`px-6 py-2.5 rounded-lg font-extrabold flex items-center gap-2 shadow-sm transition-all ${
                  isBalanced && !isSubmitting
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                }`}
              >
                <Check className="w-4 h-4" />
                <span>{isSubmitting ? 'جارٍ الترحيل...' : 'ترحيل القيد رسمياً لدفتر الأستاذ'}</span>
              </button>
            </div>

            {entryError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{entryError}</span>
              </div>
            )}

            {entrySuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
                <span>{entrySuccess}</span>
              </div>
            )}
          </form>
        </div>
      )}

      {/* VIEW 4: ميزان المراجعة (Trial Balance) */}
      {activeTab === 'trial_balance' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-slate-900">ميزان المراجعة بالمجاميع والأرصدة</h3>
              <p className="text-[11px] text-slate-500">التحقق الشامل من توازن كافة الحسابات المدينة والدائنة في المنشأة</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-100/70">
                  <th rowSpan={2} className="py-2.5 px-4 border-l border-slate-200">كود الحساب</th>
                  <th rowSpan={2} className="py-2.5 px-4 border-l border-slate-200">اسم الحساب</th>
                  <th colSpan={2} className="py-1 px-4 text-center border-l border-b border-slate-200 bg-slate-200/50">
                    المجاميع (Totals)
                  </th>
                  <th colSpan={2} className="py-1 px-4 text-center border-b border-slate-200 bg-slate-200/50">
                    الأرصدة النهائية (Balances)
                  </th>
                </tr>
                <tr className="border-b border-slate-200 text-slate-600 bg-slate-50">
                  <th className="py-1.5 px-3 text-center border-l border-slate-200">مدين</th>
                  <th className="py-1.5 px-3 text-center border-l border-slate-200">دائن</th>
                  <th className="py-1.5 px-3 text-center border-l border-slate-200">رصيد مدين</th>
                  <th className="py-1.5 px-3 text-center">رصيد دائن</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {trialBalanceData.map((row) => (
                  <tr key={row.code} className="hover:bg-slate-50 font-mono text-[11px]">
                    <td className="py-2 px-4 font-bold text-slate-900 border-l border-slate-100">{row.code}</td>
                    <td className="py-2 px-4 font-sans font-semibold text-slate-800 border-l border-slate-100">
                      {row.nameAr}
                    </td>
                    <td className="py-2 px-3 text-center tabular-nums border-l border-slate-100">{row.debitTotal.toFixed(2)}</td>
                    <td className="py-2 px-3 text-center tabular-nums border-l border-slate-100">{row.creditTotal.toFixed(2)}</td>
                    <td className="py-2 px-3 text-center tabular-nums font-bold text-slate-900 border-l border-slate-100">
                      {row.debitBalance.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-center tabular-nums font-bold text-slate-900">
                      {row.creditBalance.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-900 text-white font-mono font-bold text-xs">
                <tr>
                  <td colSpan={2} className="py-3 px-4 font-sans">
                    إجمالي ميزان المراجعة:
                  </td>
                  <td className="py-3 px-3 text-center tabular-nums">
                    {trialBalanceData.reduce((s, r) => s + r.debitTotal, 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-3 text-center tabular-nums">
                    {trialBalanceData.reduce((s, r) => s + r.creditTotal, 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-3 text-center tabular-nums text-emerald-400">
                    {trialBalanceData.reduce((s, r) => s + r.debitBalance, 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-3 text-center tabular-nums text-emerald-400">
                    {trialBalanceData.reduce((s, r) => s + r.creditBalance, 0).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 5: قائمة الدخل والأرباح (Income Statement) */}
      {activeTab === 'income_statement' && canViewProfits && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm max-w-3xl mx-auto space-y-6">
          <div className="border-b border-slate-200 pb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">قائمة الدخل والأرباح والخسائر</h3>
              <p className="text-xs text-slate-500 mt-0.5">احتساب صافي الربح بدقة بطرح كافة المصروفات وتكلفة البضاعة المباعة</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">حسب النشاط:</span>
              <select
                value={selectedCostCenter}
                onChange={(e) => setSelectedCostCenter(e.target.value as ActivityId | 'general' | 'all')}
                className="px-3 py-1 bg-slate-50 border border-slate-200 rounded text-xs font-semibold"
              >
                <option value="all">كافة الأنشطة (شامل)</option>
                <option value="pharmacy">الصيدلية</option>
                <option value="grocery">البقالة</option>
                <option value="bike_parts">قطع الدراجات</option>
                <option value="equipment_parts">قطع المعدات</option>
                <option value="general">الإدارة العامة</option>
              </select>
            </div>
          </div>

          {/* الإيرادات */}
          <div>
            <h4 className="text-xs font-bold text-emerald-800 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span>الإيرادات والمبيعات:</span>
            </h4>
            <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100 text-xs">
              {incomeStatementData.revenues.length === 0 ? (
                <div className="p-3 text-slate-400 text-center">لا توجد إيرادات مسجلة بعد في هذا المركز</div>
              ) : (
                incomeStatementData.revenues.map((rev) => (
                  <div key={rev.code} className="flex justify-between p-2.5 hover:bg-slate-50">
                    <span className="text-slate-800 font-semibold">{rev.nameAr}</span>
                    <span className="font-mono tabular-nums font-bold text-slate-900">{rev.amount.toFixed(2)} {currencySymbol}</span>
                  </div>
                ))
              )}
              <div className="flex justify-between p-3 bg-emerald-50/50 font-bold text-emerald-950">
                <span>إجمالي الإيرادات:</span>
                <span className="font-mono tabular-nums text-sm">{incomeStatementData.totalRevenue.toFixed(2)} {currencySymbol}</span>
              </div>
            </div>
          </div>

          {/* المصروفات */}
          <div>
            <h4 className="text-xs font-bold text-rose-800 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span>المصروفات وتكلفة البضاعة المباعة:</span>
            </h4>
            <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100 text-xs">
              {incomeStatementData.expenses.length === 0 ? (
                <div className="p-3 text-slate-400 text-center">لا توجد مصروفات مسجلة بعد في هذا المركز</div>
              ) : (
                incomeStatementData.expenses.map((exp) => (
                  <div key={exp.code} className="flex justify-between p-2.5 hover:bg-slate-50">
                    <span className="text-slate-800 font-semibold">{exp.nameAr}</span>
                    <span className="font-mono tabular-nums font-bold text-slate-900">{exp.amount.toFixed(2)} {currencySymbol}</span>
                  </div>
                ))
              )}
              <div className="flex justify-between p-3 bg-rose-50/50 font-bold text-rose-950">
                <span>إجمالي المصروفات:</span>
                <span className="font-mono tabular-nums text-sm">{incomeStatementData.totalExpenses.toFixed(2)} {currencySymbol}</span>
              </div>
            </div>
          </div>

          {/* صافي الربح / الخسارة النهائي */}
          <div
            className={`p-4 rounded-xl border flex items-center justify-between font-bold ${
              incomeStatementData.netProfit >= 0
                ? 'bg-emerald-600 text-white border-emerald-700 shadow-md'
                : 'bg-rose-600 text-white border-rose-700 shadow-md'
            }`}
          >
            <div>
              <div className="text-sm">صافي الأرباح (Net Profit / Loss):</div>
              <div className="text-[11px] font-normal opacity-90">
                {incomeStatementData.netProfit >= 0 ? 'ربح صافي محقق' : 'عجز / خسارة مؤقتة'}
              </div>
            </div>
            <div className="text-2xl font-mono tabular-nums font-extrabold">
              {incomeStatementData.netProfit.toFixed(2)} {currencySymbol}
            </div>
          </div>
        </div>
      )}

      {/* Modal: إضافة حساب فرعي للدليل */}
      {isAddAccountModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">إضافة حساب فرعي جديد للدليل المحاسبي</h3>
              <button onClick={() => setIsAddAccountModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveNewAccount} className="p-5 space-y-3 text-xs">
              {accountError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{accountError}</span>
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">كود الحساب (فريد) *</label>
                <input
                  type="text"
                  required
                  value={newAccCode}
                  onChange={(e) => setNewAccCode(e.target.value)}
                  placeholder="مثال: 1105 / 5205..."
                  className="w-full px-3 py-1.5 border border-slate-200 rounded font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">اسم الحساب العربي *</label>
                <input
                  type="text"
                  required
                  value={newAccName}
                  onChange={(e) => setNewAccName(e.target.value)}
                  placeholder="مثال: مصرف الراجحي، مصاريف تسويق..."
                  className="w-full px-3 py-1.5 border border-slate-200 rounded"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">النوع الرئيسي *</label>
                <select
                  value={newAccType}
                  onChange={(e) => setNewAccType(e.target.value as AccountType)}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded"
                >
                  <option value="ASSET">الأصول (Assets)</option>
                  <option value="LIABILITY">الخصوم (Liabilities)</option>
                  <option value="EQUITY">حقوق الملكية (Equity)</option>
                  <option value="REVENUE">الإيرادات (Revenue)</option>
                  <option value="EXPENSE">المصروفات (Expense)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الحساب الأب (إن وجد)</label>
                <select
                  value={newAccParent}
                  onChange={(e) => setNewAccParent(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded"
                >
                  <option value="">-- حساب رئيسي مستقل --</option>
                  {accounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} - {a.nameAr}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddAccountModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded"
                >
                  إضافة الحساب
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal عكس القيد المحاسبي المرحل (Journal Entry Reversal) */}
      {reversalModalEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <h4 className="text-xs font-bold">عكس القيد المحاسبي ({reversalModalEntry.entryNumber})</h4>
                <p className="text-[10px] text-slate-400">التصحيح المالي عبر القيد العكسي دون حذف السجل الأصلي</p>
              </div>
              <button
                onClick={() => setReversalModalEntry(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!reversalReason.trim() || isSubmitting) return;
                setReversalError(null);
                setIsSubmitting(true);
                try {
                  await dataService.reverseJournalEntryAtomic(
                    reversalModalEntry.id,
                    reversalReason.trim()
                  );
                  setReversalModalEntry(null);
                  setReversalReason('');
                  onRefresh();
                } catch (err: unknown) {
                  setReversalError(
                    err instanceof Error ? err.message : 'فشل تنفيذ القيد العكسي.'
                  );
                } finally {
                  setIsSubmitting(false);
                }
              }}
              className="p-5 space-y-4 text-xs"
            >
              {reversalError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{reversalError}</span>
                </div>
              )}
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-[11px] leading-relaxed">
                <span className="font-bold block mb-1">تنبيه الحوكمة المالية:</span>
                وفق معايير التدقيق المالي، لا يُسمح بتعديل أو حذف القيد المرحل مباشرة. سيقوم النظام بإنشاء قيد عكسي مطابق وموازٍ لتعطيل أثر القيد الأصلي تماماً، وتوثيق سبب التصحيح.
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">سبب التصحيح والعكس *</label>
                <textarea
                  required
                  rows={3}
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  placeholder="اكتب سبب عكس القيد بالتفصيل (مثال: خطأ في توجيه الحساب أو قيمة الفاتورة...)"
                  className="w-full p-2.5 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setReversalError(null);
                    setReversalModalEntry(null);
                  }}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={!reversalReason.trim() || isSubmitting}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors"
                >
                  {isSubmitting ? 'جارٍ التنفيذ...' : 'تأكيد وترحيل القيد العكسي'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
