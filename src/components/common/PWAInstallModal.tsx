import React, { useState } from 'react';
import {
  Smartphone,
  Download,
  Share2,
  PlusSquare,
  CheckCircle2,
  X,
  WifiOff,
  Zap,
  Layers,
  Copy,
  Check,
} from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';

interface PWAInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PWAInstallModal: React.FC<PWAInstallModalProps> = ({ isOpen, onClose }) => {
  const { isInstallable, isInstalled, isIOS, isAndroid, install } = usePWAInstall();
  const [copied, setCopied] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  if (!isOpen) return null;

  const currentUrl = window.location.href;
  const mobileLocalUrl = 'http://10.244.115.230:3000';
  const cloudUrl = 'https://ais-pre-whq6c7263bbvzvlv2i2kaa-364280012769.europe-west3.run.app';

  const handleInstallClick = async () => {
    const success = await install();
    if (success) {
      setInstallSuccess(true);
      setTimeout(() => {
        onClose();
      }, 2000);
    }
  };

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-sm animate-fadeIn select-none" dir="rtl">
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-gradient-to-l from-emerald-800 via-emerald-700 to-teal-800 text-white p-5 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-white/10 backdrop-blur flex items-center justify-center border border-white/20 shrink-0">
              <Smartphone className="w-6 h-6 text-emerald-200" />
            </div>
            <div>
              <h2 className="text-lg font-bold">تثبيت تطبيق نظام الإدارة التجارية على الهاتف</h2>
              <p className="text-xs text-emerald-100 mt-0.5">
                تطبيق خفيف، سريع، ويعمل بكفاءة دون إنترنت
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-5 text-slate-800">
          {/* Features pills */}
          <div className="grid grid-cols-3 gap-2.5">
            <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-100 flex flex-col items-center text-center">
              <Zap className="w-5 h-5 text-emerald-600 mb-1" />
              <span className="text-[11px] font-bold text-slate-800">تشغيل فوري</span>
              <span className="text-[10px] text-slate-500">أسرع من المتصفح</span>
            </div>
            <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-100 flex flex-col items-center text-center">
              <WifiOff className="w-5 h-5 text-blue-600 mb-1" />
              <span className="text-[11px] font-bold text-slate-800">بدون إنترنت</span>
              <span className="text-[10px] text-slate-500">دعم العمل Offline</span>
            </div>
            <div className="p-2.5 rounded-xl bg-purple-50 border border-purple-100 flex flex-col items-center text-center">
              <Layers className="w-5 h-5 text-purple-600 mb-1" />
              <span className="text-[11px] font-bold text-slate-800">شاشة كاملة</span>
              <span className="text-[10px] text-slate-500">كتطبيق أصلي</span>
            </div>
          </div>

