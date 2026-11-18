/**
 * إدارة العملاء والموردين وكشوف الحسابات (Customers & Suppliers Management)
 * سجل الديون والمستحقات، حدود الائتمان، وكشف حساب تفصيلي
 */

import React, { useState } from 'react';
import {
  Users,
  Plus,
  Search,
  Phone,
  MapPin,
  FileText,
  DollarSign,
  Printer,
  X,
  Check,
  Building,
  UserCheck,
} from 'lucide-react';
import { storage } from '../../services/storageService';
import { useLiveParties, useLiveInvoices, useLiveVouchers } from '../../hooks/useLiveDexie';
import { Party, PartyType, Invoice, PaymentVoucher } from '../../types/erp';

interface PartiesManagerProps {
  onRefresh: () => void;
}

export const PartiesManager: React.FC<PartiesManagerProps> = ({ onRefresh }) => {
  const [activeTab, setActiveTab] = useState<PartyType>('CUSTOMER');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedPartyForStatement, setSelectedPartyForStatement] = useState<Party | null>(null);

  // حقول نموذج الإضافة
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formTaxNumber, setFormTaxNumber] = useState('');
  const [formCreditLimit, setFormCreditLimit] = useState('');

  const parties = useLiveParties(activeTab);
  const allInvoices = useLiveInvoices();
  const allVouchers = useLiveVouchers();

  const filteredParties = parties.filter((p) => {
    const q = searchQuery.toLowerCase();
    return (
      !searchQuery.trim() ||
      p.nameAr.toLowerCase().includes(q) ||
      (p.phone && p.phone.includes(q)) ||
      (p.address && p.address.toLowerCase().includes(q))
    );
  });

  const handleSaveParty = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formPhone.trim()) return;

    const newParty: Party = {
      id: storage.generateUUID(),
      type: activeTab,
      nameAr: formName.trim(),
      phone: formPhone.trim(),
      address: formAddress.trim() || undefined,
      taxNumber: formTaxNumber.trim() || undefined,
      balance: 0,
      creditLimit: Number(formCreditLimit) || undefined,
    };

    storage.addParty(newParty);
    setIsAddModalOpen(false);
    setFormName('');
    setFormPhone('');
    setFormAddress('');
    setFormTaxNumber('');
    setFormCreditLimit('');
    onRefresh();
  };

  // استخراج حركات كشف الحساب للشخص المحدد
  const getPartyTransactions = (party: Party) => {
    const relevantInvoices = allInvoices.filter((inv) => inv.partyId === party.id);
    const relevantVouchers = allVouchers.filter((v) => v.partyId === party.id);

    const items: Array<{
      date: string;
      docNumber: string;
      description: string;
      debit: number;
      credit: number;
    }> = [];

    relevantInvoices.forEach((inv) => {
      if (party.type === 'CUSTOMER') {
        // فاتورة بيع للعميل: مدين بإجمالي الفاتورة
        items.push({
          date: inv.date,
          docNumber: inv.invoiceNumber,
          description: `فاتورة مبيعات (${inv.paymentMethod === 'CASH' ? 'نقدي' : 'آجل'})`,
          debit: inv.total,
          credit: inv.paidAmount, // المسدد فوراً دائن
        });
      } else {
        // فاتورة شراء من مورد: دائن بإجمالي الفاتورة
        items.push({
          date: inv.date,
          docNumber: inv.invoiceNumber,
          description: `فاتورة مشتريات (${inv.paymentMethod === 'CASH' ? 'نقدي' : 'آجل'})`,
          debit: inv.paidAmount,
          credit: inv.total,
        });
      }
    });

    relevantVouchers.forEach((v) => {
      if (v.type === 'RECEIPT') {
        // سند قبض من عميل: دائن يخفض حسابه
        items.push({
          date: v.date,
          docNumber: v.voucherNumber,
          description: `سند قبض نقدي: ${v.description}`,
          debit: 0,
          credit: v.amount,
        });
      } else {
        // سند صرف لمورد: مدين يخفض مستحقاته
        items.push({
          date: v.date,
          docNumber: v.voucherNumber,
          description: `سند صرف نقدي: ${v.description}`,
          debit: v.amount,
          credit: 0,
        });
      }
    });

    return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Tabs and Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('CUSTOMER')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'CUSTOMER'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            العملاء والمدينون ({storage.getParties('CUSTOMER').length})
          </button>
          <button
            onClick={() => setActiveTab('SUPPLIER')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'SUPPLIER'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            الموردون والدائنون ({storage.getParties('SUPPLIER').length})
          </button>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`بحث باسم أو هاتف ${activeTab === 'CUSTOMER' ? 'العميل' : 'المورد'}...`}
              className="w-full pl-3 pr-9 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none"
            />
          </div>

          <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
          >
            <Plus className="w-4 h-4 text-emerald-400" />
            <span>إضافة {activeTab === 'CUSTOMER' ? 'عميل' : 'مورد'} جديد</span>
          </button>
        </div>
      </div>

      {/* Parties Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 bg-slate-50">
                <th className="py-3 px-4">الاسم الكامل</th>
                <th className="py-3 px-4">رقم الهاتف</th>
                <th className="py-3 px-4">العنوان / المدينة</th>
                <th className="py-3 px-4 text-center">الرقم الضريبي</th>
                <th className="py-3 px-4 text-center">الرصيد المالي الحالي</th>
                <th className="py-3 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredParties.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    <Users className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-semibold">لا يوجد {activeTab === 'CUSTOMER' ? 'عملاء' : 'موردون'} مسجلون</p>
                    <p className="text-[11px] text-slate-400 mt-1">اضغط على زر الإضافة لتسجيل البيانات</p>
                  </td>
                </tr>
              ) : (
                filteredParties.map((party) => (
                  <tr key={party.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-bold text-slate-900">{party.nameAr}</td>
                    <td className="py-3 px-4 font-mono text-slate-600">{party.phone}</td>
                    <td className="py-3 px-4 text-slate-600">{party.address || '-'}</td>
                    <td className="py-3 px-4 text-center font-mono text-slate-500">{party.taxNumber || '-'}</td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full font-mono font-bold tabular-nums text-xs ${
                          party.balance > 0
                            ? 'bg-emerald-100 text-emerald-800'
                            : party.balance < 0
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {party.balance.toFixed(2)} ر.س
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => setSelectedPartyForStatement(party)}
                        className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-semibold text-[11px] flex items-center gap-1 mx-auto transition-colors"
                      >
                        <FileText className="w-3 h-3 text-slate-600" />
                        <span>كشف حساب</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-5 py-4 bg-slate-900 text-white">
              <h3 className="text-xs font-bold">تسجيل {activeTab === 'CUSTOMER' ? 'عميل' : 'مورد'} جديد</h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveParty} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">الاسم التجاري أو الشخصي *</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="مثال: شركة النور للتوزيع / أحمد محمد..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف *</label>
                <input
                  type="tel"
                  required
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="05XXXXXXXX"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">العنوان / المدينة</label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="مثال: الرياض - شارع الملك فهد..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الرقم الضريبي</label>
                  <input
                    type="text"
                    value={formTaxNumber}
                    onChange={(e) => setFormTaxNumber(e.target.value)}
                    placeholder="اختياري..."
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">سقف الائتمان (الحد الأقصى للديون)</label>
                  <input
                    type="number"
                    value={formCreditLimit}
                    onChange={(e) => setFormCreditLimit(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-slate-900 font-mono focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg"
                >
                  حفظ وتسجيل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Statement of Account Modal (كشف الحساب التفصيلي) */}
      {selectedPartyForStatement && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto no-print">
          <div className="relative w-full max-w-3xl bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white no-print">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-emerald-400" />
                <span className="font-bold text-sm">
                  كشف حساب: {selectedPartyForStatement.nameAr}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  <Printer className="w-4 h-4" />
                  <span>طباعة الكشف</span>
                </button>
                <button
                  onClick={() => setSelectedPartyForStatement(null)}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-8 text-xs printable-area bg-white text-slate-800">
              <div className="text-center border-b border-slate-200 pb-4 mb-4">
                <h2 className="text-lg font-extrabold text-slate-900">نظام الإدارة التجارية والمحاسبية المتكامل</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  كشف حساب تفصيلي لـ ({selectedPartyForStatement.type === 'CUSTOMER' ? 'العميل' : 'المورد'})
                </p>
                <div className="text-sm font-bold text-slate-900 mt-2">{selectedPartyForStatement.nameAr}</div>
                <div className="text-xs text-slate-500 font-mono">هاتف: {selectedPartyForStatement.phone}</div>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-hidden mb-4">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                    <tr>
                      <th className="py-2.5 px-3">التاريخ</th>
                      <th className="py-2.5 px-3">رقم المستند</th>
                      <th className="py-2.5 px-3">البيان والحركة</th>
                      <th className="py-2.5 px-3 text-center">مدين</th>
                      <th className="py-2.5 px-3 text-center">دائن</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {getPartyTransactions(selectedPartyForStatement).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          لا توجد حركات أو فواتير مسجلة لهذا الحساب
                        </td>
                      </tr>
                    ) : (
                      getPartyTransactions(selectedPartyForStatement).map((item, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-mono text-slate-600">{item.date}</td>
                          <td className="py-2 px-3 font-mono font-bold text-slate-900">{item.docNumber}</td>
                          <td className="py-2 px-3">{item.description}</td>
                          <td className="py-2 px-3 text-center font-mono tabular-nums font-semibold">
                            {item.debit > 0 ? item.debit.toFixed(2) : '-'}
                          </td>
                          <td className="py-2 px-3 text-center font-mono tabular-nums font-semibold">
                            {item.credit > 0 ? item.credit.toFixed(2) : '-'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 flex justify-between items-center text-sm font-bold">
                <span>الرصيد الدفتري الختامي:</span>
                <span className="font-mono tabular-nums text-base text-emerald-800">
                  {selectedPartyForStatement.balance.toFixed(2)} ر.س
                </span>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end no-print">
              <button
                onClick={() => setSelectedPartyForStatement(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
