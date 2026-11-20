/**
 * وحدة إعدادات الشركة — تخصيص الاسم والشعار والبيانات التجارية
 */

import React, { useState, useRef } from 'react';
import {
  Building2, Save, CheckCircle, Image, X, Phone, Mail,
  MapPin, FileText, Hash, Globe, AlertCircle,
} from 'lucide-react';
import { storage, CompanyProfile } from '../../services/storageService';
import { CURRENCY_PRESETS, SupportedCurrencyCode } from '../../config/currency';

interface CompanySettingsProps {
  onRefresh: () => void;
}

export const CompanySettings: React.FC<CompanySettingsProps> = ({ onRefresh }) => {
  const [profile, setProfile] = useState<CompanyProfile>(() => storage.getCompanyProfile());
  const [saved, setSaved] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(profile.logo || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (field: keyof CompanyProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  const handleCurrencyPresetChange = (code: SupportedCurrencyCode) => {
    const preset = CURRENCY_PRESETS[code];
    if (!preset) return;
    setProfile((prev) => ({
      ...prev,
      currencyCode: preset.code,
      currency: preset.nameAr,
      currencySymbol: preset.symbol,
    }));
    setSaved(false);
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setLogoError('حجم الصورة يجب أن يكون أقل من 2 ميجابايت');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      setLogoPreview(base64);
      setProfile((prev) => ({ ...prev, logo: base64 }));
      setSaved(false);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setLogoPreview(null);
    setProfile((prev) => ({ ...prev, logo: undefined }));
    setSaved(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSave = () => {
    storage.saveCompanyProfile(profile);
    setSaved(true);
    onRefresh();
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6" dir="rtl">
      {/* العنوان */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-emerald-700" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900">إعدادات الشركة</h1>
            <p className="text-xs text-slate-500">تخصيص بيانات المنشأة والفاتورة</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold shadow-sm transition-all ${
            saved ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          }`}
        >
          {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saved ? 'تم الحفظ!' : 'حفظ التغييرات'}
        </button>
      </div>

      {/* الشعار */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-3 flex items-center gap-2">
          <Image className="w-4 h-4 text-slate-500" /> شعار الشركة
        </h2>
        <div className="flex items-center gap-4">
          <div className="w-24 h-24 rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center bg-slate-50 overflow-hidden shrink-0">
            {logoPreview ? (
              <img src={logoPreview} alt="شعار" className="w-full h-full object-contain" />
            ) : (
              <Building2 className="w-10 h-10 text-slate-300" />
            )}
          </div>
          <div className="space-y-2">
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" id="logo-upload" />
            <label htmlFor="logo-upload" className="inline-flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer transition-colors">
              <Image className="w-3.5 h-3.5" /> رفع شعار
            </label>
            {logoPreview && (
              <button onClick={handleRemoveLogo} className="flex items-center gap-2 px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-xs font-semibold transition-colors">
                <X className="w-3.5 h-3.5" /> حذف الشعار
              </button>
            )}
            <p className="text-[10px] text-slate-400">PNG/JPG، الحجم الأقصى 2MB</p>
            {logoError && (
              <div className="flex items-center gap-1.5 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 text-[11px]">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{logoError}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* البيانات الأساسية */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-3 flex items-center gap-2">
          <Building2 className="w-4 h-4 text-slate-500" /> بيانات المنشأة
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            { label: 'اسم الشركة بالعربية', field: 'nameAr' as keyof CompanyProfile, placeholder: 'مؤسسة النجاح للتجارة', icon: <Building2 className="w-3.5 h-3.5 text-slate-400" />, required: true },
            { label: 'اسم الشركة بالإنجليزية', field: 'nameEn' as keyof CompanyProfile, placeholder: 'Al Najah Trading Est.', icon: <Globe className="w-3.5 h-3.5 text-slate-400" /> },
            { label: 'رقم الهاتف', field: 'phone' as keyof CompanyProfile, placeholder: '05XXXXXXXX', icon: <Phone className="w-3.5 h-3.5 text-slate-400" /> },
            { label: 'البريد الإلكتروني', field: 'email' as keyof CompanyProfile, placeholder: 'info@company.com', icon: <Mail className="w-3.5 h-3.5 text-slate-400" /> },
            { label: 'الرقم الضريبي', field: 'taxNumber' as keyof CompanyProfile, placeholder: '300XXXXXXXXX003', icon: <Hash className="w-3.5 h-3.5 text-slate-400" /> },
            { label: 'الموقع الإلكتروني', field: 'website' as keyof CompanyProfile, placeholder: 'www.company.com', icon: <Globe className="w-3.5 h-3.5 text-slate-400" /> },
          ].map(({ label, field, placeholder, icon, required }) => (
            <div key={field} className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                {icon}{label}{required && <span className="text-rose-500">*</span>}
              </label>
              <input
                type="text"
                value={(profile[field] as string) || ''}
                onChange={(e) => handleChange(field, e.target.value)}
                placeholder={placeholder}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900 placeholder-slate-400"
              />
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-slate-400" /> عنوان المنشأة
          </label>
          <textarea
            value={profile.address || ''}
            onChange={(e) => handleChange('address', e.target.value)}
            placeholder="المدينة، الحي، الشارع، رقم المبنى"
            rows={2}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900 placeholder-slate-400 resize-none"
          />
        </div>
      </div>

      {/* العملة */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-3 flex items-center gap-2">
          <FileText className="w-4 h-4 text-slate-500" /> العملة الموحدة (CFG-01)
        </h2>
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-700">العملة المعتمدة</label>
          <select
            value={profile.currencyCode || 'SAR'}
            onChange={(e) => handleCurrencyPresetChange(e.target.value as SupportedCurrencyCode)}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900 font-semibold"
          >
            {Object.values(CURRENCY_PRESETS).map((preset) => (
              <option key={preset.code} value={preset.code}>
                {preset.code} — {preset.nameAr} ({preset.symbol})
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            { label: 'اسم العملة', field: 'currency' as keyof CompanyProfile, placeholder: 'ريال سعودي' },
            { label: 'رمز العملة', field: 'currencySymbol' as keyof CompanyProfile, placeholder: 'ر.س' },
          ].map(({ label, field, placeholder }) => (
            <div key={field} className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">{label}</label>
              <input
                type="text"
                value={(profile[field] as string) || ''}
                onChange={(e) => handleChange(field, e.target.value)}
                placeholder={placeholder}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900 placeholder-slate-400"
              />
            </div>
          ))}
        </div>
      </div>

      {/* نصوص الفاتورة */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-3 flex items-center gap-2">
          <FileText className="w-4 h-4 text-slate-500" /> نصوص الفاتورة
        </h2>
        {[
          { label: 'ملاحظة رأس الفاتورة', field: 'headerNote' as keyof CompanyProfile, placeholder: 'مثال: شكراً لتعاملكم معنا' },
          { label: 'ملاحظة ذيل الفاتورة', field: 'footerNote' as keyof CompanyProfile, placeholder: 'مثال: البضاعة المباعة لا تُرد ولا تُستبدل' },
        ].map(({ label, field, placeholder }) => (
          <div key={field} className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-700">{label}</label>
            <textarea
              value={(profile[field] as string) || ''}
              onChange={(e) => handleChange(field, e.target.value)}
              placeholder={placeholder}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50 text-slate-900 placeholder-slate-400 resize-none"
            />
          </div>
        ))}
      </div>

      {/* معاينة رأس الفاتورة */}
      <div className="bg-slate-50 rounded-2xl border border-slate-200 p-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">معاينة رأس الفاتورة</h2>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-bold text-slate-900 text-base">{profile.nameAr || 'اسم الشركة'}</div>
              {profile.nameEn && <div className="text-xs text-slate-500">{profile.nameEn}</div>}
              {profile.address && <div className="text-xs text-slate-500 mt-1">📍 {profile.address}</div>}
              {profile.phone && <div className="text-xs text-slate-500">📞 {profile.phone}</div>}
              {profile.taxNumber && <div className="text-xs text-slate-500">الرقم الضريبي: {profile.taxNumber}</div>}
            </div>
            {logoPreview ? (
              <img src={logoPreview} alt="logo" className="w-16 h-16 object-contain rounded-lg border border-slate-100 shrink-0" />
            ) : (
              <div className="w-16 h-16 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                <Building2 className="w-8 h-8 text-emerald-600" />
              </div>
            )}
          </div>
          {profile.headerNote && (
            <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-600 italic">{profile.headerNote}</div>
          )}
        </div>
      </div>

      <div className="flex justify-end pb-6">
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold shadow-sm transition-all ${
            saved ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          }`}
        >
          {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saved ? 'تم الحفظ بنجاح!' : 'حفظ التغييرات'}
        </button>
      </div>
    </div>
  );
};
