import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
}) {
  const variants = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400',
    secondary:
      'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:opacity-50',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 disabled:opacity-50',
  };
  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
  };
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors cursor-pointer disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:bg-slate-100',
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:bg-slate-100',
        className,
      )}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 通用 Label 组件由调用方传入 htmlFor
    <label {...props} className={cn('block text-sm font-medium text-slate-700 mb-1', className)} />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-slate-200 bg-white p-5 shadow-xs', className)}>
      {children}
    </div>
  );
}

export function Badge({
  variant = 'default',
  children,
}: {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'muted';
  children: ReactNode;
}) {
  const styles = {
    default: 'bg-slate-100 text-slate-800',
    success: 'bg-emerald-100 text-emerald-800',
    warning: 'bg-amber-100 text-amber-800',
    danger: 'bg-red-100 text-red-800',
    muted: 'bg-slate-100 text-slate-500',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        styles[variant],
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  variant = 'error',
  children,
}: {
  variant?: 'error' | 'success' | 'info' | 'warning';
  children: ReactNode;
}) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return (
    <div className={cn('rounded-md border px-3.5 py-2.5 text-sm', styles[variant])}>{children}</div>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
