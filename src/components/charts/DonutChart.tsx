/**
 * رسم بياني دائري احترافي فائق الوضوح (Donut Chart) بـ SVG نقي متجاوب
 * يدعم التفاعل، بطاقات التمرير، ونسباً إحصائية أنيقة
 */
import React, { useState } from 'react';
import { getActiveCurrencyConfig } from '../../config/currency';

interface DonutData {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  data: DonutData[];
  title: string;
  centerLabel?: string;
  centerValue?: string;
}

// دالة حساب مسار القوس الدائري بدقة هندسية عالية
function getArcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number
): string {
  // منع تطابق الزوايا الدائرية الكاملة
  const diff = endAngle - startAngle;
  const clampedEnd = diff >= 2 * Math.PI ? startAngle + 2 * Math.PI - 0.0001 : endAngle;

  const x1 = cx + outerR * Math.cos(startAngle);
  const y1 = cy + outerR * Math.sin(startAngle);
  const x2 = cx + outerR * Math.cos(clampedEnd);
  const y2 = cy + outerR * Math.sin(clampedEnd);

  const x3 = cx + innerR * Math.cos(clampedEnd);
  const y3 = cy + innerR * Math.sin(clampedEnd);
  const x4 = cx + innerR * Math.cos(startAngle);
  const y4 = cy + innerR * Math.sin(startAngle);

  const largeArc = clampedEnd - startAngle > Math.PI ? 1 : 0;

  return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;
}

export const DonutChart: React.FC<DonutChartProps> = ({ data, title, centerLabel, centerValue }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const total = data.reduce((s, d) => s + d.value, 0);

  const formatValue = (num: number) => {
    return num.toLocaleString('ar-SA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  if (total === 0) {
    return (
      <div className="space-y-3" dir="rtl">
        <h3 className="text-xs sm:text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-2.5">
          <span className="w-2 h-2 rounded-full bg-amber-500"></span>
          {title}
        </h3>
        <div className="flex flex-col items-center justify-center h-48 text-slate-400 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
          <span className="text-xs font-medium">المستودعات خالية حالياً</span>
          <span className="text-[10px] text-slate-400 mt-1">سجل أول صنف لعرض توزيع القيمة</span>
        </div>
      </div>
    );
  }

  const cx = 60;
  const cy = 60;
  const outerR = 48;
  const innerR = 30;

  // إزاحة خفيفة بين القطاعات (Padding angle)
  let currentAngle = -Math.PI / 2;
  const gap = data.length > 1 ? 0.03 : 0;

  const slices = data.map((d, i) => {
    const angle = (d.value / total) * (2 * Math.PI - data.length * gap);
    const startAngle = currentAngle;
    const endAngle = startAngle + angle;
    currentAngle = endAngle + gap;
    const pct = ((d.value / total) * 100).toFixed(1);
    return { ...d, startAngle, endAngle, pct, index: i };
  });

  const activeSlice = hoveredIndex !== null ? slices[hoveredIndex] : null;

  return (
    <div className="space-y-3" dir="rtl">
      {/* رأس الرسم */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
        <div>
          <h3 className="text-xs sm:text-sm font-bold text-slate-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
            {title}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">توزيع رأس المال السلعي عبر الأنشطة</p>
        </div>
        <div className="text-left font-mono">
          <span className="text-[10px] text-slate-500 block">إجمالي التقييم</span>
          <span className="text-xs sm:text-sm font-extrabold text-slate-900">{formatValue(total)} {currencySymbol}</span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 pt-1">
        {/* الدائرة البيانية مع تأثيرات الظلال والحلقات المركزية */}
        <div className="relative shrink-0 w-36 sm:w-40 select-none">
          <svg viewBox="0 0 120 120" className="w-full h-auto overflow-visible" style={{ direction: 'ltr' }}>
            <defs>
              <filter id="donutShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.2" />
              </filter>
            </defs>

            {/* حلقة خلفية جمالية */}
            <circle cx={cx} cy={cy} r={(outerR + innerR) / 2} fill="none" stroke="#f1f5f9" strokeWidth={outerR - innerR} />

            {/* قطاعات الدائرة مع التكبير عند التمرير */}
            {slices.map((s) => {
              const isHovered = hoveredIndex === s.index;
              const rOut = isHovered ? outerR + 3 : outerR;
              const rIn = isHovered ? innerR - 2 : innerR;

              return (
                <path
                  key={s.index}
                  d={getArcPath(cx, cy, rOut, rIn, s.startAngle, s.endAngle)}
                  fill={s.color}
                  filter={isHovered ? 'url(#donutShadow)' : undefined}
                  opacity={hoveredIndex !== null && !isHovered ? 0.5 : 1}
                  className="cursor-pointer transition-all duration-300"
                  onMouseEnter={() => setHoveredIndex(s.index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              );
            })}

            {/* نصوص منتصف الحلقة (Interactive Center Badge) */}
            <g className="pointer-events-none select-none">
              <text
                x={cx}
                y={cy - 5}
                textAnchor="middle"
                fontSize="7.5"
                fill="#64748b"
                fontWeight="600"
                fontFamily="sans-serif"
              >
                {activeSlice ? activeSlice.label : centerLabel || 'الإجمالي'}
              </text>
              <text
                x={cx}
                y={cy + 8}
                textAnchor="middle"
                fontSize="9"
                fill="#0f172a"
                fontFamily="monospace"
                fontWeight="bold"
              >
                {activeSlice
                  ? `${activeSlice.pct}%`
                  : centerValue
                  ? centerValue.split(' ')[0]
                  : formatValue(total).split('.')[0]}
              </text>
              <text
                x={cx}
                y={cy + 17}
                textAnchor="middle"
                fontSize="6"
                fill="#94a3b8"
                fontFamily="sans-serif"
              >
                {activeSlice ? `${formatValue(activeSlice.value)} ${currencySymbol}` : currencySymbol}
              </text>
            </g>
          </svg>
        </div>

        {/* دليل الألوان الجانبي مع النسب والمبالغ Legend */}
        <div className="flex-1 w-full space-y-2">
          {slices.map((s) => {
            const isHovered = hoveredIndex === s.index;
            return (
              <div
                key={s.index}
                onMouseEnter={() => setHoveredIndex(s.index)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all border ${
                  isHovered
                    ? 'bg-slate-50 border-slate-300 shadow-xs scale-[1.01]'
                    : 'bg-white border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <span
                    className="w-3 h-3 rounded-md shrink-0 shadow-2xs"
                    style={{ backgroundColor: s.color }}
                  />
                  <div className="truncate">
                    <span className="text-xs font-semibold text-slate-800 block truncate">{s.label}</span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      {formatValue(s.value)} {currencySymbol}
                    </span>
                  </div>
                </div>
                <div className="text-left font-mono">
                  <span
                    className="px-2 py-0.5 rounded text-[11px] font-bold"
                    style={{
                      backgroundColor: `${s.color}15`,
                      color: s.color,
                    }}
                  >
                    {s.pct}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
