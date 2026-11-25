import {
  WORKSHEET_COLOR_LABELS,
  WORKSHEET_COLORS,
  WORKSHEET_TEMPLATES,
  type WorksheetColor,
  type WorksheetSummary,
  type WorksheetTemplateId,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { ConfirmDialog, ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input, Label } from '@/components/ui/primitives.js';

interface CreatedWorksheetResponse {
  worksheet: { id: string };
}

export function CreateWorksheetModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (worksheetId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState<WorksheetColor>('sky');
  const [template, setTemplate] = useState<WorksheetTemplateId>('standard_video');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setColor('sky');
      setTemplate('standard_video');
      setErr(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<CreatedWorksheetResponse>('/api/worksheets', {
        method: 'POST',
        body: { name, color, template },
      }),
    onSuccess: (res) => {
      onOpenChange(false);
      setName('');
      setErr(null);
      pushToast({ message: '工作表已创建', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      if (res?.worksheet?.id) {
        onCreated?.(res.worksheet.id);
      }
    },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : '创建失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    mutation.mutate();
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建工作表"
      description="选择模板可自动生成常用工序列，并按名称自动映射到同名看板列。"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {err && <Alert variant="error">{err}</Alert>}
        <div>
          <Label htmlFor="ws-new-name">工作表名称</Label>
          <Input
            id="ws-new-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：视频、歌曲翻译、杂志漫画"
            required
            maxLength={32}
            autoFocus
          />
        </div>

        <div>
          <Label>标签颜色</Label>
          <div className="flex flex-wrap gap-2">
            {WORKSHEET_COLORS.map((c) => {
              const style = WORKSHEET_COLOR_STYLES[c];
              const selected = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={WORKSHEET_COLOR_LABELS[c]}
                  aria-label={`颜色 ${WORKSHEET_COLOR_LABELS[c]}`}
                  aria-pressed={selected}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border cursor-pointer transition-transform',
                    selected
                      ? 'scale-110 border-slate-900 ring-2 ring-slate-900/20'
                      : 'border-slate-200',
                  )}
                >
                  <span className={cn('h-4 w-4 rounded-full', style.dot)} />
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label>初始列模板</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WORKSHEET_TEMPLATES.map((t) => {
              const selected = template === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplate(t.id)}
                  aria-pressed={selected}
                  className={cn(
                    'rounded-lg border p-2.5 text-left transition-colors cursor-pointer',
                    selected
                      ? 'border-sky-600 bg-sky-50/60 ring-1 ring-sky-600'
                      : 'border-slate-200 hover:border-slate-300',
                  )}
                >
                  <div className="text-sm font-medium text-slate-900">{t.name}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{t.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? '创建中…' : '创建工作表'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function EditWorksheetModal({
  worksheet,
  onClose,
}: {
  worksheet: WorksheetSummary | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState<WorksheetColor>('sky');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (worksheet) {
      setName(worksheet.name);
      setColor(worksheet.color);
      setErr(null);
    }
  }, [worksheet]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/worksheets/${worksheet?.id}`, {
        method: 'PATCH',
        body: { name, color },
      }),
    onSuccess: () => {
      const id = worksheet?.id;
      onClose();
      setErr(null);
      pushToast({ message: '工作表已更新', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      if (id) void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    mutation.mutate();
  };

  return (
    <ModalDialog
      open={Boolean(worksheet)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="编辑工作表"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {err && <Alert variant="error">{err}</Alert>}
        <div>
          <Label htmlFor="ws-edit-name">工作表名称</Label>
          <Input
            id="ws-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={32}
            autoFocus
          />
        </div>
        <div>
          <Label>标签颜色</Label>
          <div className="flex flex-wrap gap-2">
            {WORKSHEET_COLORS.map((c) => {
              const style = WORKSHEET_COLOR_STYLES[c];
              const selected = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`颜色 ${WORKSHEET_COLOR_LABELS[c]}`}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border cursor-pointer',
                    selected ? 'border-slate-900 ring-2 ring-slate-900/20' : 'border-slate-200',
                  )}
                >
                  <span className={cn('h-4 w-4 rounded-full', style.dot)} />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function DeleteWorksheetDialog({
  worksheet,
  onClose,
  onDeleted,
}: {
  worksheet: WorksheetSummary | null;
  onClose: () => void;
  onDeleted?: (deletedId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const mutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/worksheets/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, id) => {
      onClose();
      pushToast({ message: '工作表已删除', variant: 'info' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      onDeleted?.(id);
    },
    onError: (e) => {
      pushToast({
        message: e instanceof ApiError ? e.message : '删除失败',
        variant: 'error',
      });
    },
  });

  return (
    <ConfirmDialog
      open={Boolean(worksheet)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="确认删除工作表"
      message={`确定要删除工作表「${worksheet?.name ?? ''}」吗？删除后该工作表及其中任务将不再显示在导航、首页看板和检索中。`}
      pending={mutation.isPending}
      onConfirm={() => {
        if (worksheet) mutation.mutate(worksheet.id);
      }}
    />
  );
}
