/**
 * وحدة إعدادات الشركة — تخصيص الاسم والشعار والبيانات التجارية
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Building2, Save, CheckCircle, Image, X, Phone, Mail,
  MapPin, FileText, Hash, Globe, AlertCircle,
} from 'lucide-react';
import { CompanyProfile } from '../../services/storageService';
import { dataService } from '../../services/dataService';
import { desktopSession } from '../../services/desktopSession';
import { CURRENCY_PRESETS, SupportedCurrencyCode } from '../../config/currency';

interface CompanySettingsProps {
  onRefresh: () => void;
}

const DEFAULT_FALLBACK_PROFILE: CompanyProfile = {
  nameAr: 'نظام الإدارة التجارية والمحاسبية المتكامل',
  currencyCode: 'SAR',
  currency: 'ريال سعودي',
  currencySymbol: 'ر.س',
  currencyDecimalPlaces: 2,
};

export const CompanySettings: React.FC<CompanySettingsProps> = ({ onRefresh }) => {
  const [profile, setProfile] = useState<CompanyProfile>(() => {
    if (typeof window !== 'undefined' && window.amroDesktop) {
      return desktopSession.getCompanyProfile() || DEFAULT_FALLBACK_PROFILE;
    }
    return DEFAULT_FALLBACK_PROFILE;
  });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(profile.logo || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    dataService
      .getCompanyProfile()
      .then((loaded) => {
        if (!active || !loaded) return;
        setProfile(loaded);
        setLogoPreview(loaded.logo || null);
      })
      .catch((err) => {
        if (!active) return;
        setSaveError(err instanceof Error ? err.message : 'تعذر تحميل بيانات المنشأة.');
      });
    return () => {
      active = false;
    };
  }, []);

  const handleChange = (field: keyof CompanyProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
    setSaveError(null);
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
    setSaveError(null);
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

  const handleSave = async () => {
    if (isSaving) return;
    setSaveError(null);
    if (!profile.nameAr?.trim()) {
      setSaveError('اسم الشركة بالعربية مطلوب.');
      return;
    }
    setIsSaving(true);
    try {
      const updated = await dataService.saveCompanyProfile(profile);
      setProfile(updated);
      setLogoPreview(updated.logo || null);
      setSaved(true);
      onRefresh();
      setTimeout(() => setSaved(false), 3000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'تعذر حفظ إعدادات الشركة.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6" dir="rtl">
      {saveError && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-800">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}
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

      {/* معاينة رأس المستند الرسمي */}
      <div className="bg-slate-50 rounded-2xl border border-slate-200 p-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">
          معاينة ترويسة المستندات الرسمية
        </h2>
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-4">
            <div className="flex items-start gap-3.5">
              {logoPreview && (
                <img
                  src={logoPreview}
                  alt={profile.nameAr || 'شعار المنشأة'}
                  className="w-16 h-16 object-contain rounded-lg border border-slate-200 p-1 shrink-0"
                />
              )}
              <div className="space-y-1">
                <div className="font-black text-slate-900 text-base">
                  {profile.nameAr || 'المؤسسة التجارية'}
                </div>
                {profile.nameEn && (
                  <div className="text-[11px] font-bold text-slate-500">{profile.nameEn}</div>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
                  {profile.phone && <span className="font-mono">هاتف: {profile.phone}</span>}
                  {profile.taxNumber && (
                    <span className="font-mono">الرقم الضريبي: {profile.taxNumber}</span>
                  )}
                </div>
                {(profile.address || profile.email || profile.website) && (
                  <div className="text-[10px] text-slate-500">
                    {[profile.address, profile.email, profile.website].filter(Boolean).join(' | ')}
                  </div>
                )}
              </div>
            </div>
            <div className="px-3 py-1 bg-slate-900 text-white rounded text-[11px] font-extrabold shrink-0">
              نموذج الترويسة المعتمدة
            </div>
          </div>
          {profile.headerNote && (
            <div className="mt-3 text-xs text-slate-600 font-semibold text-center">
              {profile.headerNote}
            </div>
          )}
          {profile.footerNote && (
            <div className="mt-3 pt-2 border-t border-dashed border-slate-200 text-[11px] text-slate-500 text-center">
              {profile.footerNote}
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end pb-6">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold shadow-sm transition-all disabled:opacity-60 ${
            saved ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          }`}
        >
          {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {isSaving ? 'جارٍ الحفظ...' : saved ? 'تم الحفظ بنجاح!' : 'حفظ التغييرات'}
        </button>
      </div>
    </div>
  );
};
