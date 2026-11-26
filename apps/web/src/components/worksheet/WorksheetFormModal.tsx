import {
  WORKSHEET_TEMPLATES,
  type WorksheetPlacement,
  type WorksheetSummary,
  type WorksheetTemplateId,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { ConfirmDialog, ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input, Label } from '@/components/ui/primitives.js';

interface CreatedWorksheetResponse {
  worksheet: { id: string };
}

export function CreateWorksheetModal({
  open,
  onOpenChange,
  onCreated,
  placement = 'topbar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (worksheetId: string) => void;
  placement?: WorksheetPlacement;
}) {
  const isDocsPlacement = placement === 'docs';
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<WorksheetTemplateId>(
    isDocsPlacement ? 'free_blank' : 'standard_video',
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setTemplate(isDocsPlacement ? 'free_blank' : 'standard_video');
      setErr(null);
    }
  }, [open, isDocsPlacement]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<CreatedWorksheetResponse>('/api/worksheets', {
        method: 'POST',
        body: {
          name,
          color: 'slate',
          template: isDocsPlacement ? 'free_blank' : template,
          placement,
        },
      }),
    onSuccess: (res) => {
      onOpenChange(false);
      setName('');
      setErr(null);
      pushToast({
        message: isDocsPlacement ? '通用文档在线表格已创建' : '工作表已创建',
        variant: 'success',
      });
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

  const selectedTemplateDef = WORKSHEET_TEMPLATES.find((t) => t.id === template);

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isDocsPlacement ? '新建通用文档在线表格' : '新建工作表'}
      description={
        isDocsPlacement
          ? '创建空白自由表格，显示在「通用文档」顶部标签栏，全员实时协同编辑，不上首页任务看板。'
          : '选择制作模板可自动生成常用工序列，或选择「自由表格」创建类 Excel 空白文档。'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {err && <Alert variant="error">{err}</Alert>}
        <div>
          <Label htmlFor="ws-new-name">{isDocsPlacement ? '表格名称' : '工作表名称'}</Label>
          <Input
            id="ws-new-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              isDocsPlacement
                ? '例如：术语翻译对照表、风格规范表'
                : '例如：视频、歌曲翻译、相关收益'
            }
            required
            maxLength={32}
            autoFocus
          />
        </div>

        {!isDocsPlacement && (
          <div>
            <Label>初始列模板</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {WORKSHEET_TEMPLATES.map((t) => {
                const selected = template === t.id;
                const isFree = t.id === 'free_blank';
                return (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`worksheet-template-${t.id}`}
                    onClick={() => setTemplate(t.id)}
                    aria-pressed={selected}
                    className={cn(
                      'rounded-lg border p-2.5 text-left transition-colors cursor-pointer',
                      isFree && 'sm:col-span-2',
                      selected
                        ? 'border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900'
                        : 'border-black/[0.1] hover:border-black/[0.2]',
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                      <span>{t.name}</span>
                      {isFree && (
                        <span className="rounded bg-zinc-200/80 px-1.5 py-0 text-[10px] font-medium text-zinc-700">
                          不上看板
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">{t.description}</div>
                  </button>
                );
              })}
            </div>
            {selectedTemplateDef?.kind === 'free' && (
              <p className="mt-2 rounded-md border border-black/[0.08] bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
                类似 Excel
                空白表，不含优先级、发布状态与工序，不上首页任务看板，所有列均可自由增删改名。
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? '创建中…' : isDocsPlacement ? '创建表格' : '创建工作表'}
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
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (worksheet) {
      setName(worksheet.name);
      setErr(null);
    }
  }, [worksheet]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/worksheets/${worksheet?.id}`, {
        method: 'PATCH',
        body: { name },
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
      title="重命名工作表"
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
