/** Los controles de los paneles de ajustes. */

import type { ReactNode } from "react";

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 mt-6 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="eyebrow mb-3 p-0 text-[0.72rem] font-bold text-[var(--muted)]">{label}</legend>
      {children}
    </fieldset>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-[var(--edge)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm ${value === o.value ? "bg-[var(--ink)] text-[var(--bg)]" : "hover:bg-[var(--faint)]"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Range(props: { id: string; label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label htmlFor={props.id} className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between">
        {props.label}
        <span className="font-mono tabular-nums text-[var(--muted)]">
          {props.unit === "x" ? props.value.toFixed(2) + "x" : `${props.value}${props.unit ?? ""}`}
        </span>
      </span>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-4 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs text-[var(--muted)]">{hint}</span>}
      </span>
      <input id={id} type="checkbox" className="mt-1 size-4 accent-[var(--ink)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
