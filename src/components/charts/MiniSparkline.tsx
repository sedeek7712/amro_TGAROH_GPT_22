/**
 * MiniSparkline - خط بياني صغير (Sparkline) بـ SVG نقي
 * يمثل اتجاه البيانات بشكل مبسط
 */

import React from 'react';

interface MiniSparklineProps {
  data: number[];
  color?: string;
  height?: number;
}

export const MiniSparkline: React.FC<MiniSparklineProps> = ({
  data,
  color = '#10b981',
  height = 40,
}) => {
  if (!data || data.length < 2) return null;

  const viewBoxWidth = 120;
  const viewBoxHeight = height;
  const padding = 4;

  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * (viewBoxWidth - 2 * padding);
    const y = padding + ((maxVal - v) / range) * (viewBoxHeight - 2 * padding);
    return `${x},${y}`;
  });

  const polylinePoints = points.join(' ');

  // منطقة التعبئة (الظل تحت الخط)
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const fillPoints = [
    firstPoint,
    ...points.slice(1),
    `${lastPoint.split(',')[0]},${viewBoxHeight - padding}`,
    `${firstPoint.split(',')[0]},${viewBoxHeight - padding}`,
  ].join(' ');

  return (
    <svg
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      className="w-full"
      aria-label="sparkline"
    >
      {/* منطقة الظل */}
      <polygon points={fillPoints} fill={color} opacity="0.1" />
      {/* الخط الرئيسي */}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* نقطة آخر قيمة */}
      {(() => {
        const lastCoord = points[points.length - 1].split(',');
        return (
          <circle
            cx={parseFloat(lastCoord[0])}
            cy={parseFloat(lastCoord[1])}
            r="3"
            fill={color}
          />
        );
      })()}
    </svg>
  );
};
