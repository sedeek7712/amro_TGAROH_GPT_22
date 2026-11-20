/**
 * وحدة إدارة الأمانات وحفظ ممتلكات الغير (Amanat Management)
 * إدارة معزولة للمبالغ والأصناف المحفوظة وسندات الاستلام والإبراء
 */

import React, { useState } from 'react';
import {
  ShieldCheck,
  Plus,
  Search,
  CheckCircle,
  Clock,
  Printer,
  DollarSign,
  Package,
  User,
  Phone,
  FileText,
  AlertCircle,
  X,
  Check,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { dataService } from '../../services/dataService';
import { authService } from '../../services/authService';
import { getActiveCurrencyConfig } from '../../config/currency';
import { useLiveAmanatRecords, useLiveCashBoxes } from '../../hooks/useLiveDexie';
import { AmanatRecord, AmanatType, AmanatStatus } from '../../types/erp';
import { AmanatReceiptModal } from '../common/AmanatReceiptModal';

interface AmanatManagerProps {
  onRefresh: () => void;
}

export const AmanatManager: React.FC<AmanatManagerProps> = ({ onRefresh }) => {
  const [filterStatus, setFilterStatus] = useState<AmanatStatus | 'ALL'>('HELD');
  const [searchQuery, setSearchQuery] = useState('');
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [selectedRecordToPrint, setSelectedRecordToPrint] = useState<AmanatRecord | null>(null);
  const [returnConfirmRecord, setReturnConfirmRecord] = useState<AmanatRecord | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // حقول نموذج إيداع الأمانة
  const [depositorName, setDepositorName] = useState('');
  const [depositorPhone, setDepositorPhone] = useState('');
  const [depositorNationalId, setDepositorNationalId] = useState('');
  const [depositType, setDepositType] = useState<AmanatType>('CASH');
  const [amount, setAmount] = useState<string>('');
  const [itemDescription, setItemDescription] = useState('');
  const [itemSerial, setItemSerial] = useState('');
  const [notes, setNotes] = useState('');
  const [cashBoxId, setCashBoxId] = useState('');

  const records = useLiveAmanatRecords();
  const cashBoxes = useLiveCashBoxes();
  const currentUser = authService.getCurrentActorSync() || storage.getCurrentUser();
  const currencySymbol = getActiveCurrencyConfig().symbol;

  // تصفية السجلات
  const filteredRecords = records.filter((r) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !searchQuery.trim() ||
      r.depositorName.toLowerCase().includes(q) ||
      r.depositorPhone.includes(q) ||
      r.recordNumber.toLowerCase().includes(q) ||
      (r.itemDescription && r.itemDescription.toLowerCase().includes(q));

    if (!matchesSearch) return false;

    if (filterStatus !== 'ALL') {
      return r.status === filterStatus;
    }

    return true;
  });

  // إحصائيات الأمانات
  const heldCashTotal = records
    .filter((r) => r.status === 'HELD' && r.type === 'CASH')
    .reduce((sum, r) => sum + r.amount, 0);

  const heldItemsCount = records.filter((r) => r.status === 'HELD' && r.type === 'ITEM').length;
  const returnedCount = records.filter((r) => r.status === 'RETURNED').length;

  const handleCreateDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setFormError(null);
    if (!depositorName.trim() || !depositorPhone.trim()) {
      setFormError('يرجى إدخال اسم المودع ورقم الهاتف.');
      return;
    }

    const parsedAmount = depositType === 'CASH' ? Number(amount) || 0 : 0;
    if (depositType === 'CASH' && parsedAmount <= 0) {
      setFormError('يرجى إدخال مبلغ صحيح للأمانة النقدية أكبر من الصفر.');
      return;
    }

    const targetBox = depositType === 'CASH' ? cashBoxId || cashBoxes[0]?.id || 'cb-1' : undefined;
    const newRecord: AmanatRecord = {
      id: storage.generateUUID(),
      recordNumber: '',
      depositorName: depositorName.trim(),
      depositorPhone: depositorPhone.trim(),
      depositorNationalId: depositorNationalId.trim() || undefined,
      type: depositType,
      amount: parsedAmount,
      itemDescription: depositType === 'ITEM' ? itemDescription.trim() : undefined,
      itemSerial: depositType === 'ITEM' ? itemSerial.trim() || undefined : undefined,
      status: 'HELD',
      receivedDate: new Date().toISOString().split('T')[0],
      receivedBy: currentUser?.fullName || 'الموظف المختص',
      cashBoxId: targetBox,
      notes: notes.trim() || undefined,
    };

    setIsSubmitting(true);
    try {
      const res = await dataService.createAmanatDepositAtomic({
        record: newRecord,
        cashBoxId: targetBox,
      });
      setIsDepositModalOpen(false);
      setSelectedRecordToPrint(res.record);

      // تصفير النموذج
      setDepositorName('');
      setDepositorPhone('');
      setDepositorNationalId('');
      setAmount('');
      setItemDescription('');
      setItemSerial('');
      setNotes('');
      setFormError(null);
      onRefresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر تسجيل إيداع الأمانة.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // فتح نافذة تأكيد تسليم الأمانة وإبراء الذمة
  const handleReturnAmanat = (record: AmanatRecord) => {
    setReturnError(null);
    setReturnConfirmRecord(record);
  };

  // تنفيذ تسليم الأمانة بعد التأكيد في الواجهة
  const confirmReturnAmanat = async () => {
    if (!returnConfirmRecord || isSubmitting) return;
    const record = returnConfirmRecord;
    setReturnError(null);
    setIsSubmitting(true);

    try {
      const targetBox =
        record.type === 'CASH' ? record.cashBoxId || cashBoxes[0]?.id || 'cb-1' : undefined;
      const res = await dataService.returnAmanatAtomic({
        recordId: record.id,
        cashBoxId: targetBox,
        recipientSignatureName: record.depositorName,
      });
      setSelectedRecordToPrint(res.record);
      setReturnConfirmRecord(null);
      onRefresh();
    } catch (err: unknown) {
      setReturnError(err instanceof Error ? err.message : 'تعذر تنفيذ عملية تسليم الأمانة.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Top Amanat Metrics Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-xl border border-purple-200 shadow-sm bg-purple-50/20">
          <div className="flex items-center justify-between text-purple-900 mb-2">
            <span className="text-xs font-semibold">إجمالي الأمانات النقدية المحفوظة</span>
            <DollarSign className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-purple-950">
            {heldCashTotal.toFixed(2)} <span className="text-xs font-normal text-slate-500">{currencySymbol}</span>
          </div>
          <div className="text-[11px] text-purple-700 mt-2">
            معزولة كخصوم في الحساب المحاسبي (2102)
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold">الأمانات العينية المحفوظة</span>
            <Package className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900">
            {heldItemsCount} <span className="text-xs font-normal text-slate-500">أمانة عينية</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            مقتنيات وأصناف محفوظة في الخزائن والمستودع
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold">الأمانات المسلمة (تمت تصفيتها)</span>
            <CheckCircle className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-700">
            {returnedCount} <span className="text-xs font-normal text-slate-500">سند مبرأ</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            تم تسليمها لأصحابها وإبراء الذمة
          </div>
        </div>
      </div>

      {/* Toolbar & Action */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث باسم المودع، الهاتف، أو رقم السند..."
            className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="flex items-center bg-slate-100 p-1 rounded-lg text-xs">
            <button
              onClick={() => setFilterStatus('HELD')}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                filterStatus === 'HELD' ? 'bg-white text-purple-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              المحفوظة حالياً
            </button>
            <button
              onClick={() => setFilterStatus('RETURNED')}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                filterStatus === 'RETURNED'
                  ? 'bg-white text-purple-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              المستردة والمسلمة
            </button>
            <button
              onClick={() => setFilterStatus('ALL')}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                filterStatus === 'ALL' ? 'bg-white text-purple-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              الكل
            </button>
          </div>

          <button
            onClick={() => setIsDepositModalOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-800 text-white rounded-lg text-xs font-bold shadow-sm transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>تسجيل إيداع أمانة جديدة</span>
          </button>
        </div>
      </div>

      {/* Amanat Records Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                <th className="py-3 px-4">رقم السند</th>
                <th className="py-3 px-4">المودع ورقم الهاتف</th>
                <th className="py-3 px-4">نوع الأمانة</th>
                <th className="py-3 px-4">تفاصيل وقيمة الأمانة</th>
                <th className="py-3 px-4 text-center">تاريخ الاستلام</th>
                <th className="py-3 px-4 text-center">الحالة</th>
                <th className="py-3 px-4 text-center">المستلم</th>
                <th className="py-3 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-medium">لا توجد سجلات أمانات مسجلة</p>
                    <p className="text-[11px] text-slate-400 mt-1">اضغط على زر «تسجيل إيداع أمانة جديدة» للبدء</p>
                  </td>
                </tr>
              ) : (
                filteredRecords.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">{r.recordNumber}</td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{r.depositorName}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{r.depositorPhone}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                          r.type === 'CASH'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {r.type === 'CASH' ? 'أمانة نقدية' : 'أمانة عينية'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {r.type === 'CASH' ? (
                        <div className="font-mono tabular-nums font-bold text-slate-900 text-sm">
                          {r.amount.toFixed(2)} {currencySymbol}
                        </div>
                      ) : (
                        <div>
                          <div className="font-medium text-slate-900 line-clamp-1">{r.itemDescription}</div>
                          {r.itemSerial && (
                            <div className="text-[10px] text-slate-400 font-mono">سيريال: {r.itemSerial}</div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center font-mono text-slate-600">{r.receivedDate}</td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full font-bold text-[10px] ${
                          r.status === 'HELD'
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-emerald-100 text-emerald-900'
                        }`}
                      >
                        {r.status === 'HELD' ? 'محفوظة في الأمانات' : 'تم تسليمها وإبراء الذمة'}
                      </span>
                      {r.returnedDate && (
                        <div className="text-[10px] text-slate-400 mt-0.5 font-mono">بتاريخ: {r.returnedDate}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center text-slate-600">{r.receivedBy}</td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setSelectedRecordToPrint(r)}
                          className="p-1.5 text-slate-600 hover:text-purple-700 hover:bg-slate-100 rounded-md transition-colors"
                          title="طباعة السند الرسمي"
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                        {r.status === 'HELD' && (
                          <button
                            onClick={() => handleReturnAmanat(r)}
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-bold transition-colors"
                            title="تسليم الأمانة وإبراء الذمة"
                          >
                            تسليم
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal: New Amanat Deposit */}
      {isDepositModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto">
          <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 bg-purple-950 text-white">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-purple-300" />
                <span>تسجيل إيداع أمانة جديدة</span>
              </h3>
              <button
                onClick={() => setIsDepositModalOpen(false)}
                className="text-purple-300 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateDeposit} className="p-6 space-y-4 text-xs">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setDepositType('CASH')}
                  className={`py-2 text-center rounded-lg font-bold transition-all ${
                    depositType === 'CASH'
                      ? 'bg-purple-700 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  أمانة نقدية (مبلغ مالي)
                </button>
                <button
                  type="button"
                  onClick={() => setDepositType('ITEM')}
                  className={`py-2 text-center rounded-lg font-bold transition-all ${
                    depositType === 'ITEM'
                      ? 'bg-purple-700 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  أمانة عينية (أصناف ومقتنيات)
                </button>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">اسم المودع (صاحب الأمانة) *</label>
                <input
                  type="text"
                  required
                  value={depositorName}
                  onChange={(e) => setDepositorName(e.target.value)}
                  placeholder="الاسم الثلاثي أو الرباعي..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف للتواصل *</label>
                  <input
                    type="tel"
                    required
                    value={depositorPhone}
                    onChange={(e) => setDepositorPhone(e.target.value)}
                    placeholder="05XXXXXXXX"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهوية الوطنية / الإقامة</label>
                  <input
                    type="text"
                    value={depositorNationalId}
                    onChange={(e) => setDepositorNationalId(e.target.value)}
                    placeholder="اختياري للتوثيق..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
              </div>

              {depositType === 'CASH' ? (
                <div className="p-3 bg-purple-50 rounded-lg border border-purple-200 space-y-3">
                  <div>
                    <label className="block font-semibold text-purple-900 mb-1">المبلغ المودع نقداً ({currencySymbol}) *</label>
                    <input
                      type="number"
                      step="any"
                      min="1"
                      required
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 bg-white border border-purple-300 rounded-lg text-slate-900 font-mono text-sm font-bold focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-purple-900 mb-1 font-semibold">إيداع في الخزينة / الصندوق:</label>
                    <select
                      value={cashBoxId}
                      onChange={(e) => setCashBoxId(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-purple-300 rounded-lg text-slate-900 focus:outline-none"
                    >
                      {cashBoxes.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.nameAr}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
                  <div>
                    <label className="block font-semibold text-blue-900 mb-1">وصف الصنف العيني والمواصفات *</label>
                    <textarea
                      rows={2}
                      required
                      value={itemDescription}
                      onChange={(e) => setItemDescription(e.target.value)}
                      placeholder="مثال: حقيبة مغلقة / قطع غيار معدات خاصة / أجهزة إلكترونية..."
                      className="w-full px-3 py-2 bg-white border border-blue-300 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-blue-900 mb-1">الرقم التسلسلي أو علامات مميزة</label>
                    <input
                      type="text"
                      value={itemSerial}
                      onChange={(e) => setItemSerial(e.target.value)}
                      placeholder="إن وجد..."
                      className="w-full px-3 py-1.5 bg-white border border-blue-300 rounded-lg text-slate-900 font-mono focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">شروط وملاحظات الحفظ</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="ملاحظات خاصة بموعد الاسترداد أو المفوض بالاستلام..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsDepositModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-purple-700 hover:bg-purple-800 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isSubmitting ? 'جارٍ الحفظ...' : 'حفظ وإصدار سند الأمانة'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Return Confirmation Modal */}
      {returnConfirmRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3 text-amber-600">
              <ShieldCheck className="w-6 h-6 shrink-0" />
              <h3 className="text-base font-bold text-slate-900">تأكيد تسليم الأمانة وإبراء الذمة</h3>
            </div>
            {returnError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{returnError}</span>
              </div>
            )}
            <p className="text-sm text-slate-600 leading-relaxed">
              هل تؤكد تسليم وإبراء ذمة الأمانة رقم{' '}
              <span className="font-mono font-bold text-slate-900">({returnConfirmRecord.recordNumber})</span>{' '}
              لصالح المودع{' '}
              <span className="font-bold text-slate-900">({returnConfirmRecord.depositorName})</span>؟
              {returnConfirmRecord.type === 'CASH' && (
                <span className="block mt-2 text-xs font-semibold text-purple-700 bg-purple-50 p-2 rounded">
                  سيتم توليد قيد صرف محاسبي لتسوية التزام الأمانة وخفض الصندوق بمبلغ ({returnConfirmRecord.amount.toFixed(2)} {currencySymbol}).
                </span>
              )}
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setReturnError(null);
                  setReturnConfirmRecord(null);
                }}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-xs font-semibold"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={confirmReturnAmanat}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-lg transition-colors text-xs font-bold flex items-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>{isSubmitting ? 'جارٍ التسليم...' : 'تأكيد التسليم والإبراء'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Voucher Modal */}
      <AmanatReceiptModal
        record={selectedRecordToPrint}
        onClose={() => setSelectedRecordToPrint(null)}
      />
    </div>
  );
};