          {/* Already installed state */}
          {isInstalled ? (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-3 text-emerald-800">
              <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
              <div>
                <p className="font-bold text-sm">التطبيق مثبت بالفعل على هذا الجهاز!</p>
                <p className="text-xs text-emerald-700 mt-0.5">
                  أنت تستخدم النظام الآن عبر وضع التطبيق المستقل (Standalone).
                </p>
              </div>
            </div>
          ) : isInstallable ? (
            /* Native Install Prompt Button Available (Chrome on Android / Desktop) */
            <div className="space-y-3">
              <button
                onClick={handleInstallClick}
                disabled={installSuccess}
                className="w-full py-3.5 px-4 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-xl font-bold flex items-center justify-center gap-2.5 shadow-lg shadow-emerald-600/25 transition-all text-sm"
              >
                {installSuccess ? (
                  <>
                    <CheckCircle2 className="w-5 h-5" />
                    <span>تم التثبيت بنجاح على الشاشة الرئيسية!</span>
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    <span>تثبيت التطبيق على الجهاز الآن</span>
                  </>
                )}
              </button>
              <p className="text-center text-xs text-slate-500">
                سيظهر التطبيق كأيقونة مستقلة على شاشة هاتفك الرئيسية
              </p>
            </div>
          ) : isIOS ? (
            /* iOS Safari Instructions */
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-600" />
                طريقة التثبيت على أجهزة iPhone / iPad (متصفح Safari):
              </h3>
              <ol className="space-y-2.5 text-xs text-slate-700 list-decimal list-inside pr-1">
                <li className="leading-relaxed">
                  اضغط على زر <strong className="text-emerald-700">المشاركة (Share)</strong>{' '}
                  <Share2 className="w-3.5 h-3.5 inline text-blue-600 mx-1" /> أسفل شاشة Safari.
                </li>
                <li className="leading-relaxed">
                  مرر للأسفل واضغط على خيار{' '}
                  <strong className="text-emerald-700">«إضافة إلى الصفحة الرئيسية»</strong>{' '}
                  <PlusSquare className="w-3.5 h-3.5 inline text-slate-700 mx-1" />
                </li>
                <li className="leading-relaxed">
                  اضغط على <strong className="text-emerald-700">«إضافة» (Add)</strong> في الزاوية العلوية.
                </li>
              </ol>
            </div>
          ) : (
            /* Android Chrome manual instructions */
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-600" />
                طريقة التثبيت على أجهزة أندرويد (Google Chrome):
              </h3>
              <ol className="space-y-2.5 text-xs text-slate-700 list-decimal list-inside pr-1">
                <li className="leading-relaxed">
                  اضغط على زر القائمة <strong className="text-emerald-700">⋮ (النقاط الثلاث)</strong> في أعلى أو أسفل المتصفح.
                </li>
                <li className="leading-relaxed">
                  اختر <strong className="text-emerald-700">«تثبيت التطبيق»</strong> أو{' '}
                  <strong className="text-emerald-700">«الإضافة إلى الشاشة الرئيسية»</strong>.
                </li>
                <li className="leading-relaxed">
                  سيتم إنشاء أيقونة رسمية للتطبيق تفتح بملء الشاشة بدون شريط عناوين.
                </li>
              </ol>
            </div>
          )}

          {/* Links for opening from the phone */}
          <div className="pt-2 border-t border-slate-200 space-y-2.5">
            <span className="text-xs font-bold text-slate-700 block">
              روابط فتح النظام من الهاتف (اختر الأنسب لك):
            </span>

            {/* Local Wi-Fi Network Link */}
            <div className="p-3 bg-slate-100 hover:bg-slate-200/70 transition-colors rounded-xl flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[11px] font-bold text-slate-800 block">
                  1. رابط شبكة الواي فاي المحلية (لأجهزة المحل/الكاشير):
                </span>
                <span className="text-xs font-mono text-emerald-800 font-semibold block truncate">
                  {mobileLocalUrl}
                </span>
              </div>
              <button
                onClick={() => handleCopy(mobileLocalUrl)}
                className="shrink-0 p-2 text-slate-600 hover:text-emerald-700 bg-white rounded-lg border border-slate-200 shadow-sm text-xs flex items-center gap-1 font-semibold"
                title="نسخ الرابط"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'تم النسخ' : 'نسخ'}</span>
              </button>
            </div>

            {/* Cloud HTTPS Link (Best for PWA installation) */}
            <div className="p-3 bg-emerald-50/70 hover:bg-emerald-100/60 transition-colors rounded-xl flex items-center justify-between gap-2 border border-emerald-200/60">
              <div className="min-w-0">
                <span className="text-[11px] font-bold text-emerald-950 block">
                  2. الرابط السحابي المباشر الآمن (الأفضل لتثبيت التطبيق فورا):
                </span>
                <span className="text-xs font-mono text-emerald-700 font-semibold block truncate">
                  {cloudUrl}
                </span>
              </div>
              <button
                onClick={() => handleCopy(cloudUrl)}
                className="shrink-0 p-2 text-emerald-700 hover:text-emerald-900 bg-white rounded-lg border border-emerald-300 shadow-sm text-xs flex items-center gap-1 font-semibold"
                title="نسخ الرابط السحابي"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>نسخ</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl text-xs font-bold transition-colors"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
