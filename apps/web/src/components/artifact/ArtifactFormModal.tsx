import {
  type ArtifactDetail,
  type ArtifactScope,
  type ArtifactScopeKind,
  CLOUD_PROVIDER_LABELS,
  CLOUD_PROVIDERS,
  type CloudProvider,
  detectCloudProvider,
  type ParsedShareText,
  type WorksheetFullResponse,
  type WorksheetSummary,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { SharePasteInput } from '@/components/artifact/SharePasteInput.js';
import { invalidateArtifactQueries, type ScopeTagItem } from '@/components/artifact/utils.js';
import { ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input, Label } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';

const SCOPE_TAG_STYLES: Record<ScopeTagItem['kind'], string> = {
  doc: 'bg-sky-50 text-sky-700 ring-sky-200/90',
  worksheet: 'bg-sky-50 text-sky-700 ring-sky-200/90',
  work: 'bg-indigo-50 text-indigo-700 ring-indigo-200/90',
  task: 'bg-emerald-50 text-emerald-700 ring-emerald-200/90',
  stage: 'bg-amber-50 text-amber-800 ring-amber-200/90',
};

export function CreateArtifactModal({
  open,
  onOpenChange,
  scope,
  scopeLabel,
  scopeTags,
  defaultName = '',
  worksheetId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: ArtifactScope;
  scopeLabel: string;
  scopeTags?: ScopeTagItem[];
  defaultName?: string;
  worksheetId?: string | null;
  onSuccess?: (artifact: ArtifactDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [name, setName] = useState(defaultName);
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('other');
  const [providerTouched, setProviderTouched] = useState(false);
  const [extractCode, setExtractCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setUrl('');
      setProvider('other');
      setProviderTouched(false);
      setExtractCode('');
      setNote('');
      setError(null);
    }
  }, [open, defaultName]);

  const handleParsed = (parsed: ParsedShareText) => {
    if (parsed.url) {
      setUrl(parsed.url);
      if (parsed.provider) {
        setProvider(parsed.provider);
        setProviderTouched(false);
      }
    }
    if (parsed.extractCode !== null) {
      setExtractCode(parsed.extractCode);
    }
    if (parsed.suggestedName && !name.trim()) {
      setName(parsed.suggestedName);
    }
  };

  const mutation = useMutation({
    mutationFn: () => {
      const trimmedUrl = url.trim();
      const trimmedNote = note.trim();
      const body: Record<string, unknown> = {
        scope,
        name: name.trim(),
        ...(!trimmedUrl && trimmedNote ? { versionNote: trimmedNote } : {}),
      };
      if (trimmedUrl) {
        body.location = {
          provider,
          url: trimmedUrl,
          extractCode: extractCode.trim() || null,
          isFolder: false,
          note: trimmedNote,
        };
      }
      return apiFetch<ArtifactDetail>('/api/artifacts', {
        method: 'POST',
        body,
      });
    },
    onSuccess: (created) => {
      invalidateArtifactQueries(queryClient, {
        worksheetId: created.worksheetId ?? worksheetId ?? null,
        workId: created.workId,
        taskId: created.taskId,
      });
      pushToast({ message: `已创建资源「${created.name}」`, variant: 'success' });
      onOpenChange(false);
      onSuccess?.(created);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : '创建资源失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('请填写资源名');
      return;
    }
    mutation.mutate();
  };

  const displayTags: ScopeTagItem[] =
    scopeTags && scopeTags.length > 0 ? scopeTags : [{ kind: 'doc', label: scopeLabel }];

  return (
    <ModalDialog open={open} onOpenChange={onOpenChange} title="新建资源" maxWidthClass="max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="artifact-create-form">
        {/* 亮色层级归属标签：工作表 - 作品 - 任务 - 工序 */}
        <div
          data-testid="artifact-scope-tags"
          className="flex flex-wrap items-center gap-1 rounded-lg border border-black/[0.06] bg-[#fafafa] px-2.5 py-2"
        >
          <span className="mr-1 text-[11px] font-medium text-zinc-500">挂载位置</span>
          {displayTags.map((tag, idx) => (
            <span key={`${tag.kind}-${tag.label}`} className="inline-flex items-center gap-1">
              {idx > 0 && <ChevronRight className="h-3 w-3 text-zinc-300" />}
              <span
                className={cn(
                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1',
                  SCOPE_TAG_STYLES[tag.kind],
                )}
              >
                {tag.label}
              </span>
            </span>
          ))}
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        <SharePasteInput onParsed={handleParsed} />

        <div>
          <Label htmlFor="art-name">资源名称 *</Label>
          <Input
            id="art-name"
            data-testid="artifact-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：全篇原片、翻译初稿、通用字体包"
            maxLength={120}
            required
          />
        </div>

        <div>
          <Label htmlFor="art-url">网盘链接（留空则创建“待补充多网盘”资源）</Label>
          <Input
            id="art-url"
            data-testid="artifact-url-input"
            type="text"
            value={url}
            onChange={(e) => {
              const next = e.target.value;
              setUrl(next);
              if (!providerTouched && next.trim()) {
                setProvider(detectCloudProvider(next));
              }
            }}
            placeholder="https://pan.baidu.com/s/..."
            maxLength={2000}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="art-provider">网盘服务商</Label>
            <SelectField
              id="art-provider"
              value={provider}
              onValueChange={(val) => {
                setProvider(val as CloudProvider);
                setProviderTouched(true);
              }}
              options={CLOUD_PROVIDERS.map((p) => ({
                value: p,
                label: CLOUD_PROVIDER_LABELS[p],
              }))}
            />
          </div>
          <div>
            <Label htmlFor="art-code">提取码（可选）</Label>
            <Input
              id="art-code"
              data-testid="artifact-code-input"
              value={extractCode}
              onChange={(e) => setExtractCode(e.target.value)}
              placeholder="如 ab12"
              maxLength={32}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="art-note">备注（可选）</Label>
          <Input
            id="art-note"
            data-testid="artifact-note-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="补充说明（如版本特点、镜像来源等）"
            maxLength={200}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending} data-testid="artifact-submit-btn">
            {mutation.isPending ? '保存中…' : '创建资源'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function EditArtifactModal({
  open,
  onOpenChange,
  artifact,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: ArtifactDetail | null;
  onSuccess?: (artifact: ArtifactDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [name, setName] = useState('');
  const [scopeKind, setScopeKind] = useState<ArtifactScopeKind>('doc');
  const [selectedWsId, setSelectedWsId] = useState('');
  const [selectedWorkId, setSelectedWorkId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedStageColId, setSelectedStageColId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: worksheets = [] } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
    enabled: open,
  });

  const { data: wsDetail } = useQuery<WorksheetFullResponse>({
    queryKey: selectedWsId ? queryKeys.worksheet(selectedWsId) : ['worksheets', 'none'],
    queryFn: () => apiFetch<WorksheetFullResponse>(`/api/worksheets/${selectedWsId}`),
    enabled: Boolean(open && scopeKind !== 'doc' && selectedWsId),
  });

  useEffect(() => {
    if (open && artifact) {
      setName(artifact.name);
      setScopeKind(artifact.scopeKind);
      setSelectedWsId(artifact.worksheetId ?? worksheets[0]?.id ?? '');
      setSelectedWorkId(artifact.workId ?? '');
      setSelectedTaskId(artifact.taskId ?? '');
      setSelectedStageColId(artifact.stageColumnId ?? '');
      setError(null);
    }
  }, [open, artifact, worksheets]);

  const stageCols = wsDetail?.columns.filter((c) => c.type === 'stage') ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      if (!artifact) throw new Error('no artifact');
      let scope: ArtifactScope;
      if (scopeKind === 'doc') {
        scope = { kind: 'doc' };
      } else if (scopeKind === 'work') {
        if (!selectedWorkId) throw new Error('请选择目标作品');
        scope = { kind: 'work', workId: selectedWorkId };
      } else if (scopeKind === 'task') {
        if (!selectedTaskId) throw new Error('请选择目标任务');
        scope = { kind: 'task', taskId: selectedTaskId };
      } else {
        if (!selectedTaskId || !selectedStageColId) throw new Error('请选择目标任务与工序列');
        scope = { kind: 'stage', taskId: selectedTaskId, stageColumnId: selectedStageColId };
      }
      return apiFetch<ArtifactDetail>(`/api/artifacts/${artifact.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), scope },
      });
    },
    onSuccess: (updated) => {
      invalidateArtifactQueries(queryClient, {
        worksheetId: artifact?.worksheetId ?? null,
        workId: artifact?.workId ?? null,
        taskId: artifact?.taskId ?? null,
      });
      invalidateArtifactQueries(queryClient, {
        worksheetId: updated.worksheetId,
        workId: updated.workId,
        taskId: updated.taskId,
      });
      pushToast({ message: '资源信息已更新', variant: 'success' });
      onOpenChange(false);
      onSuccess?.(updated);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : '更新失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('请填写资源名');
      return;
    }
    mutation.mutate();
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="改名或移动归属"
      description="修改名称或调整挂载位置不会改变现有版本号与版本历史"
      maxWidthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="artifact-edit-form">
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="edit-art-name">资源名称 *</Label>
          <Input
            id="edit-art-name"
            data-testid="edit-artifact-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
          />
        </div>

        <div>
          <Label>挂载层级</Label>
          <div className="grid grid-cols-4 gap-1">
            {(
              [
                ['doc', '通用文档'],
                ['work', '作品共用'],
                ['task', '任务'],
                ['stage', '工序格'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                data-testid={`move-scope-${k}`}
                onClick={() => {
                  setScopeKind(k);
                  if (k !== 'doc' && !selectedWsId && worksheets[0]) {
                    setSelectedWsId(worksheets[0].id);
                  }
                }}
                className={cn(
                  'rounded-md border py-1.5 text-xs font-medium transition-colors cursor-pointer',
                  scopeKind === k
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {scopeKind !== 'doc' && (
          <div>
            <Label htmlFor="move-ws">目标工作表</Label>
            <SelectField
              id="move-ws"
              value={selectedWsId}
              onValueChange={(val) => {
                setSelectedWsId(val);
                setSelectedWorkId('');
                setSelectedTaskId('');
                setSelectedStageColId('');
              }}
              options={[
                { value: '', label: '请选择工作表' },
                ...worksheets.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </div>
        )}

        {scopeKind === 'work' && wsDetail && (
          <div>
            <Label htmlFor="move-work">目标作品</Label>
            <SelectField
              id="move-work"
              value={selectedWorkId}
              onValueChange={setSelectedWorkId}
              options={[
                { value: '', label: '请选择作品' },
                ...wsDetail.works.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </div>
        )}

        {(scopeKind === 'task' || scopeKind === 'stage') && wsDetail && (
          <div>
            <Label htmlFor="move-task">目标任务</Label>
            <SelectField
              id="move-task"
              value={selectedTaskId}
              onValueChange={setSelectedTaskId}
              options={[
                { value: '', label: '请选择任务' },
                ...wsDetail.tasks.map((t) => ({ value: t.id, label: t.title })),
              ]}
            />
          </div>
        )}

        {scopeKind === 'stage' && wsDetail && (
          <div>
            <Label htmlFor="move-stage">目标工序列</Label>
            <SelectField
              id="move-stage"
              value={selectedStageColId}
              onValueChange={setSelectedStageColId}
              options={[
                { value: '', label: '请选择工序列' },
                ...stageCols.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending} data-testid="edit-artifact-submit">
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
