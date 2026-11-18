/**
 * إدارة الصناديق النقدية، البنوك، وسندات القبض والصرف (Cash & Vouchers Management)
 * ترحيل لحظي لقيود اليومية وتحديث الأرصدة النقدية
 */

import React, { useState } from 'react';
import {
  Wallet,
  Plus,
  ArrowDownLeft,
  ArrowUpRight,
  Search,
  Building,
  CheckCircle,
  FileText,
  Printer,
  X,
  Check,
  DollarSign,
  Share2,
  AlertCircle,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { accounting } from '../../services/accountingEngine';
import {
  useLiveCashBoxes,
  useLiveVouchers,
  useLiveAccounts,
  useLiveParties,
} from '../../hooks/useLiveDexie';
import { CashBox, PaymentVoucher, VoucherType, CostCenterId } from '../../types/erp';
import { CustomerNotificationModal } from '../common/CustomerNotificationModal';

interface CashManagerProps {
  onRefresh: () => void;
}

export const CashManager: React.FC<CashManagerProps> = ({ onRefresh }) => {
  const [activeTab, setActiveTab] = useState<'boxes' | 'receipts' | 'payments'>('boxes');
  const [isVoucherModalOpen, setIsVoucherModalOpen] = useState(false);
  const [voucherType, setVoucherType] = useState<VoucherType>('RECEIPT');
  const [voucherError, setVoucherError] = useState<string | null>(null);

  // حقول نموذج السند
  const [voucherAmount, setVoucherAmount] = useState('');
  const [voucherDate, setVoucherDate] = useState(new Date().toISOString().split('T')[0]);
  const [voucherCashBoxId, setVoucherCashBoxId] = useState('');
  const [voucherAccountCode, setVoucherAccountCode] = useState('');
  const [voucherPartyId, setVoucherPartyId] = useState('');
  const [voucherPartyName, setVoucherPartyName] = useState('');
  const [voucherDescription, setVoucherDescription] = useState('');
  const [voucherCostCenter, setVoucherCostCenter] = useState<CostCenterId>('general');

  // نافذة إشعار العميل / المستفيد
  const [notificationData, setNotificationData] = useState<{
    isOpen: boolean;
    recipientName: string;
    recipientPhone?: string;
    documentType: 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
    documentNumber: string;
    amount?: number;
    notes?: string;
  }>({
    isOpen: false,
    recipientName: '',
    documentType: 'RECEIPT_VOUCHER',
    documentNumber: '',
  });

  // نموذج إضافة صندوق / بنك
  const [isAddBoxModalOpen, setIsAddBoxModalOpen] = useState(false);
  const [boxCode, setBoxCode] = useState('');
  const [boxName, setBoxName] = useState('');

  const cashBoxes = useLiveCashBoxes();
  const vouchers = useLiveVouchers();
  const accounts = useLiveAccounts();
  const customers = useLiveParties('CUSTOMER');
  const suppliers = useLiveParties('SUPPLIER');

  const filteredVouchers = vouchers.filter((v) => {
    if (activeTab === 'receipts') return v.type === 'RECEIPT';
    if (activeTab === 'payments') return v.type === 'PAYMENT';
    return true;
  });

  const handleOpenVoucherModal = (type: VoucherType) => {
    setVoucherType(type);
    setVoucherAmount('');
    setVoucherDescription('');
    setVoucherPartyId('');
    setVoucherPartyName('');
    setVoucherCostCenter('general');
    setVoucherError(null);
    // الحساب الافتراضي
    if (type === 'RECEIPT') {
      setVoucherAccountCode('1103'); // حساب العملاء
    } else {
      setVoucherAccountCode('5204'); // مصاريف تشغيلية
    }
    setVoucherCashBoxId(cashBoxes[0]?.id || 'cb-1');
    setIsVoucherModalOpen(true);
  };

  const handleNotifyVoucher = (v: PaymentVoucher) => {
    const isReceipt = v.type === 'RECEIPT';
    const foundParty = [...customers, ...suppliers].find((p) => p.id === v.partyId || p.nameAr === v.partyName);
    const box = cashBoxes.find((b) => b.id === v.cashBoxId);

    setNotificationData({
      isOpen: true,
      recipientName: v.partyName,
      recipientPhone: foundParty?.phone || '',
      documentType: isReceipt ? 'RECEIPT_VOUCHER' : 'PAYMENT_VOUCHER',
      documentNumber: v.voucherNumber,
      amount: v.amount,
      notes: `${v.description} - حساب: ${box?.nameAr || 'الخزينة'}`,
    });
  };

  const handlePrintVoucher = (v: PaymentVoucher) => {
    const isReceipt = v.type === 'RECEIPT';
    const box = cashBoxes.find((b) => b.id === v.cashBoxId);
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      window.print();
      return;
    }
    printWindow.document.write(`
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
        <head>
          <title>${isReceipt ? 'سند قبض' : 'سند صرف'} - ${v.voucherNumber}</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; direction: rtl; padding: 24px; color: #1e293b; }
            .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
            .header h1 { margin: 0; font-size: 20px; color: #0f172a; }
            .header p { margin: 4px 0 0; color: #64748b; font-size: 13px; }
            .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: bold; font-size: 14px; margin-top: 8px; }
            .badge-rcv { background: #dcfce7; color: #166534; }
            .badge-pay { background: #fee2e2; color: #991b1b; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px; margin-bottom: 20px; }
            .info-item { padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
            .amount-box { text-align: center; background: #0f172a; color: #fff; padding: 16px; border-radius: 8px; font-size: 20px; font-weight: bold; margin-bottom: 20px; }
            .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 50px; text-align: center; font-size: 12px; color: #475569; }
            .sig-line { border-top: 1px dashed #94a3b8; margin-top: 40px; padding-top: 6px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>المؤسسة التجارية المتكاملة للأنشطة المتعددة</h1>
            <p>سجل تجاري موحد | نظام محاسبي مزدوج معتمد</p>
            <div class="badge ${isReceipt ? 'badge-rcv' : 'badge-pay'}">
              ${isReceipt ? 'سند قبض مالي رسمي' : 'سند صرف مالي رسمي'}
            </div>
          </div>

          <div class="info-grid">
            <div class="info-item"><strong>رقم السند:</strong> ${v.voucherNumber}</div>
            <div class="info-item"><strong>التاريخ:</strong> ${v.date}</div>
            <div class="info-item"><strong>${isReceipt ? 'المستلم منه:' : 'المصروف له:'}</strong> ${v.partyName}</div>
            <div class="info-item"><strong>الصندوق / الحساب:</strong> ${box?.nameAr || '-'}</div>
            <div class="info-item" style="grid-column: span 2;"><strong>البيان والشرح:</strong> ${v.description}</div>
          </div>

          <div class="amount-box">
            المبلغ: ${v.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} ر.س
          </div>

          <div class="signatures">
            <div>المحاسب المسؤول<div class="sig-line">التوقيع</div></div>
            <div>أمين الصندوق<div class="sig-line">التوقيع</div></div>
            <div>المستلم / الطرف المعني<div class="sig-line">التوقيع والختم</div></div>
          </div>
          <script>
            window.onload = function() { window.print(); }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleSaveVoucher = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(voucherAmount);
    if (!amt || amt <= 0) {
      setVoucherError('يرجى إدخال مبلغ مالي صحيح أكبر من الصفر.');
      return;
    }

    const count = vouchers.length + 1;
    const prefix = voucherType === 'RECEIPT' ? 'RCV' : 'PAY';
    const voucherNumber = `${prefix}-${new Date().getFullYear()}-${String(count).padStart(5, '0')}`;

    const newVoucher: PaymentVoucher = {
      id: storage.generateUUID(),
      voucherNumber,
      type: voucherType,
      date: voucherDate,
      amount: amt,
      cashBoxId: voucherCashBoxId || cashBoxes[0]?.id || 'cb-1',
      partyId: voucherPartyId || undefined,
      partyName: voucherPartyName || (voucherType === 'RECEIPT' ? 'عميل / مودع' : 'مستفيد'),
      accountCode: voucherAccountCode,
      description: voucherDescription || (voucherType === 'RECEIPT' ? 'قبض نقدي' : 'صرف نقدي'),
      costCenterId: voucherCostCenter,
    };

    // ترحيل القيد المحاسبي المزدوج
    if (voucherType === 'RECEIPT') {
      const jvId = accounting.postReceiptVoucher(newVoucher);
      newVoucher.journalEntryId = jvId;
    } else {
      const jvId = accounting.postPaymentVoucher(newVoucher);
      newVoucher.journalEntryId = jvId;
    }

    storage.addVoucher(newVoucher);
    setIsVoucherModalOpen(false);
    onRefresh();

    // فتح نافذة إشعار العميل مباشرة لراحة المستخدم
    handleNotifyVoucher(newVoucher);
  };

  const handleSaveNewCashBox = (e: React.FormEvent) => {
    e.preventDefault();
    if (!boxName.trim() || !boxCode.trim()) return;

    const newBox: CashBox = {
      id: storage.generateUUID(),
      code: boxCode.trim(),
      nameAr: boxName.trim(),
      accountCode: '1101',
      balance: 0,
      isDefault: false,
    };

    storage.saveCashBoxes([...cashBoxes, newBox]);
    setIsAddBoxModalOpen(false);
    setBoxCode('');
    setBoxName('');
    onRefresh();
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Navigation tabs & action buttons */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('boxes')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'boxes'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            الخزائن والحسابات البنكية ({cashBoxes.length})
          </button>
          <button
            onClick={() => setActiveTab('receipts')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'receipts'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            سندات القبض (Receipts)
          </button>
          <button
            onClick={() => setActiveTab('payments')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'payments'
                ? 'bg-rose-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            سندات الصرف (Payments)
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleOpenVoucherModal('RECEIPT')}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <ArrowDownLeft className="w-4 h-4" />
            <span>+ سند قبض جديد</span>
          </button>
          <button
            onClick={() => handleOpenVoucherModal('PAYMENT')}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <ArrowUpRight className="w-4 h-4" />
            <span>- سند صرف جديد</span>
          </button>
          <button
            onClick={() => setIsAddBoxModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة صندوق / بنك</span>
          </button>
        </div>
      </div>

      {/* VIEW 1: الخزائن والصناديق والبنوك */}
      {activeTab === 'boxes' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cashBoxes.map((box) => (
            <div
              key={box.id}
              className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
                      <Wallet className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-xs text-slate-900">{box.nameAr}</h4>
                      <span className="font-mono text-[10px] text-slate-400">{box.code}</span>
                    </div>
                  </div>
                  {box.isDefault && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 font-semibold">
                      الخزينة الافتراضية
                    </span>
                  )}
                </div>

                <div className="mt-4 pt-4 border-t border-slate-100">
                  <div className="text-[11px] text-slate-500 mb-1">الرصيد النقدي الفعلي المتاح:</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {box.balance.toFixed(2)} <span className="text-xs font-normal text-slate-500">ر.س</span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-100 flex gap-2">
                <button
                  onClick={() => {
                    setVoucherCashBoxId(box.id);
                    handleOpenVoucherModal('RECEIPT');
                  }}
                  className="flex-1 py-1.5 px-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded font-semibold text-xs transition-colors"
                >
                  إيداع / قبض
                </button>
                <button
                  onClick={() => {
                    setVoucherCashBoxId(box.id);
                    handleOpenVoucherModal('PAYMENT');
                  }}
                  className="flex-1 py-1.5 px-2 bg-rose-50 hover:bg-rose-100 text-rose-800 rounded font-semibold text-xs transition-colors"
                >
                  صرف نقدية
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* VIEW 2 & 3: جدول السندات (قبض وصرف) */}
      {(activeTab === 'receipts' || activeTab === 'payments') && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                  <th className="py-3 px-4">رقم السند</th>
                  <th className="py-3 px-4">التاريخ</th>
                  <th className="py-3 px-4">النوع</th>
                  <th className="py-3 px-4">الطرف المعني</th>
                  <th className="py-3 px-4">الشرح والبيان</th>
                  <th className="py-3 px-4">الصندوق المستخدم</th>
                  <th className="py-3 px-4 text-center">المبلغ</th>
                  <th className="py-3 px-4 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredVouchers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                      <p className="font-semibold">
                        لا توجد سندات {activeTab === 'receipts' ? 'قبض' : 'صرف'} مسجلة بعد
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredVouchers.map((v) => {
                    const box = cashBoxes.find((b) => b.id === v.cashBoxId);
                    return (
                      <tr key={v.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-4 font-mono font-bold text-slate-900">{v.voucherNumber}</td>
                        <td className="py-3 px-4 font-mono text-slate-600">{v.date}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              v.type === 'RECEIPT'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {v.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-900">{v.partyName}</td>
                        <td className="py-3 px-4 text-slate-700">{v.description}</td>
                        <td className="py-3 px-4 text-slate-600">{box?.nameAr || '-'}</td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-slate-900">
                          {v.amount.toFixed(2)} ر.س
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => handleNotifyVoucher(v)}
                              title="إشعار الطرف بالواتساب والمشاركة"
                              className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors flex items-center gap-1 text-[11px] font-bold"
                            >
                              <Share2 className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">إشعار</span>
                            </button>
                            <button
                              onClick={() => handlePrintVoucher(v)}
                              title="طباعة السند رسمياً"
                              className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: New Voucher */}
      {isVoucherModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div
              className={`flex items-center justify-between px-6 py-4 text-white ${
                voucherType === 'RECEIPT' ? 'bg-emerald-800' : 'bg-rose-800'
              }`}
            >
              <h3 className="text-sm font-bold flex items-center gap-2">
                {voucherType === 'RECEIPT' ? (
                  <ArrowDownLeft className="w-5 h-5" />
                ) : (
                  <ArrowUpRight className="w-5 h-5" />
                )}
                <span>{voucherType === 'RECEIPT' ? 'تحرير سند قبض نقدي' : 'تحرير سند صرف نقدي'}</span>
              </h3>
              <button onClick={() => setIsVoucherModalOpen(false)} className="text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveVoucher} className="p-6 space-y-4 text-xs">
              {voucherError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  <span>{voucherError}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المبلغ المالي (ر.س) *</label>
                  <input
                    type="number"
                    step="any"
                    min="1"
                    required
                    value={voucherAmount}
                    onChange={(e) => setVoucherAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono font-bold text-sm text-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={voucherDate}
                    onChange={(e) => setVoucherDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded font-mono text-slate-900 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    {voucherType === 'RECEIPT' ? 'إيداع في الصندوق:' : 'الصرف من الصندوق:'}
                  </label>
                  <select
                    value={voucherCashBoxId}
                    onChange={(e) => setVoucherCashBoxId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                  >
                    {cashBoxes.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.nameAr} ({b.balance.toFixed(2)} ر.س)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الحساب المقابل في الدليل *</label>
                  <select
                    value={voucherAccountCode}
                    onChange={(e) => setVoucherAccountCode(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                  >
                    {accounts
                      .filter((a) => a.isLeaf)
                      .map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} - {a.nameAr}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    {voucherType === 'RECEIPT' ? 'المستلم منه (العميل أو الطرف):' : 'المصروف له (المورد أو الموظف):'}
                  </label>
                  <input
                    type="text"
                    value={voucherPartyName}
                    onChange={(e) => setVoucherPartyName(e.target.value)}
                    placeholder="الاسم الكامل للطرف المقابل..."
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">مركز التكلفة المحاسبي *</label>
                  <select
                    value={voucherCostCenter}
                    onChange={(e) => setVoucherCostCenter(e.target.value as CostCenterId)}
                    className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none font-medium"
                  >
                    <option value="general">CC-100 - الإدارة العامة</option>
                    <option value="pharmacy">CC-101 - الصيدلية</option>
                    <option value="grocery">CC-102 - المواد الغذائية والبقالة</option>
                    <option value="bike_parts">CC-103 - قطع غيار الدراجات النارية</option>
                    <option value="equipment_parts">CC-104 - قطع غيار المعدات</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان والشرح التفصيلي *</label>
                <textarea
                  rows={2}
                  required
                  value={voucherDescription}
                  onChange={(e) => setVoucherDescription(e.target.value)}
                  placeholder="سبب القبض أو الصرف (مثال: سداد دفعة حساب، سداد فاتورة كهرباء، صيانة...)"
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsVoucherModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className={`px-5 py-2 font-bold text-white rounded-lg transition-colors flex items-center gap-1.5 ${
                    voucherType === 'RECEIPT'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-rose-600 hover:bg-rose-700'
                  }`}
                >
                  <Check className="w-4 h-4" />
                  <span>ترحيل وإصدار السند</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: New Cash Box */}
      {isAddBoxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">إضافة صندوق / حساب بنكي جديد</h3>
              <button onClick={() => setIsAddBoxModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveNewCashBox} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">اسم الصندوق أو البنك *</label>
                <input
                  type="text"
                  required
                  value={boxName}
                  onChange={(e) => setBoxName(e.target.value)}
                  placeholder="مثال: خزينة الصيدلية، بنك الإنماء..."
                  className="w-full px-3 py-2 border border-slate-200 rounded text-slate-900"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">الكود التعريفي *</label>
                <input
                  type="text"
                  required
                  value={boxCode}
                  onChange={(e) => setBoxCode(e.target.value)}
                  placeholder="مثال: CASH-PHARM / BANK-02..."
                  className="w-full px-3 py-2 border border-slate-200 rounded font-mono text-slate-900"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddBoxModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded"
                >
                  إلغاء
                </button>
                <button type="submit" className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded font-bold">
                  إضافة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Customer Notification Modal for WhatsApp, Print & Native Share */}
      <CustomerNotificationModal
        isOpen={notificationData.isOpen}
        onClose={() => setNotificationData((prev) => ({ ...prev, isOpen: false }))}
        recipientName={notificationData.recipientName}
        recipientPhone={notificationData.recipientPhone}
        documentType={notificationData.documentType}
        documentNumber={notificationData.documentNumber}
        amount={notificationData.amount}
        notes={notificationData.notes}
      />
    </div>
  );
};
