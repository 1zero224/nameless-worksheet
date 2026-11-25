import {
  type BoardColumn,
  COLUMN_TYPE_LABELS,
  COLUMN_TYPES,
  type ColumnConfig,
  type ColumnType,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { Popover, PopoverContent, PopoverTrigger, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';

export function AddColumnPopover({
  worksheetId,
  columns,
  boardColumns,
}: {
  worksheetId: string;
  columns: ColumnConfig[];
  boardColumns: BoardColumn[];
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<ColumnType>('stage');
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
      setType('stage');
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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setType('stage');
          setBoardColumnId('auto');
          setErr(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="新增列"
          title="新增列"
          data-testid="add-column-trigger"
          className="flex h-full w-full items-center justify-center text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-800 cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="text-xs font-semibold text-slate-800">新增列</div>
        {err && <Alert variant="error">{err}</Alert>}
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <div>
            <label htmlFor="inline-add-col-name" className="mb-1 block text-xs text-slate-500">
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
            <div className="mb-1 text-xs text-slate-500">列类型</div>
            <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="列类型">
              {COLUMN_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  aria-pressed={type === t}
                  className={cn(
                    'rounded-md border py-1 text-xs font-medium transition-colors cursor-pointer',
                    type === t
                      ? 'border-sky-500 bg-sky-50 text-sky-900'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {COLUMN_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {type === 'stage' && (
            <div>
              <label htmlFor="inline-add-col-board" className="mb-1 block text-xs text-slate-500">
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
