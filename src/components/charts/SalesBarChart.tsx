/**
 * رسم بياني شريطي احترافي فائق الجمال (Bar Chart) بـ SVG نقي متجاوب
 * يدعم التدرجات اللونية (Gradients)، تأثيرات التمرير التفاعلية (Tooltips)، والمؤشرات الدقيقة
 */
import React, { useState } from 'react';
import { getActiveCurrencyConfig } from '../../config/currency';

interface BarData {
  label: string;
  value: number;
  color: string;
}

interface SalesBarChartProps {
  data: BarData[];
  title: string;
  height?: number;
}

export const SalesBarChart: React.FC<SalesBarChartProps> = ({ data, title, height = 240 }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const currencySymbol = getActiveCurrencyConfig().symbol;

  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const totalValue = data.reduce((acc, curr) => acc + curr.value, 0);

  // تنسيق الأرقام بالآلاف أو الأصفار
  const formatValue = (num: number) => {
    return num.toLocaleString('ar-SA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  const svgPadding = { top: 25, right: 20, bottom: 45, left: 20 };
  const width = 360;
  const chartWidth = width - svgPadding.left - svgPadding.right;
  const chartHeight = height - svgPadding.top - svgPadding.bottom;
  const colWidth = chartWidth / data.length;
  const barWidth = Math.min(colWidth * 0.48, 36);

  return (
    <div className="space-y-3" dir="rtl">
      {/* رأس الرسم مع الإحصائيات */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
        <div>
          <h3 className="text-xs sm:text-sm font-bold text-slate-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            {title}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">مقارنة أداء المبيعات اللحظية بين الأنشطة</p>
        </div>
        <div className="text-left font-mono">
          <span className="text-[10px] text-slate-500 block">الإجمالي المحقق</span>
          <span className="text-xs sm:text-sm font-extrabold text-slate-900">{formatValue(totalValue)} {currencySymbol}</span>
        </div>
      </div>

      {/* منطقة SVG التفاعلية */}
      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto select-none overflow-visible"
          style={{ direction: 'ltr' }}
        >
          <defs>
            {data.map((d, i) => (
              <linearGradient key={`grad-${i}`} id={`barGrad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={d.color} stopOpacity="1" />
                <stop offset="100%" stopColor={d.color} stopOpacity="0.45" />
              </linearGradient>
            ))}
            <filter id="barShadow" x="-10%" y="-10%" width="120%" height="130%">
              <feDropShadow dx="0" dy="3" stdDeviation="2" floodOpacity="0.18" />
            </filter>
          </defs>

          {/* خطوط الشبكة الإرشادية Gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = svgPadding.top + chartHeight * (1 - ratio);
            const val = maxValue * ratio;
            return (
              <g key={ratio}>
                <line
                  x1={svgPadding.left}
                  y1={y}
                  x2={width - svgPadding.right}
                  y2={y}
                  stroke="#f1f5f9"
                  strokeDasharray={ratio === 0 ? undefined : '3,3'}
                  strokeWidth="1"
                />
                {ratio > 0 && (
                  <text
                    x={width - svgPadding.right + 4}
                    y={y + 3}
                    textAnchor="start"
                    fontSize="7"
                    fill="#94a3b8"
                    fontFamily="monospace"
                  >
                    {val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val.toFixed(0)}
                  </text>
                )}
              </g>
            );
          })}

          {/* خط الأساس السفلي */}
          <line
            x1={svgPadding.left}
            y1={svgPadding.top + chartHeight}
            x2={width - svgPadding.right}
            y2={svgPadding.top + chartHeight}
            stroke="#cbd5e1"
            strokeWidth="1.5"
          />

          {/* الأعمدة البيانية والتفاعل */}
          {data.map((d, i) => {
            const isHovered = hoveredIndex === i;
            const barHeight = maxValue > 0 ? (d.value / maxValue) * chartHeight : 0;
            const x = svgPadding.left + i * colWidth + (colWidth - barWidth) / 2;
            const y = svgPadding.top + chartHeight - barHeight;

            return (
              <g
                key={i}
                className="cursor-pointer transition-all duration-300"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                {/* خلفية عمود تفاعلية عند المرور Hover Track */}
                <rect
                  x={svgPadding.left + i * colWidth + 2}
                  y={svgPadding.top}
                  width={colWidth - 4}
                  height={chartHeight}
                  fill={isHovered ? '#f8fafc' : 'transparent'}
                  rx="6"
                  className="transition-colors duration-200"
                />

                {/* العمود الرئيسي مع تدرج لوني وظل وانحناء في القمة */}
                <rect
                  x={x}
                  y={barHeight > 0 ? y : svgPadding.top + chartHeight - 2}
                  width={barWidth}
                  height={Math.max(barHeight, 2)}
                  fill={`url(#barGrad-${i})`}
                  rx="5"
                  filter={isHovered ? 'url(#barShadow)' : undefined}
                  opacity={hoveredIndex !== null && !isHovered ? 0.45 : 1}
                  className="transition-all duration-300 transform origin-bottom"
                  style={{
                    transform: isHovered ? 'scaleY(1.02)' : 'scaleY(1)',
                  }}
                />

                {/* مؤشر القيمة العلوية فوق العمود */}
                <g style={{ opacity: isHovered || d.value > 0 ? 1 : 0.6 }}>
                  <text
                    x={x + barWidth / 2}
                    y={y - 6}
                    textAnchor="middle"
                    fontSize={isHovered ? '9' : '8'}
                    fontWeight={isHovered ? 'bold' : '600'}
                    fill={isHovered ? '#0f172a' : '#475569'}
                    fontFamily="monospace"
                  >
                    {d.value >= 1000 ? `${(d.value / 1000).toFixed(1)}k` : d.value.toFixed(0)}
                  </text>
                </g>

                {/* تسمية النشاط تحت المحور X */}
                <text
                  x={x + barWidth / 2}
                  y={svgPadding.top + chartHeight + 16}
                  textAnchor="middle"
                  fontSize={isHovered ? '9.5' : '8.5'}
                  fontWeight={isHovered ? 'bold' : '600'}
                  fill={isHovered ? '#0f172a' : '#64748b'}
                  fontFamily="sans-serif"
                >
                  {d.label}
                </text>

                {/* النسبة المئوية أسفل التسمية */}
                <text
                  x={x + barWidth / 2}
                  y={svgPadding.top + chartHeight + 28}
                  textAnchor="middle"
                  fontSize="7.5"
                  fill="#94a3b8"
                  fontFamily="monospace"
                >
                  {totalValue > 0 ? `${((d.value / totalValue) * 100).toFixed(0)}%` : '0%'}
                </text>
              </g>
            );
          })}
        </svg>

        {/* صندوق تفاصيل تفاعلي مصغر (Active Tooltip Bar) */}
        {hoveredIndex !== null && (
          <div className="absolute top-1 left-2 bg-slate-900/90 text-white backdrop-blur-xs px-2.5 py-1 rounded-md text-[10px] shadow-lg flex items-center gap-2 animate-fadeIn">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: data[hoveredIndex].color }}
            />
            <span className="font-bold">{data[hoveredIndex].label}:</span>
            <span className="font-mono text-emerald-400 font-bold">
              {formatValue(data[hoveredIndex].value)} {currencySymbol}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
