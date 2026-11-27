import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as RadixSelect } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './primitives.js';

// Radix Select 禁止 SelectItem 使用空字符串 value，这里统一用内部哨兵值双向转换
const EMPTY_VALUE = '__nw_select_empty__';

function toRadixValue(value: string): string {
  return value === '' ? EMPTY_VALUE : value;
}

function fromRadixValue(value: string): string {
  return value === EMPTY_VALUE ? '' : value;
}

// ---- 低阶 Radix Select 组合原语 ----

export const SelectRoot = RadixSelect.Root;
export const SelectGroup = RadixSelect.Group;
export const SelectValue = RadixSelect.Value;

export function SelectTrigger({ className, children, ...props }: RadixSelect.SelectTriggerProps) {
  return (
    <RadixSelect.Trigger
      {...props}
      className={cn(
        'group inline-flex w-full cursor-pointer items-center justify-between gap-2 rounded-[3px] border border-slate-200/90 bg-white px-3 text-left text-sm text-slate-800 transition-all duration-150',
        'hover:border-slate-300 hover:bg-slate-50/70',
        'focus-visible:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10',
        'data-[state=open]:border-slate-400 data-[state=open]:bg-white data-[state=open]:ring-2 data-[state=open]:ring-slate-900/10',
        'data-[placeholder]:text-slate-400',
        'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 disabled:opacity-60',
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      <RadixSelect.Icon asChild>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150 group-hover:text-slate-600 group-data-[state=open]:rotate-180 group-data-[state=open]:text-slate-700" />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = 6,
  align = 'start',
  ...props
}: RadixSelect.SelectContentProps) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        position={position}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...props}
        className={cn(
          'relative z-[70] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[4px] border border-black/[0.08] bg-white text-zinc-800 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.14),0_2px_8px_-2px_rgba(0,0,0,0.06)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-150',
          className,
        )}
      >
        <RadixSelect.ScrollUpButton className="flex h-6 cursor-default items-center justify-center bg-gradient-to-b from-white to-white/80 text-slate-400">
          <ChevronUp className="h-3.5 w-3.5" />
        </RadixSelect.ScrollUpButton>
        <RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>
        <RadixSelect.ScrollDownButton className="flex h-6 cursor-default items-center justify-center bg-gradient-to-t from-white to-white/80 text-slate-400">
          <ChevronDown className="h-3.5 w-3.5" />
        </RadixSelect.ScrollDownButton>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

export function SelectLabel({ className, ...props }: RadixSelect.SelectLabelProps) {
  return (
    <RadixSelect.Label
      {...props}
      className={cn(
        'px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 select-none',
        className,
      )}
    />
  );
}

export function SelectSeparator({ className, ...props }: RadixSelect.SelectSeparatorProps) {
  return (
    <RadixSelect.Separator {...props} className={cn('-mx-1 my-1 h-px bg-slate-100', className)} />
  );
}

export function SelectItem({ className, children, ...props }: RadixSelect.SelectItemProps) {
  return (
    <RadixSelect.Item
      {...props}
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center rounded-[2px] py-1.5 pr-8 pl-2.5 text-sm text-slate-700 outline-none transition-colors duration-100',
        'data-[highlighted]:bg-slate-100/90 data-[highlighted]:text-slate-950',
        'data-[state=checked]:font-medium data-[state=checked]:text-slate-950',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
    >
      <RadixSelect.ItemText asChild>
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      </RadixSelect.ItemText>
      <span className="pointer-events-none absolute right-2 flex h-4 w-4 items-center justify-center text-slate-900">
        <RadixSelect.ItemIndicator>
          <Check className="h-3.5 w-3.5 stroke-[2.25]" />
        </RadixSelect.ItemIndicator>
      </span>
    </RadixSelect.Item>
  );
}

// ---- 高阶通用选择器组件 ----

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  dotClass?: string;
  group?: string;
}

export interface SelectFieldProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  size?: 'xs' | 'sm' | 'md';
  variant?: 'default' | 'pill' | 'ghost';
  leadingIcon?: ReactNode;
  className?: string;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
}

