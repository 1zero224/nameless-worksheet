import { Check, X } from 'lucide-react';
import {
  Dialog as RadixDialog,
  DropdownMenu as RadixDropdown,
  Popover as RadixPopover,
} from 'radix-ui';
import { createContext, type ReactNode, useCallback, useContext } from 'react';
import { Toaster, toast } from 'sonner';
import { Button, cn } from './primitives.js';

// ---- Popover ----

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;

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
          'z-[70] rounded-xl border border-black/[0.08] bg-white p-3 text-zinc-900 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.14),0_2px_8px_-2px_rgba(0,0,0,0.06)] outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 duration-150',
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
          'z-[70] min-w-[160px] overflow-hidden rounded-xl border border-black/[0.08] bg-white p-1 text-zinc-800 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.14),0_2px_8px_-2px_rgba(0,0,0,0.06)] outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 duration-150',
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
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none transition-colors duration-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        variant === 'destructive'
          ? 'text-red-600 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700'
          : 'text-zinc-700 data-[highlighted]:bg-black/[0.04] data-[highlighted]:text-zinc-950',
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
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg py-1.5 pr-8 pl-2.5 text-[13px] text-zinc-700 outline-none transition-colors duration-100 data-[highlighted]:bg-black/[0.04] data-[highlighted]:text-zinc-950 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <span className="pointer-events-none absolute right-2 flex h-4 w-4 items-center justify-center text-zinc-900">
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
        'px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-zinc-400 select-none',
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
    <RadixDropdown.Separator
      {...props}
      className={cn('-mx-1 my-1 h-px bg-black/[0.06]', className)}
    />
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
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/35 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-150" />
        <RadixDialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-black/[0.08] bg-white p-5 shadow-xl outline-none max-h-[85vh] overflow-y-auto',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-150',
            maxWidthClass,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <RadixDialog.Title className="text-base font-semibold text-zinc-950">
                {title}
              </RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-1 text-xs text-zinc-500">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label="关闭"
              className="rounded-md p-1 text-zinc-400 hover:bg-black/[0.04] hover:text-zinc-700 cursor-pointer"
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
      <p className="text-sm text-zinc-600">{message}</p>
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
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/25 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-150" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-black/[0.08] bg-white shadow-2xl outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right duration-200',
            widthClass,
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-black/[0.08] px-4 py-3">
            <RadixDialog.Title className="truncate text-[15px] font-semibold text-zinc-950">
              {title}
            </RadixDialog.Title>
            <div className="flex shrink-0 items-center gap-1.5">
              {headerActions}
              <RadixDialog.Close
                aria-label="关闭侧栏"
                className="rounded-md p-1 text-zinc-400 hover:bg-black/[0.04] hover:text-zinc-700 cursor-pointer"
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

// ---- Toast 提示系统（基于 sonner，保留原 useToast 契约与软删除一键撤销） ----

export interface ToastOptions {
  message: string;
  variant?: 'info' | 'success' | 'error';
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  durationMs?: number;
}

const ToastContext = createContext<{ pushToast: (opts: ToastOptions) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const pushToast = useCallback((opts: ToastOptions) => {
    const common = {
      duration: opts.durationMs ?? 5000,
      action:
        opts.actionLabel && opts.onAction
          ? {
              label: opts.actionLabel,
              onClick: () => {
                void opts.onAction?.();
              },
            }
          : undefined,
    };

    if (opts.variant === 'error') {
      toast.error(opts.message, common);
    } else if (opts.variant === 'success') {
      toast.success(opts.message, common);
    } else {
      toast(opts.message, common);
    }
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <Toaster
        position="bottom-right"
        closeButton
        toastOptions={{
          classNames: {
            toast:
              'rounded-xl border border-black/[0.08] bg-white text-zinc-900 shadow-[0_8px_24px_-6px_rgba(0,0,0,0.12)] text-[13px]',
            actionButton:
              '!bg-zinc-900 !text-white !rounded-md !px-2.5 !py-1 !text-xs !font-medium hover:!bg-zinc-800',
          },
        }}
      />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
