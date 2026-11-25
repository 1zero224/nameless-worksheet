import type { Work } from '@nw/shared';
import { useMutation } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { Popover, PopoverContent, PopoverTrigger, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, Input } from '@/components/ui/primitives.js';

export function CreateWorkPopover({
  worksheetId,
  onCreated,
}: {
  worksheetId: string;
  onCreated: (work: Work) => void;
}) {
  const { pushToast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const isComposingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: (workName: string) =>
      apiFetch<Work>(`/api/worksheets/${worksheetId}/works`, {
        method: 'POST',
        body: { name: workName },
      }),
    onSuccess: (created) => {
      setName('');
      setErr(null);
      setOpen(false);
      pushToast({ message: `已创建作品「${created.name}」`, variant: 'success' });
      onCreated(created);
    },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : '创建作品失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isComposingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setErr(null);
    mutation.mutate(trimmed);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setErr(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="create-work-trigger"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-800 cursor-pointer"
        >
          <FolderPlus className="h-3.5 w-3.5 text-indigo-500" />
          <span>新建作品</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 space-y-2.5 p-3">
        <div>
          <div className="text-xs font-semibold text-slate-800">新建作品大标题</div>
          <p className="mt-0.5 text-[11px] text-slate-400">
            创建后将在表中渲染作品大标题横幅，并自动聚焦首条分段输入。
          </p>
        </div>
        {err && <Alert variant="error">{err}</Alert>}
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            placeholder="例如：无刺有刺 2nd 专场演唱会"
            aria-label="新作品名称"
            className="h-8 text-xs"
            maxLength={80}
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? '创建中…' : '创建作品'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
