import { PUBLISH_STATUS_LABELS, type SearchResponse, STAGE_STATUS_LABELS } from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FileText, Paperclip, Search, Table2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { STAGE_STATUS_STYLES } from '@/components/ui/colors.js';
import { cn, Input } from '@/components/ui/primitives.js';

export interface KeywordSearchInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  'aria-label': string;
  className?: string;
  align?: 'left' | 'right';
}

export function KeywordSearchInput({
  value,
  onChange,
  placeholder = '筛选或跨表检索关键词…',
  'aria-label': ariaLabel,
  className,
  align = 'left',
}: KeywordSearchInputProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [hidePublished, setHidePublished] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setDebouncedQuery('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, 220);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    if (!focused) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [focused]);

  const params: Record<string, string> = {};
  if (debouncedQuery) params.q = debouncedQuery;
  if (hidePublished) params.hidePublished = 'true';
  const queryStr = new URLSearchParams(params).toString();

  const shouldQuery = debouncedQuery.length > 0;
  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: queryKeys.search(params),
    queryFn: () => apiFetch<SearchResponse>(`/api/search${queryStr ? `?${queryStr}` : ''}`),
    enabled: shouldQuery,
  });

  const showDropdown = focused && value.trim().length > 0;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-1 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
      <Input
        value={value}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setFocused(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setFocused(false);
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="h-7 w-full rounded-none border-0 border-b border-black/[0.12] bg-transparent pr-5 pl-6 text-xs focus:border-zinc-900 focus:ring-0"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            setFocused(false);
          }}
          aria-label="清空关键词"
          className="absolute top-1/2 right-0.5 -translate-y-1/2 rounded-[2px] p-0.5 text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-700 cursor-pointer"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {showDropdown && (
        <div
          data-testid="global-search-dropdown"
          className={cn(
            'absolute top-full z-[70] mt-1.5 w-[min(420px,calc(100vw-1.5rem))] overflow-hidden rounded-[4px] border border-black/[0.08] bg-white shadow-[0_12px_32px_-8px_rgba(0,0,0,0.16),0_2px_8px_-2px_rgba(0,0,0,0.06)]',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] bg-[#fafafa] px-3 py-2">
            <span className="text-[11px] font-medium text-zinc-500">
              跨表与资源检索
              {data
                ? ` · ${data.total} 条工作表 / ${data.docs.length + (data.docSheets?.length ?? 0)} 项通用文档`
                : ''}
            </span>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hidePublished}
                onChange={(e) => setHidePublished(e.target.checked)}
                className="h-3 w-3 rounded border-zinc-300"
              />
              隐藏已发布
            </label>
          </div>

          <div
            data-testid="search-results"
            className="no-scrollbar max-h-[360px] divide-y divide-black/[0.05] overflow-y-auto"
          >
            {isFetching && !data ? (
              <div className="py-6 text-center text-xs text-zinc-400">正在跨表检索…</div>
            ) : !data ||
              (data.items.length === 0 &&
                data.docs.length === 0 &&
                (data.docSheets?.length ?? 0) === 0) ? (
              <div className="py-6 text-center text-xs text-zinc-400">
                没有找到匹配的任务、资源或通用文档
              </div>
            ) : (
              <>
                {(data.docs.length > 0 || (data.docSheets?.length ?? 0) > 0) && (
                  <div data-testid="search-docs-section" className="divide-y divide-black/[0.04]">
                    <div className="bg-zinc-50/90 px-3 py-1.5 text-[11px] font-semibold text-zinc-500">
                      通用文档（{data.docs.length + (data.docSheets?.length ?? 0)}）
                    </div>
                    {(data.docSheets ?? []).map((row) => (
                      <button
                        key={`sheet-${row.worksheetId}-${row.taskId}`}
                        type="button"
                        data-testid={`search-doc-sheet-result-${row.taskId}`}
                        onClick={() => {
                          setFocused(false);
                          navigate(`/docs?sheetId=${row.worksheetId}&taskId=${row.taskId}`);
                        }}
                        className="flex w-full items-center justify-between gap-2.5 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] cursor-pointer"
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <Table2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="truncate text-[11px] font-medium text-zinc-500">
                              {row.worksheetName}
                            </span>
                            {row.workName && (
                              <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0 text-[10px] font-medium text-indigo-700">
                                {row.workName}
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs font-medium text-zinc-900">
                            {row.snippet || row.title}
                          </div>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      </button>
                    ))}
                    {data.docs.map((doc) => (
                      <button
                        key={doc.artifactId}
                        type="button"
                        data-testid={`search-doc-result-${doc.artifactId}`}
                        onClick={() => {
                          setFocused(false);
                          navigate(`/docs?artifactId=${doc.artifactId}`);
                        }}
                        className="flex w-full items-center justify-between gap-2.5 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] cursor-pointer"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          <span className="truncate text-xs font-medium text-zinc-900">
                            {doc.name}
                          </span>
                          {doc.latestVersionNumber !== null && (
                            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0 text-[10px] font-medium text-zinc-600 tabular-nums">
                              v{doc.latestVersionNumber}
                            </span>
                          )}
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      </button>
                    ))}
                  </div>
                )}

                {data.items.map((item) => (
                  <button
                    key={item.taskId}
                    type="button"
                    data-testid={`search-result-${item.taskId}`}
                    onClick={() => {
                      setFocused(false);
                      navigate(
                        item.worksheetPlacement === 'docs'
                          ? `/docs?sheetId=${item.worksheetId}&taskId=${item.taskId}`
                          : `/worksheets/${item.worksheetId}?taskId=${item.taskId}`,
                      );
                    }}
                    className="flex w-full items-start justify-between gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-black/[0.03] cursor-pointer"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium text-zinc-500">
                          {item.worksheetName}
                        </span>
                        {item.workName && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0 text-[10px] font-medium text-indigo-700">
                            {item.workName}
                          </span>
                        )}
                        {item.publishStatus === 'published' && (
                          <span className="rounded-full bg-emerald-50 px-1.5 py-0 text-[10px] font-medium text-emerald-700">
                            {PUBLISH_STATUS_LABELS.published}
                          </span>
                        )}
                        {item.publishStatus === 'shelved' && (
                          <span className="rounded-full bg-zinc-200 px-1.5 py-0 text-[10px] font-medium text-zinc-700">
                            {PUBLISH_STATUS_LABELS.shelved}
                          </span>
                        )}
                      </div>

                      <div className="truncate text-xs font-semibold text-zinc-950">
                        {item.taskTitle || item.matchedSnippet || '空白行'}
                      </div>

                      {item.matchedSnippet && item.matchedSnippet !== item.taskTitle && (
                        <div className="truncate text-[11px] text-zinc-500">
                          {item.matchedSnippet}
                        </div>
                      )}

                      {item.matchedArtifactNames && item.matchedArtifactNames.length > 0 && (
                        <div className="inline-flex max-w-full items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10.5px] text-zinc-600">
                          <Paperclip className="h-2.5 w-2.5 shrink-0 text-zinc-400" />
                          <span className="truncate">
                            匹配资源：{item.matchedArtifactNames.join('、')}
                          </span>
                        </div>
                      )}

                      {item.divisionNote && (
                        <div className="truncate text-[11px] text-zinc-500">
                          {item.divisionNote}
                        </div>
                      )}

                      {item.stages.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {item.stages.slice(0, 4).map((st) => (
                            <span
                              key={st.columnId}
                              className={cn(
                                'rounded px-1.5 py-0.25 text-[10px]',
                                STAGE_STATUS_STYLES[st.status].badge,
                              )}
                            >
                              {st.name}
                              {st.assigneeNames.length > 0
                                ? `·${st.assigneeNames.join('、')}`
                                : `·${STAGE_STATUS_LABELS[st.status]}`}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
