import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TempHistory } from "../types";
import { fmtDay, fmtDayTime, fmtTime } from "../format";

interface Props {
  history: TempHistory;
  /** When the newest reading was taken (the scan time). */
  endMs: number;
}

const M = { l: 34, r: 50, t: 10, b: 22 };

export function TempChart({ history, endMs }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vals = history.values;
  const n = vals.length;
  const valid = useMemo(() => vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0), [vals]);
  if (valid.length === 0) return <div className="chart-empty">No temperature readings yet.</div>;

  const nums = valid.map((i) => vals[i] as number);
  const lo = Math.floor((Math.min(...nums) - 3) / 5) * 5;
  let hi = Math.ceil((Math.max(...nums) + 3) / 5) * 5;
  if (hi - lo < 15) hi = lo + 15;
  const iw = Math.max(10, size.w - M.l - M.r);
  const ih = Math.max(10, size.h - M.t - M.b);
  const x = (i: number) => M.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * ih;
  const stepMs = history.intervalMinutes * 60_000;
  const timeAt = (i: number) => endMs - (n - 1 - i) * stepMs;

  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  const last = valid[valid.length - 1];
  const isolated = valid.filter((i) => i !== last && vals[i - 1] == null && vals[i + 1] == null);

  // Time ticks: the smallest round step (in local time) that leaves room for each label.
  // Drives log every 1 to 30+ minutes, so the span ranges from ~2 hours to several days.
  const spanMs = Math.max(1, (n - 1) * stepMs);
  const multiDay = spanMs > 20 * 3_600_000;
  const DAY = 86_400_000;
  // Approximate label widths: "24 Nov" (daily ticks), "24 Nov, 18:00", "18:00".
  const labelWidth = (step: number) => (step >= DAY ? 64 : multiDay ? 120 : 80);
  const STEPS = [30, 60, 120, 180, 360, 720, 1440, 2880].map((m) => m * 60_000);
  const tickEvery = STEPS.find((st) => spanMs / st <= Math.max(2, Math.floor(iw / labelWidth(st)))) ?? STEPS[STEPS.length - 1];
  const tzOffset = -new Date(endMs).getTimezoneOffset() * 60_000;
  const bucket = (ms: number) => Math.floor((ms + tzOffset) / tickEvery);
  // Each tick sits exactly on a round local time (e.g. midnight), between the two readings around it.
  const ticks: { x: number; ms: number }[] = [];
  for (let i = 1; i < n; i++) {
    const b = bucket(timeAt(i));
    if (b !== bucket(timeAt(i - 1))) {
      const ms = b * tickEvery - tzOffset;
      const frac = (ms - timeAt(i - 1)) / stepMs;
      ticks.push({ x: x(i - 1) + frac * (x(i) - x(i - 1)), ms });
    }
  }
  const label = (ms: number) => (multiDay ? fmtDayTime(ms) : fmtTime(ms));
  const tickLabel = (ms: number) => (tickEvery >= DAY ? fmtDay(ms) : label(ms));
  const yTicks: number[] = [];
  for (let v = lo; v <= hi; v += 5) yTicks.push(v);

  const nearest = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const raw = ((clientX - rect.left - M.l) / iw) * (n - 1);
    let best = valid[0];
    for (const i of valid) if (Math.abs(i - raw) < Math.abs(best - raw)) best = i;
    return best;
  };
  const onKey = (e: React.KeyboardEvent) => {
    const k = valid.indexOf(hover ?? last);
    if (e.key === "ArrowLeft" && k > 0) setHover(valid[k - 1]);
    else if (e.key === "ArrowRight" && k < valid.length - 1) setHover(valid[k + 1]);
    else if (e.key === "Home") setHover(valid[0]);
    else if (e.key === "End") setHover(last);
    else return;
    e.preventDefault();
  };

  const hx = hover != null ? x(hover) : 0;
  const hy = hover != null ? y(vals[hover] as number) : 0;
  const tipLeft = hx + 12 + 120 > size.w ? hx - 12 - 110 : hx + 12;

  return (
    <div
      className="chart"
      ref={ref}
      tabIndex={0}
      role="img"
      aria-label={`Temperature history: ${Math.min(...nums)} to ${Math.max(...nums)} °C, latest ${vals[last]} °C. Use arrow keys to read values.`}
      onPointerMove={(e) => setHover(nearest(e.clientX))}
      onPointerLeave={() => setHover(null)}
      onFocus={() => setHover(last)}
      onBlur={() => setHover(null)}
      onKeyDown={onKey}
    >
      {size.w > 0 && (
        <svg width={size.w} height={size.h}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={M.l + iw} y1={y(v)} y2={y(v)} className={v === lo ? "axis" : "gridline"} />
              <text x={M.l - 7} y={y(v)} dy="0.32em" textAnchor="end" className="tick">
                {v}°
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <text key={t.ms} x={t.x} y={size.h - 5} textAnchor="middle" className="tick">
              {tickLabel(t.ms)}
            </text>
          ))}
          <path d={d} className="series-line" />
          {isolated.map((i) => (
            <circle key={i} cx={x(i)} cy={y(vals[i] as number)} r={2.3} className="series-dot" />
          ))}
          <circle cx={x(last)} cy={y(vals[last] as number)} r={4} className="series-end" />
          <text x={x(last) + 9} y={y(vals[last] as number)} dy="0.32em" className="end-label">
            {vals[last]} °C
          </text>
          {hover != null && (
            <>
              <line x1={hx} x2={hx} y1={M.t} y2={M.t + ih} className="crosshair" />
              <circle cx={hx} cy={hy} r={5} className="series-end" />
            </>
          )}
        </svg>
      )}
      {hover != null && (
        <div className="tip" style={{ left: Math.max(0, tipLeft), top: Math.max(0, hy - 46) }}>
          <div className="t">{label(timeAt(hover))} (approx.)</div>
          <div className="v">{vals[hover]} °C</div>
        </div>
      )}
    </div>
  );
}
