import type { ArtifactChangedPayload, ArtifactDetail } from '@nw/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, History, Plus, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { ArtifactCardList } from '@/components/artifact/ArtifactCardList.js';
import { CreateArtifactModal } from '@/components/artifact/ArtifactFormModal.js';
import { Button, Input } from '@/components/ui/primitives.js';
import { ChangeLogDrawer } from '@/components/worksheet/ChangeLogDrawer.js';
import { useRealtimeScope } from '@/realtime/context.js';

export function DocsPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [keyword, setKeyword] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const trimmedQ = keyword.trim();
  const { data: docs = [], isLoading } = useQuery<ArtifactDetail[]>({
    queryKey: queryKeys.docs(trimmedQ),
    queryFn: () =>
      apiFetch<ArtifactDetail[]>(
        trimmedQ ? `/api/docs?q=${encodeURIComponent(trimmedQ)}` : '/api/docs',
      ),
  });

  useRealtimeScope(me ? { type: 'project', id: me.project.id } : null, {
    onEvent: (ev) => {
      if (ev.type === 'artifact.changed') {
        const p = ev.payload as ArtifactChangedPayload | undefined;
        if (!p || p.scopeKind === 'doc' || p.action === 'artifact.moved') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.docsAll });
          void queryClient.invalidateQueries({ queryKey: queryKeys.docsChangeLogs });
        }
      }
    },
    onResync: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.docsAll });
    },
  });

  const locateArtifactId = searchParams.get('artifactId');
  useEffect(() => {
    if (!locateArtifactId || isLoading) return;
    setHighlightedId(locateArtifactId);
    const el = document.querySelector(`[data-testid="artifact-card-${locateArtifactId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('artifactId');
    setSearchParams(next, { replace: true });

    const timer = setTimeout(() => setHighlightedId(null), 2200);
    return () => clearTimeout(timer);
  }, [locateArtifactId, isLoading, searchParams, setSearchParams]);

  return (
    <div className="space-y-4" data-testid="docs-page">
      {/* 顶部标题与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-zinc-700" strokeWidth={1.75} />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-950">通用文档</h1>
            <p className="text-xs text-zinc-500">
              项目级公共资源（翻译对照表、通用字体包、样式模板等），全员协作维护
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="docs-change-logs-btn"
            onClick={() => setLogsOpen(true)}
          >
            <History className="mr-1.5 h-3.5 w-3.5 text-zinc-500" />
            修改记录
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="docs-create-btn"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            新建资源
          </Button>
        </div>
      </div>

      {/* 关键词过滤栏 */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="按资源名称筛选通用文档…"
          aria-label="筛选通用文档"
          className="h-8 pr-7 pl-8 text-xs"
        />
        {keyword && (
          <button
            type="button"
            onClick={() => setKeyword('')}
            aria-label="清空筛选"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-700 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* 平铺资源列表 */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-zinc-400">正在加载通用文档…</div>
      ) : (
        <ArtifactCardList
          artifacts={docs}
          highlightedArtifactId={highlightedId}
          emptyText={
            trimmedQ
              ? `没有找到名称包含「${trimmedQ}」的通用文档`
              : '暂无通用文档，点击右上角「新建资源」添加翻译对照表、字体包或网盘链接'
          }
        />
      )}

      <CreateArtifactModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        scope={{ kind: 'doc' }}
        scopeLabel="通用文档"
        scopeTags={[{ kind: 'doc', label: '通用文档' }]}
      />

      <ChangeLogDrawer mode="docs" open={logsOpen} onOpenChange={setLogsOpen} />
    </div>
  );
}
