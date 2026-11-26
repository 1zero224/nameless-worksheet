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
import { File as FileIcon, Folder } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { SharePasteInput } from '@/components/artifact/SharePasteInput.js';
import { invalidateArtifactQueries } from '@/components/artifact/utils.js';
import { ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, cn, Input, Label } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';

export function CreateArtifactModal({
  open,
  onOpenChange,
  scope,
  scopeLabel,
  defaultName = '',
  worksheetId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: ArtifactScope;
  scopeLabel: string;
  defaultName?: string;
  worksheetId?: string | null;
  onSuccess?: (artifact: ArtifactDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [name, setName] = useState(defaultName);
  const [versionNote, setVersionNote] = useState('');
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('other');
  const [providerTouched, setProviderTouched] = useState(false);
  const [extractCode, setExtractCode] = useState('');
  const [isFolder, setIsFolder] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [locationNote, setLocationNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setVersionNote('');
      setUrl('');
      setProvider('other');
      setProviderTouched(false);
      setExtractCode('');
      setIsFolder(false);
      setExpiresAt('');
      setLocationNote('');
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
      const body: Record<string, unknown> = {
        scope,
        name: name.trim(),
        ...(versionNote.trim() ? { versionNote: versionNote.trim() } : {}),
      };
      if (trimmedUrl) {
        body.location = {
          provider,
          url: trimmedUrl,
          extractCode: extractCode.trim() || null,
          isFolder,
          expiresAt: expiresAt.trim() || null,
          note: locationNote.trim(),
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

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建资源"
      description={`挂载位置：${scopeLabel}`}
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="artifact-create-form">
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
          <Label htmlFor="art-url">网盘链接（留空则创建“待补充入口”资源）</Label>
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>链接指向类型</Label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setIsFolder(false)}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border text-xs font-medium transition-colors cursor-pointer',
                  !isFolder
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-black/[0.12] bg-white text-zinc-700 hover:bg-black/[0.04]',
                )}
              >
                <FileIcon className="h-3.5 w-3.5" />
                文件
              </button>
              <button
                type="button"
                onClick={() => setIsFolder(true)}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border text-xs font-medium transition-colors cursor-pointer',
                  isFolder
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-black/[0.12] bg-white text-zinc-700 hover:bg-black/[0.04]',
                )}
              >
                <Folder className="h-3.5 w-3.5" />
                文件夹
              </button>
            </div>
          </div>
          <div>
            <Label htmlFor="art-expires">有效期至（可选）</Label>
            <Input
              id="art-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="art-ver-note">v1 版本说明（可选）</Label>
            <Input
              id="art-ver-note"
              value={versionNote}
              onChange={(e) => setVersionNote(e.target.value)}
              placeholder="如：蓝光原片 / 初版"
              maxLength={200}
            />
          </div>
          <div>
            <Label htmlFor="art-loc-note">入口备注（可选）</Label>
            <Input
              id="art-loc-note"
              value={locationNote}
              onChange={(e) => setLocationNote(e.target.value)}
              placeholder="如：主链 / 备用镜像"
              maxLength={200}
            />
          </div>
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
