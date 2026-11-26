import type { ArtifactChangedPayload, ArtifactDetail, WorksheetSummary } from '@nw/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  History,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { ArtifactCardList } from '@/components/artifact/ArtifactCardList.js';
import { CreateArtifactModal } from '@/components/artifact/ArtifactFormModal.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';
import { ChangeLogDrawer } from '@/components/worksheet/ChangeLogDrawer.js';
import {
  CreateWorksheetModal,
  DeleteWorksheetDialog,
  EditWorksheetModal,
} from '@/components/worksheet/WorksheetFormModal.js';
import { WorksheetDetailPage } from '@/pages/WorksheetDetailPage.js';
import { useRealtimeScope } from '@/realtime/context.js';

export function DocsPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [keyword, setKeyword] = useState('');
  const [createArtifactOpen, setCreateArtifactOpen] = useState(false);
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [editSheet, setEditSheet] = useState<WorksheetSummary | null>(null);
  const [deleteSheet, setDeleteSheet] = useState<WorksheetSummary | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { data: worksheets = [], isLoading: sheetsLoading } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
  });

  const docsSheets = useMemo(() => worksheets.filter((w) => w.placement === 'docs'), [worksheets]);

  const trimmedQ = keyword.trim();
  const { data: docs = [], isLoading: docsLoading } = useQuery<ArtifactDetail[]>({
    queryKey: queryKeys.docs(trimmedQ),
    queryFn: () =>
      apiFetch<ArtifactDetail[]>(
        trimmedQ ? `/api/docs?q=${encodeURIComponent(trimmedQ)}` : '/api/docs',
      ),
  });

  const requestedTab = searchParams.get('tab');
  const requestedSheetId = searchParams.get('sheetId');
  const locateArtifactId = searchParams.get('artifactId');

  // 解析当前活动标签页：
  // 1) ?artifactId=... 或 ?tab=files 强制切换到公共文件
  // 2) ?sheetId=<有效 docs sheet> 切换到对应在线表格
  // 3) 默认打开第一张 /docs 在线表格（无在线表格时回退到公共文件）
  const activeMode = useMemo<'files' | { sheetId: string }>(() => {
    if (locateArtifactId || requestedTab === 'files') return 'files';
    if (requestedSheetId && docsSheets.some((s) => s.id === requestedSheetId)) {
      return { sheetId: requestedSheetId };
    }
    if (docsSheets.length > 0 && docsSheets[0]) {
      return { sheetId: docsSheets[0].id };
    }
    return 'files';
  }, [locateArtifactId, requestedTab, requestedSheetId, docsSheets]);

  const selectSheetTab = (sheetId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('sheetId', sheetId);
    next.delete('tab');
    next.delete('artifactId');
    next.delete('taskId');
    setSearchParams(next, { replace: true });
  };

  const selectFilesTab = () => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'files');
    next.delete('sheetId');
    next.delete('taskId');
    setSearchParams(next, { replace: true });
  };

  useRealtimeScope(me ? { type: 'project', id: me.project.id } : null, {
    onEvent: (ev) => {
      if (ev.type === 'artifact.changed') {
        const p = ev.payload as ArtifactChangedPayload | undefined;
        if (!p || p.scopeKind === 'doc' || p.action === 'artifact.moved') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.docsAll });
          void queryClient.invalidateQueries({ queryKey: queryKeys.docsChangeLogs });
        }
      } else if (
        ev.type === 'worksheet.created' ||
        ev.type === 'worksheet.updated' ||
        ev.type === 'worksheet.deleted' ||
        ev.type === 'worksheets.reordered'
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
      }
    },
    onResync: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.docsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
    },
  });

  useEffect(() => {
    if (!locateArtifactId || docsLoading) return;
    setHighlightedId(locateArtifactId);
    const el = document.querySelector(`[data-testid="artifact-card-${locateArtifactId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('artifactId');
    next.set('tab', 'files');
    setSearchParams(next, { replace: true });

    const timer = setTimeout(() => setHighlightedId(null), 2200);
    return () => clearTimeout(timer);
  }, [locateArtifactId, docsLoading, searchParams, setSearchParams]);

  const activeSheetId = activeMode === 'files' ? null : activeMode.sheetId;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white" data-testid="docs-page">
      {/* 顶部紧凑切换栏：在线表格 Tabs + 公共文件 + 新建表格 */}
      <div
        data-testid="docs-tabs-bar"
        className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-black/[0.08] bg-[#fafafa] px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {docsSheets.map((ws) => {
          const isActive = activeSheetId === ws.id;
          return (
            <div
              key={ws.id}
              data-testid={`docs-sheet-tab-${ws.id}`}
              className={cn(
                'group inline-flex shrink-0 items-center rounded-md border transition-colors',
                isActive
                  ? 'border-black/[0.12] bg-white text-zinc-950 shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                  : 'border-transparent text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-950',
              )}
            >
              <button
                type="button"
                onClick={() => selectSheetTab(ws.id)}
                className="inline-flex h-7 items-center gap-1.5 pl-2.5 pr-1.5 text-xs font-medium whitespace-nowrap cursor-pointer"
              >
                <Table2 className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
                <span className="max-w-[160px] truncate">{ws.name}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`更多操作 ${ws.name}`}
                    className={cn(
                      'mr-1 flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-opacity hover:bg-black/[0.06] hover:text-zinc-800 cursor-pointer',
                      isActive ? 'opacity-100' : 'opacity-60 group-hover:opacity-100',
                    )}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => setEditSheet(ws)}>
                    <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                    重命名表格
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteSheet(ws)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    删除表格
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}

        <button
          type="button"
          data-testid="docs-files-tab"
          onClick={selectFilesTab}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
            activeMode === 'files'
              ? 'border-black/[0.12] bg-white text-zinc-950 shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
              : 'border-transparent text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-950',
          )}
        >
          <FileText className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} />
          <span>公共文件</span>
          <span className="rounded-full bg-black/[0.06] px-1.5 py-0 text-[10px] font-medium text-zinc-600 tabular-nums">
            {docs.length}
          </span>
        </button>

        <button
          type="button"
          data-testid="docs-create-sheet-btn"
          onClick={() => setCreateSheetOpen(true)}
          className="ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-dashed border-black/[0.15] px-2 text-xs font-medium text-zinc-600 whitespace-nowrap transition-colors hover:border-black/[0.25] hover:bg-white hover:text-zinc-950 cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>新建表格</span>
        </button>
      </div>

      {/* 内容区：嵌入在线表格 OR 公共文件列表 */}
      {activeSheetId ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="docs-sheet-view">
          <WorksheetDetailPage
            embeddedWorksheetId={activeSheetId}
            onEmbeddedDeleted={() => {
              const remaining = docsSheets.filter((s) => s.id !== activeSheetId);
              if (remaining[0]) selectSheetTab(remaining[0].id);
              else selectFilesTab();
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-zinc-700" strokeWidth={1.75} />
                <div>
                  <h1 className="text-lg font-semibold tracking-tight text-zinc-950">
                    通用文档 · 公共文件
                  </h1>
                  <p className="text-xs text-zinc-500">
                    项目级公共文件与链接（字体包、样式模板、原始备份等），全员协作维护
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
                  onClick={() => setCreateArtifactOpen(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  新建资源
                </Button>
              </div>
            </div>

            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="按资源名称筛选公共文件…"
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

            {docsLoading || sheetsLoading ? (
              <div className="py-12 text-center text-sm text-zinc-400">正在加载通用文档…</div>
            ) : (
              <ArtifactCardList
                artifacts={docs}
                highlightedArtifactId={highlightedId}
                emptyText={
                  trimmedQ
                    ? `没有找到名称包含「${trimmedQ}」的公共文件`
                    : '暂无公共文件，点击右上角「新建资源」添加字体包、样式模板或网盘链接，或点击顶部「新建表格」创建在线对照表'
                }
              />
            )}
          </div>
        </div>
      )}

      <CreateWorksheetModal
        open={createSheetOpen}
        onOpenChange={setCreateSheetOpen}
        placement="docs"
        onCreated={(id) => selectSheetTab(id)}
      />

      <EditWorksheetModal worksheet={editSheet} onClose={() => setEditSheet(null)} />

      <DeleteWorksheetDialog
        worksheet={deleteSheet}
        onClose={() => setDeleteSheet(null)}
        onDeleted={(deletedId) => {
          if (activeSheetId === deletedId) {
            const remaining = docsSheets.filter((s) => s.id !== deletedId);
            if (remaining[0]) selectSheetTab(remaining[0].id);
            else selectFilesTab();
          }
        }}
      />

      <CreateArtifactModal
        open={createArtifactOpen}
        onOpenChange={setCreateArtifactOpen}
        scope={{ kind: 'doc' }}
        scopeLabel="通用文档"
        scopeTags={[{ kind: 'doc', label: '通用文档' }]}
      />

      <ChangeLogDrawer mode="docs" open={logsOpen} onOpenChange={setLogsOpen} />
    </div>
  );
}