export function SelectField({
  id,
  value,
  onValueChange,
  open,
  onOpenChange,
  options,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
  size = 'md',
  variant = 'default',
  leadingIcon,
  className,
  contentClassName,
  align = 'start',
}: SelectFieldProps) {
  const selectedOption = options.find((opt) => opt.value === value);

  const sizeClass =
    variant === 'pill'
      ? size === 'xs'
        ? 'h-6 rounded-[3px] px-2 text-xs font-medium gap-1.5'
        : 'h-7 rounded-[3px] px-2.5 text-xs font-medium gap-1.5'
      : variant === 'ghost'
        ? size === 'xs'
          ? 'h-7 rounded-[2px] px-1.5 text-xs gap-1'
          : size === 'sm'
            ? 'h-8 rounded-[2px] px-2 text-xs gap-1.5'
            : 'h-9 rounded-[2px] px-2.5 text-sm gap-1.5'
        : size === 'xs'
          ? 'h-7 rounded-[3px] px-2.5 text-xs'
          : size === 'sm'
            ? 'h-8 rounded-[3px] px-2.5 text-xs'
            : 'h-9 rounded-[3px] px-3 text-sm';

  // 按 group 保序分组渲染（未设 group 的直接顺序输出）
  const hasGroups = options.some((opt) => Boolean(opt.group));
  const groupedBlocks: Array<{ group: string | null; items: SelectOption[] }> = [];
  if (hasGroups) {
    for (const opt of options) {
      const g = opt.group ?? null;
      const last = groupedBlocks[groupedBlocks.length - 1];
      if (last && last.group === g) {
        last.items.push(opt);
      } else {
        groupedBlocks.push({ group: g, items: [opt] });
      }
    }
  }

  return (
    <RadixSelect.Root
      open={open}
      onOpenChange={onOpenChange}
      value={toRadixValue(value)}
      onValueChange={(next) => onValueChange(fromRadixValue(next))}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'group inline-flex cursor-pointer items-center justify-between gap-1.5 border text-left transition-all duration-150 outline-none',
          variant === 'pill'
            ? 'w-auto border-transparent hover:brightness-95 focus-visible:ring-2 focus-visible:ring-zinc-900/15 data-[state=open]:ring-2 data-[state=open]:ring-zinc-900/15 disabled:cursor-not-allowed disabled:opacity-60'
            : variant === 'ghost'
              ? cn(
                  'w-auto border-transparent bg-transparent hover:bg-black/[0.04] hover:text-zinc-950 focus-visible:bg-black/[0.04] data-[state=open]:bg-black/[0.05] data-[state=open]:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-60',
                  value ? 'font-medium text-zinc-950' : 'text-zinc-600',
                )
              : cn(
                  !(className && /\bw-/.test(className)) && 'w-full',
                  'border-black/[0.1] bg-white text-zinc-800 hover:border-black/[0.18] hover:bg-black/[0.02] focus-visible:border-zinc-400 focus-visible:ring-2 focus-visible:ring-zinc-900/10 data-[state=open]:border-zinc-400 data-[state=open]:bg-white data-[state=open]:ring-2 data-[state=open]:ring-zinc-900/10 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 disabled:opacity-60',
                ),
          sizeClass,
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {leadingIcon && <span className="shrink-0 text-slate-400">{leadingIcon}</span>}
          {selectedOption?.dotClass && (
            <span className={cn('h-2 w-2 shrink-0 rounded-full', selectedOption.dotClass)} />
          )}
          <span className="truncate">
            <RadixSelect.Value placeholder={placeholder}>{selectedOption?.label}</RadixSelect.Value>
          </span>
        </span>
        <RadixSelect.Icon asChild>
          <ChevronDown
            className={cn(
              'shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180',
              variant === 'pill'
                ? 'h-3 w-3 opacity-65 group-hover:opacity-100'
                : 'h-3.5 w-3.5 text-slate-400 group-hover:text-slate-600 group-data-[state=open]:text-slate-700',
            )}
          />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <SelectContent align={align} className={contentClassName}>
        {hasGroups
          ? groupedBlocks.map((block, idx) => (
              <RadixSelect.Group key={block.group ?? `ungrouped-${idx}`}>
                {idx > 0 && <SelectSeparator />}
                {block.group && <SelectLabel>{block.group}</SelectLabel>}
                {block.items.map((opt) => (
                  <SelectItem
                    key={opt.value || EMPTY_VALUE}
                    value={toRadixValue(opt.value)}
                    disabled={opt.disabled}
                    className={size === 'xs' || size === 'sm' ? 'py-1.5 text-xs' : undefined}
                  >
                    {opt.dotClass && (
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', opt.dotClass)} />
                    )}
                    <span className="truncate">{opt.label}</span>
                  </SelectItem>
                ))}
              </RadixSelect.Group>
            ))
          : options.map((opt) => (
              <SelectItem
                key={opt.value || EMPTY_VALUE}
                value={toRadixValue(opt.value)}
                disabled={opt.disabled}
                className={size === 'xs' || size === 'sm' ? 'py-1.5 text-xs' : undefined}
              >
                {opt.dotClass && (
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', opt.dotClass)} />
                )}
                <span className="truncate">{opt.label}</span>
              </SelectItem>
            ))}
      </SelectContent>
    </RadixSelect.Root>
  );
}
