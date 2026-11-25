import { Check, X } from 'lucide-react';
import {
  Dialog as RadixDialog,
  DropdownMenu as RadixDropdown,
  Popover as RadixPopover,
} from 'radix-ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button, cn } from './primitives.js';

// ---- Popover ----

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  children,
  ...props
}: RadixPopover.PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...props}
        className={cn(
          'nw-floating-surface z-[70] rounded-xl border border-slate-200/90 bg-white/98 p-3 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.16),0_4px_12px_-4px_rgba(15,23,42,0.08)] ring-1 ring-slate-950/5 backdrop-blur-md outline-none',
          className,
        )}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}

// ---- DropdownMenu ----

export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;
export const DropdownMenuGroup = RadixDropdown.Group;

export function DropdownMenuContent({
  className,
  align = 'end',
  sideOffset = 6,
  children,
  ...props
}: RadixDropdown.DropdownMenuContentProps) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...props}
        className={cn(
          'nw-floating-surface z-[70] min-w-[160px] overflow-hidden rounded-xl border border-slate-200/90 bg-white/95 p-1 text-slate-800 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.16),0_4px_12px_-4px_rgba(15,23,42,0.08)] ring-1 ring-slate-950/5 backdrop-blur-md outline-none',
          className,
        )}
      >
        {children}
      </RadixDropdown.Content>
    </RadixDropdown.Portal>
  );
}

export function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: RadixDropdown.DropdownMenuItemProps & { variant?: 'default' | 'destructive' }) {
  return (
    <RadixDropdown.Item
      {...props}
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        variant === 'destructive'
          ? 'text-red-600 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700'
          : 'text-slate-700 data-[highlighted]:bg-slate-100/90 data-[highlighted]:text-slate-950',
        className,
      )}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: RadixDropdown.DropdownMenuCheckboxItemProps) {
  return (
    <RadixDropdown.CheckboxItem
      {...props}
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg py-1.5 pr-8 pl-2.5 text-sm text-slate-700 outline-none transition-colors duration-100 data-[highlighted]:bg-slate-100/90 data-[highlighted]:text-slate-950 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <span className="pointer-events-none absolute right-2 flex h-4 w-4 items-center justify-center text-slate-900">
        <RadixDropdown.ItemIndicator>
          <Check className="h-3.5 w-3.5 stroke-[2.25]" />
        </RadixDropdown.ItemIndicator>
      </span>
    </RadixDropdown.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: RadixDropdown.DropdownMenuLabelProps) {
  return (
    <RadixDropdown.Label
      {...props}
      className={cn(
        'px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 select-none',
        className,
      )}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: RadixDropdown.DropdownMenuSeparatorProps) {
  return (
    <RadixDropdown.Separator {...props} className={cn('-mx-1 my-1 h-px bg-slate-100', className)} />
  );
}

// ---- Radix Modal Dialog ----

export function ModalDialog({
  open,
  onOpenChange,
  title,
  description,
  maxWidthClass = 'max-w-md',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  maxWidthClass?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <RadixDialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-5 shadow-xl outline-none max-h-[85vh] overflow-y-auto',
            maxWidthClass,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <RadixDialog.Title className="text-base font-semibold text-slate-900">
                {title}
              </RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-1 text-xs text-slate-500">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label="关闭"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ---- Confirm Dialog ----

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  danger = true,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ModalDialog open={open} onOpenChange={onOpenChange} title={title} maxWidthClass="max-w-sm">
      <p className="text-sm text-slate-600">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={danger ? 'danger' : 'primary'}
          disabled={pending}
          onClick={() => {
            void onConfirm();
          }}
        >
          {pending ? '处理中…' : confirmLabel}
        </Button>
      </div>
    </ModalDialog>
  );
}

// ---- Sheet / Drawer（桌面右侧滑出，手机全屏） ----

export function Sheet({
  open,
  onOpenChange,
  title,
  headerActions,
  widthClass = 'sm:w-[440px]',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  headerActions?: ReactNode;
  widthClass?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-slate-200 bg-white shadow-2xl outline-none',
            widthClass,
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <RadixDialog.Title className="truncate text-base font-semibold text-slate-900">
              {title}
            </RadixDialog.Title>
            <div className="flex shrink-0 items-center gap-1.5">
              {headerActions}
              <RadixDialog.Close
                aria-label="关闭侧栏"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </RadixDialog.Close>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ---- Toast 轻量提示系统 ----

export interface ToastOptions {
  message: string;
  variant?: 'info' | 'success' | 'error';
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<{ pushToast: (opts: ToastOptions) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback(
    (opts: ToastOptions) => {
      const id = nextIdRef.current++;
      setItems((prev) => [...prev.slice(-3), { ...opts, id }]);
      const timer = setTimeout(() => {
        dismiss(id);
      }, opts.durationMs ?? 5000);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex max-w-sm flex-col gap-2"
      >
        {items.map((item) => {
          const style =
            item.variant === 'error'
              ? 'border-red-200 bg-red-50 text-red-900'
              : item.variant === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-slate-200 bg-slate-900 text-white';
          return (
            <div
              key={item.id}
              role="status"
              className={cn(
                'pointer-events-auto flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg',
                style,
              )}
            >
              <span>{item.message}</span>
              <div className="flex shrink-0 items-center gap-2">
                {item.actionLabel && item.onAction && (
                  <button
                    type="button"
                    onClick={() => {
                      const fn = item.onAction;
                      dismiss(item.id);
                      void fn?.();
                    }}
                    className="rounded bg-white/15 px-2 py-0.5 text-xs font-semibold underline hover:bg-white/25 cursor-pointer"
                  >
                    {item.actionLabel}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => dismiss(item.id)}
                  aria-label="关闭提示"
                  className="opacity-70 hover:opacity-100 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
