import {
  PUBLISH_STATUS_LABELS,
  type SearchResponse,
  STAGE_STATUS_LABELS,
  STAGE_STATUSES,
  type WorksheetSummary,
} from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { STAGE_STATUS_STYLES, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { Card, cn, Input, Select } from '@/components/ui/primitives.js';

export function SearchPage() {
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [worksheetId, setWorksheetId] = useState('');
  const [status, setStatus] = useState('');
  const [hidePublished, setHidePublished] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(rawQuery.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  const { data: worksheets = [] } = useQuery<WorksheetSummary[]>({
    queryKey: queryKeys.worksheets,
    queryFn: () => apiFetch<WorksheetSummary[]>('/api/worksheets'),
  });

  const params: Record<string, string> = {};
  if (debouncedQuery) params.q = debouncedQuery;
  if (worksheetId) params.worksheetId = worksheetId;
  if (status) params.status = status;
  if (hidePublished) params.hidePublished = 'true';

  const queryStr = new URLSearchParams(params).toString();
  const { data, isLoading } = useQuery<SearchResponse>({
    queryKey: queryKeys.search(params),
    queryFn: () => apiFetch<SearchResponse>(`/api/search${queryStr ? `?${queryStr}` : ''}`),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">资源检索</h1>
        <p className="mt-1 text-sm text-slate-500">
          跨所有工作表检索任务标题、作品名、分工说明、负责人（含纯文本名字）、工序备注与自定义文本列。
        </p>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="输入中文或英文关键词…"
              aria-label="检索关键词"
              className="pl-9"
              autoFocus
            />
          </div>

          <Select
            aria-label="筛选工作表"
            value={worksheetId}
            onChange={(e) => setWorksheetId(e.target.value)}
            className="w-36"
          >
            <option value="">全部工作表</option>
            {worksheets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>

          <Select
            aria-label="筛选工序状态"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-32"
          >
            <option value="">全部状态</option>
            {STAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STAGE_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>

          <label className="inline-flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={hidePublished}
              onChange={(e) => setHidePublished(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            隐藏已发布
          </label>
        </div>
      </Card>

      <div className="space-y-2.5" data-testid="search-results">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-slate-500">正在检索…</div>
        ) : !data || data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white py-12 text-center text-sm text-slate-500">
            没有找到匹配的任务
          </div>
        ) : (
          <>
            <div className="text-xs text-slate-500">共找到 {data.total} 条任务</div>
            {data.items.map((item) => {
              const wsColor =
                WORKSHEET_COLOR_STYLES[item.worksheetColor] ?? WORKSHEET_COLOR_STYLES.sky;
              return (
                <Link
                  key={item.taskId}
                  to={`/worksheets/${item.worksheetId}?taskId=${item.taskId}`}
                  data-testid={`search-result-${item.taskId}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                            wsColor.badge,
                          )}
                        >
                          <span className={cn('h-1.5 w-1.5 rounded-full', wsColor.dot)} />
                          {item.worksheetName}
                        </span>
                        {item.workName && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                            {item.workName}
                          </span>
                        )}
                        {item.publishStatus === 'published' && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                            {PUBLISH_STATUS_LABELS.published}
                          </span>
                        )}
                      </div>

                      <div className="text-sm font-semibold text-slate-900">{item.taskTitle}</div>
                      {item.divisionNote && (
                        <div className="text-xs text-slate-600">{item.divisionNote}</div>
                      )}

                      {item.stages.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {item.stages.map((st) => (
                            <span
                              key={st.columnId}
                              className={cn(
                                'rounded px-2 py-0.5 text-xs',
                                STAGE_STATUS_STYLES[st.status].badge,
                              )}
                            >
                              {st.name}：
                              {st.assigneeNames.length > 0
                                ? `${st.assigneeNames.join('、')} · `
                                : ''}
                              {STAGE_STATUS_LABELS[st.status]}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                  </div>
                </Link>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
