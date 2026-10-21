"use client";

import { useEffect, useState } from "react";

function getPrefersReducedMotion(): boolean {
  if (typeof window !== "undefined") {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return false;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(getPrefersReducedMotion);
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);
  return prefersReduced;
}

const pulseAnimation = "animate-[pulse_2s_ease-in-out_infinite]";
const pulseClass = "bg-border/50";

function SkeletonBase({ className = "", style, "aria-hidden": ariaHidden = "true", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const prefersReduced = usePrefersReducedMotion();
  return (
    <div
      className={`rounded-control ${pulseClass} ${prefersReduced ? "" : pulseAnimation} ${className}`}
      style={style}
      aria-hidden={ariaHidden}
      {...props}
    />
  );
}

export function SkeletonBlock({ className = "", style, width, height, minHeight, ...props }: React.HTMLAttributes<HTMLDivElement> & { width?: string | number; height?: string | number; minHeight?: string | number }) {
  return (
    <SkeletonBase
      className={className}
      style={{
        ...style,
        width: width ?? "100%",
        height: height ?? undefined,
        minHeight: minHeight ?? undefined,
      }}
      {...props}
    />
  );
}

export function SkeletonText({ className = "", lines = 1, width = "100%", ...props }: React.HTMLAttributes<HTMLDivElement> & { lines?: number; width?: string | number }) {
  return (
    <div className={className} style={{ width }} aria-hidden="true" {...props}>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonBlock key={i} height={16} style={{ marginTop: i > 0 ? 8 : 0, width: i === lines - 1 ? "70%" : "100%" }} />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <SkeletonBase className={`rounded-panel border border-border bg-bg-surface p-4 ${className}`} style={{ minHeight: 120 }} {...props} />
  );
}

export function SkeletonTableRow({ columns = 6, className = "", ...props }: React.HTMLAttributes<HTMLDivElement> & { columns?: number }) {
  return (
    <div className={`flex gap-3 ${className}`} aria-hidden="true" {...props}>
      {Array.from({ length: columns }, (_, i) => (
        <SkeletonBlock key={i} width={i === 0 ? 40 : i === 1 ? 60 : "auto"} height={20} style={{ flex: i >= 2 ? 1 : 0 }} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 6, className = "", ...props }: React.HTMLAttributes<HTMLDivElement> & { rows?: number; columns?: number }) {
  return (
    <div className={className} aria-hidden="true" {...props}>
      <div className="flex gap-3 border-b border-border pb-3 mb-3">
        {Array.from({ length: columns }, (_, i) => (
          <SkeletonBlock key={i} width={i === 0 ? 40 : i === 1 ? 60 : "auto"} height={16} style={{ flex: i >= 2 ? 1 : 0 }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <SkeletonTableRow key={row} columns={columns} style={{ marginTop: row > 0 ? 12 : 0 }} />
      ))}
    </div>
  );
}

export function SkeletonChart({ className = "", height = 320, ...props }: React.HTMLAttributes<HTMLDivElement> & { height?: number }) {
  return (
    <SkeletonBase className={`rounded-control border border-border bg-bg-base p-4 ${className}`} style={{ height }} {...props} />
  );
}

export function SkeletonKPI({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <SkeletonBase className={`rounded-panel border border-border bg-bg-surface p-4 ${className}`} style={{ minHeight: 80 }} {...props} />
  );
}

export function SkeletonDetail({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`space-y-4 ${className}`} aria-hidden="true" {...props}>
      <SkeletonBlock width={200} height={24} />
      <SkeletonBlock width={300} height={16} />
      <SkeletonBlock width="100%" height={16} />
      <SkeletonBlock width="100%" height={16} />
    </div>
  );
}

export function SkeletonGrid({ items = 4, itemClassName = "", className = "", ...props }: React.HTMLAttributes<HTMLDivElement> & { items?: number; itemClassName?: string }) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 xl:grid-cols-4 ${className}`} aria-hidden="true" {...props}>
      {Array.from({ length: items }, (_, i) => (
        <SkeletonBase key={i} className={`rounded-panel border border-border bg-bg-surface ${itemClassName}`} style={{ minHeight: 100 }} />
      ))}
    </div>
  );
}

export function SkeletonList({ items = 5, className = "", itemHeight = 80, ...props }: React.HTMLAttributes<HTMLDivElement> & { items?: number; itemHeight?: number }) {
  return (
    <div className={`space-y-3 ${className}`} aria-hidden="true" {...props}>
      {Array.from({ length: items }, (_, i) => (
        <SkeletonCard key={i} style={{ minHeight: itemHeight }} />
      ))}
    </div>
  );
}