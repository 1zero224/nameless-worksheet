import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
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
    primary: 'bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-300',
    secondary:
      'bg-white text-zinc-900 border border-black/[0.12] hover:bg-black/[0.04] disabled:opacity-50',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    ghost:
      'bg-transparent text-zinc-700 hover:bg-black/[0.04] hover:text-zinc-950 disabled:opacity-50',
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

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        {...props}
        className={cn(
          'block w-full rounded-md border border-black/[0.12] bg-white px-3 py-2 text-sm text-zinc-950 shadow-[0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900/20 disabled:bg-zinc-50',
          className,
        )}
      />
    );
  },
);

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 通用 Label 组件由调用方传入 htmlFor
    <label {...props} className={cn('block text-sm font-medium text-zinc-700 mb-1', className)} />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-black/[0.08] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]',
        className,
      )}
    >
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
    default: 'bg-zinc-100 text-zinc-800',
    success: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-800',
    danger: 'bg-red-50 text-red-700',
    muted: 'bg-zinc-100 text-zinc-500',
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
    error: 'border-red-200/90 bg-red-50/80 text-red-800',
    success: 'border-emerald-200/90 bg-emerald-50/80 text-emerald-800',
    info: 'border-blue-200/90 bg-blue-50/80 text-blue-800',
    warning: 'border-amber-200/90 bg-amber-50/80 text-amber-900',
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-xl border border-black/[0.08] bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-zinc-950">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-black/[0.04] hover:text-zinc-700 cursor-pointer"
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
