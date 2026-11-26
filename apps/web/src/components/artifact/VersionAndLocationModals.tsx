import {
  type ArtifactDetail,
  type ArtifactVersionDetail,
  CLOUD_PROVIDER_LABELS,
  CLOUD_PROVIDERS,
  type CloudProvider,
  detectCloudProvider,
  type ParsedShareText,
  type ResourceLocation,
} from '@nw/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/api/client.js';
import { SharePasteInput } from '@/components/artifact/SharePasteInput.js';
import { invalidateArtifactQueries } from '@/components/artifact/utils.js';
import { ModalDialog, useToast } from '@/components/ui/overlays.js';
import { Alert, Button, Input, Label } from '@/components/ui/primitives.js';
import { SelectField } from '@/components/ui/select.js';

export function CreateVersionModal({
  open,
  onOpenChange,
  artifact,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: ArtifactDetail | null;
  onSuccess?: (version: ArtifactVersionDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('other');
  const [providerTouched, setProviderTouched] = useState(false);
  const [extractCode, setExtractCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNote('');
      setUrl('');
      setProvider('other');
      setProviderTouched(false);
      setExtractCode('');
      setError(null);
    }
  }, [open]);

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
  };

  const mutation = useMutation({
    mutationFn: () => {
      if (!artifact) throw new Error('no artifact');
      const trimmedUrl = url.trim();
      const body: Record<string, unknown> = {
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      if (trimmedUrl) {
        body.location = {
          provider,
          url: trimmedUrl,
          extractCode: extractCode.trim() || null,
          isFolder: false,
          note: '',
        };
      }
      return apiFetch<ArtifactVersionDetail>(`/api/artifacts/${artifact.id}/versions`, {
        method: 'POST',
        body,
      });
    },
    onSuccess: (created) => {
      invalidateArtifactQueries(queryClient, {
        worksheetId: artifact?.worksheetId ?? null,
        workId: artifact?.workId ?? null,
        taskId: artifact?.taskId ?? null,
      });
      pushToast({
        message: `已登记「${artifact?.name ?? ''}」v${created.versionNumber}`,
        variant: 'success',
      });
      onOpenChange(false);
      onSuccess?.(created);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : '登记新版本失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  };

  const nextVerHint = artifact?.latestVersion ? artifact.latestVersion.versionNumber + 1 : 1;

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`更新版本（v${nextVerHint}）`}
      description={
        artifact ? `资源「${artifact.name}」· 登记后立即成为最新展示版本，旧版本保留在历史中` : ''
      }
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="version-create-form">
        {error && <Alert variant="error">{error}</Alert>}

        <SharePasteInput onParsed={handleParsed} />

        <div>
          <Label htmlFor="ver-url">网盘链接（留空则创建“待补充入口”版本）</Label>
          <Input
            id="ver-url"
            data-testid="version-url-input"
            type="text"
            value={url}
            onChange={(e) => {
              const next = e.target.value;
              setUrl(next);
              if (!providerTouched && next.trim()) {
                setProvider(detectCloudProvider(next));
              }
            }}
            placeholder="https://..."
            maxLength={2000}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ver-provider">网盘服务商</Label>
            <SelectField
              id="ver-provider"
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
            <Label htmlFor="ver-code">提取码（可选）</Label>
            <Input
              id="ver-code"
              data-testid="version-code-input"
              value={extractCode}
              onChange={(e) => setExtractCode(e.target.value)}
              placeholder="如 ab12"
              maxLength={32}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="ver-note">备注（可选）</Label>
          <Input
            id="ver-note"
            data-testid="version-note-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：修正第 12 分钟错字 / 替换压制成品"
            maxLength={200}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending} data-testid="version-submit-btn">
            {mutation.isPending ? '登记中…' : '确认更新'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function LocationFormModal({
  open,
  onOpenChange,
  target,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target:
    | {
        mode: 'create';
        artifact: ArtifactDetail;
        versionId: string;
        versionNumber: number;
      }
    | {
        mode: 'edit';
        artifact: ArtifactDetail;
        versionNumber: number;
        location: ResourceLocation;
      }
    | null;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('other');
  const [providerTouched, setProviderTouched] = useState(false);
  const [extractCode, setExtractCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    if (target.mode === 'edit') {
      setUrl(target.location.url ?? '');
      setProvider(target.location.provider ?? 'other');
      setProviderTouched(true);
      setExtractCode(target.location.extractCode ?? '');
      setNote(target.location.note);
    } else {
      setUrl('');
      setProvider('other');
      setProviderTouched(false);
      setExtractCode('');
      setNote('');
    }
    setError(null);
  }, [open, target]);

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
  };

  const mutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('no target');
      const payload = {
        provider,
        url: url.trim(),
        extractCode: extractCode.trim() || null,
        isFolder: target.mode === 'edit' ? target.location.isFolder : false,
        note: note.trim(),
      };
      if (target.mode === 'create') {
        return apiFetch<ResourceLocation>(`/api/artifact-versions/${target.versionId}/locations`, {
          method: 'POST',
          body: payload,
        });
      }
      return apiFetch<ResourceLocation>(`/api/resource-locations/${target.location.id}`, {
        method: 'PATCH',
        body: payload,
      });
    },
    onSuccess: () => {
      invalidateArtifactQueries(queryClient, {
        worksheetId: target?.artifact.worksheetId ?? null,
        workId: target?.artifact.workId ?? null,
        taskId: target?.artifact.taskId ?? null,
      });
      pushToast({
        message: target?.mode === 'create' ? '已补充网盘入口' : '网盘入口已更新',
        variant: 'success',
      });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : '保存失败');
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!url.trim()) {
      setError('请填写网盘链接');
      return;
    }
    mutation.mutate();
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title={target?.mode === 'edit' ? '编辑网盘入口' : '补充网盘入口'}
      description={
        target
          ? `资源「${target.artifact.name}」(v${target.versionNumber}) · 补充或编辑入口不升版本号`
          : ''
      }
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="location-form">
        {error && <Alert variant="error">{error}</Alert>}

        <SharePasteInput onParsed={handleParsed} />

        <div>
          <Label htmlFor="loc-url">网盘链接 *</Label>
          <Input
            id="loc-url"
            data-testid="location-url-input"
            type="text"
            value={url}
            onChange={(e) => {
              const next = e.target.value;
              setUrl(next);
              if (!providerTouched && next.trim()) {
                setProvider(detectCloudProvider(next));
              }
            }}
            placeholder="https://..."
            maxLength={2000}
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="loc-provider">网盘服务商</Label>
            <SelectField
              id="loc-provider"
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
            <Label htmlFor="loc-code">提取码（可选）</Label>
            <Input
              id="loc-code"
              data-testid="location-code-input"
              value={extractCode}
              onChange={(e) => setExtractCode(e.target.value)}
              placeholder="如 ab12"
              maxLength={32}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="loc-note">备注（可选）</Label>
          <Input
            id="loc-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：海外节点 / 备用镜像"
            maxLength={200}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" disabled={mutation.isPending} data-testid="location-submit-btn">
            {mutation.isPending ? '保存中…' : '保存入口'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
