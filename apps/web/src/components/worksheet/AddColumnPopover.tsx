import {
  type BoardColumn,
  COLUMN_TYPE_LABELS,
  COLUMN_TYPES,
  type ColumnConfig,
  type ColumnType,
  type WorksheetKind,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  useToast,
} from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';

export function AddColumnPopover({
  worksheetId,
  worksheetKind = 'task',
  columns,
  boardColumns,
  controlledOpen,
  onControlledOpenChange,
  anchorRect,
}: {
  worksheetId: string;
  worksheetKind?: WorksheetKind;
  columns: ColumnConfig[];
  boardColumns: BoardColumn[];
  controlledOpen?: boolean;
  onControlledOpenChange?: (open: boolean) => void;
  anchorRect?: { x: number; y: number; width: number; height: number } | null;
}) {
  const isFree = worksheetKind === 'free';
  const availableTypes = isFree ? COLUMN_TYPES.filter((t) => t !== 'stage') : COLUMN_TYPES;
  const defaultType: ColumnType = isFree ? 'text' : 'stage';
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = (next: boolean) => {
    if (next) {
      setName('');
      setType(defaultType);
      setBoardColumnId('auto');
      setErr(null);
    }
    if (isControlled) {
      onControlledOpenChange?.(next);
    } else {
      setInternalOpen(next);
    }
  };

  const [name, setName] = useState('');
  const [type, setType] = useState<ColumnType>(defaultType);
  const [boardColumnId, setBoardColumnId] = useState<string>('auto');
  const [err, setErr] = useState<string | null>(null);

  const usedBoardIds = new Set(
    columns.map((c) => c.boardColumnId).filter((id): id is string => id !== null),
  );

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        type,
      };
      if (type === 'stage' && boardColumnId !== 'auto') {
        payload.boardColumnId = boardColumnId === 'none' ? null : boardColumnId;
      }
      return apiFetch<ColumnConfig>(`/api/worksheets/${worksheetId}/columns`, {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: () => {
      setName('');
      setType(defaultType);
      setBoardColumnId('auto');
      setErr(null);
      setOpen(false);
      pushToast({ message: '已新增列', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(worksheetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : '新增列失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setErr(null);
    mutation.mutate();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {isControlled ? (
        anchorRect && (
          <PopoverAnchor asChild>
            <div
              className="pointer-events-none absolute"
              style={{
                left: anchorRect.x,
                top: anchorRect.y,
                width: anchorRect.width,
                height: anchorRect.height,
              }}
            />
          </PopoverAnchor>
        )
      ) : (
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="新增列"
            title="新增列"
            data-testid="add-column-trigger"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-black/[0.1] bg-white px-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span className="hidden sm:inline">新增列</span>
          </button>
        </PopoverTrigger>
      )}

      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="text-xs font-semibold text-zinc-900">新增列</div>
        {err && <Alert variant="error">{err}</Alert>}
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <div>
            <label htmlFor="inline-add-col-name" className="mb-1 block text-xs text-zinc-500">
              列名
            </label>
            <Input
              id="inline-add-col-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：压制、片源链接"
              className="h-8 text-xs"
              maxLength={32}
              autoFocus
            />
          </div>

          <div>
            <div className="mb-1 text-xs text-zinc-500">列类型</div>
            <div
              className={cn('grid gap-1', isFree ? 'grid-cols-3' : 'grid-cols-4')}
              role="radiogroup"
              aria-label="列类型"
            >
              {availableTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  aria-pressed={type === t}
                  className={cn(
                    'rounded-md border py-1 text-xs font-medium transition-colors cursor-pointer',
                    type === t
                      ? 'border-zinc-900 bg-zinc-900 text-white'
                      : 'border-black/[0.1] bg-white text-zinc-600 hover:bg-black/[0.04]',
                  )}
                >
                  {COLUMN_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {type === 'stage' && (
            <div>
              <label htmlFor="inline-add-col-board" className="mb-1 block text-xs text-zinc-500">
                对应看板列
              </label>
              <SelectField
                id="inline-add-col-board"
                aria-label="对应看板列"
                size="xs"
                value={boardColumnId}
                onValueChange={setBoardColumnId}
                options={[
                  { value: 'auto', label: '按同名自动匹配' },
                  { value: 'none', label: '不上看板' },
                  ...boardColumns.map((bc) => ({
                    value: bc.id,
                    label: `${bc.name}${usedBoardIds.has(bc.id) ? '（已占用）' : ''}`,
                    disabled: usedBoardIds.has(bc.id),
                  })),
                ]}
              />
            </div>
          )}

          <div className="flex justify-end gap-1.5 pt-1">
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? '添加中…' : '添加列'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
