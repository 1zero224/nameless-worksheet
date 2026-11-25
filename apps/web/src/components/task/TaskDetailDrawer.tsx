import {
  type Assignee,
  type ChangeLogsResponse,
  getEffectiveStageCell,
  PRIORITIES,
  PRIORITY_LABELS,
  PUBLISH_STATUS_LABELS,
  PUBLISH_STATUSES,
  STAGE_STATUS_LABELS,
  STAGE_STATUSES,
  type StageCell,
  type StageStatus,
  type TaskDetail,
  type UserListItem,
  type WorksheetFullResponse,
} from '@nw/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  History,
  MapPin,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { STAGE_STATUS_STYLES, WORKSHEET_COLOR_STYLES } from '@/components/ui/colors.js';
import { Sheet, useToast } from '@/components/ui/overlays.js';
import { Button, cn, Input, Label, Select } from '@/components/ui/primitives.js';

export function TaskDetailDrawer({
  worksheetId,
  taskId,
  open,
  onClose,
  showLocateButton = true,
}: {
  worksheetId: string | null;
  taskId: string | null;
  open: boolean;
  onClose: () => void;
  showLocateButton?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [logsExpanded, setLogsExpanded] = useState(false);

  const { data: wsData, isLoading } = useQuery<WorksheetFullResponse>({
    queryKey: worksheetId ? queryKeys.worksheet(worksheetId) : ['worksheets', 'none'],
    queryFn: () => apiFetch<WorksheetFullResponse>(`/api/worksheets/${worksheetId}`),
    enabled: Boolean(open && worksheetId),
  });

  const { data: users = [] } = useQuery<UserListItem[]>({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserListItem[]>('/api/users'),
    enabled: open,
  });

  const { data: taskLogs } = useQuery<ChangeLogsResponse>({
    queryKey:
      worksheetId && taskId ? queryKeys.changeLogs(worksheetId, taskId) : ['change-logs', 'none'],
    queryFn: () =>
      apiFetch<ChangeLogsResponse>(
        `/api/worksheets/${worksheetId}/change-logs?taskId=${taskId}&limit=30`,
      ),
    enabled: Boolean(open && worksheetId && taskId && logsExpanded),
  });

  const task = wsData?.tasks.find((t) => t.id === taskId) ?? null;
  const userMap = new Map(users.map((u) => [u.id, u.displayName]));

  // 本地表单态同步
  const [title, setTitle] = useState('');
  const [workNameInput, setWorkNameInput] = useState('');
  const [divisionNote, setDivisionNote] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [publishUrl, setPublishUrl] = useState('');
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!task || !wsData) return;
    setTitle(task.title);
    const w = task.workId ? wsData.works.find((x) => x.id === task.workId) : null;
    setWorkNameInput(w?.name ?? '');
    setDivisionNote(task.divisionNote);
    setPublishedAt(task.publishedAt ?? '');
    setPublishUrl(task.publishUrl ?? '');
    const nextCustom: Record<string, string> = {};
    for (const c of wsData.columns) {
      if (c.type !== 'stage') {
        nextCustom[c.id] = task.customValues[c.id] ?? '';
      }
    }
    setCustomDrafts(nextCustom);
  }, [task, wsData]);

  const invalidateAll = () => {
    if (worksheetId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worksheet(worksheetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.changeLogs(worksheetId, taskId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.changeLogs(worksheetId, null) });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.board });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worksheets });
  };

  const patchTaskMutation = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      apiFetch<TaskDetail>(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: { changes, force: true },
      }),
    onSuccess: () => {
      invalidateAll();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '保存失败',
        variant: 'error',
      });
    },
  });

  const patchStageMutation = useMutation({
    mutationFn: ({
      columnId,
      body,
    }: {
      columnId: string;
      body: { assignees?: Assignee[]; status?: StageStatus; note?: string; baseRevision: number };
    }) =>
      apiFetch<{ cell: StageCell }>(`/api/tasks/${taskId}/stages/${columnId}`, {
        method: 'PATCH',
        body: { ...body, force: true },
      }),
    onSuccess: () => {
      invalidateAll();
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '更新工序失败',
        variant: 'error',
      });
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: () => apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' }),
    onSuccess: () => {
      const deletedId = taskId;
      onClose();
      invalidateAll();
      pushToast({
        message: `已删除任务「${task?.title ?? ''}」`,
        variant: 'info',
        actionLabel: '撤销',
        onAction: async () => {
          if (!deletedId) return;
          await apiFetch(`/api/tasks/${deletedId}/restore`, { method: 'POST' });
          invalidateAll();
          pushToast({ message: '任务已恢复', variant: 'success' });
        },
      });
    },
    onError: (err) => {
      pushToast({
        message: err instanceof ApiError ? err.message : '删除失败',
        variant: 'error',
      });
    },
  });

  const stageCols = wsData?.columns.filter((c) => c.type === 'stage') ?? [];
  const customCols = wsData?.columns.filter((c) => c.type !== 'stage') ?? [];
  const wsColor = wsData
    ? (WORKSHEET_COLOR_STYLES[wsData.worksheet.color] ?? WORKSHEET_COLOR_STYLES.sky)
    : WORKSHEET_COLOR_STYLES.sky;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="任务详情"
      headerActions={
        showLocateButton && worksheetId && taskId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              onClose();
              navigate(`/worksheets/${worksheetId}?taskId=${taskId}`);
            }}
          >
            <MapPin className="mr-1 h-3.5 w-3.5" />
            在工作表中定位
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="py-10 text-center text-sm text-slate-500">正在加载任务…</div>
      ) : !task || !wsData ? (
        <div className="py-10 text-center text-sm text-slate-500">任务不存在或已被删除</div>
      ) : (
        <div className="space-y-5" data-testid="task-detail-drawer">
          {/* 所属工作表标签 */}
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                wsColor.badge,
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', wsColor.dot)} />
              {wsData.worksheet.name}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={() => deleteTaskMutation.mutate()}
              disabled={deleteTaskMutation.isPending}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              删除任务
            </Button>
          </div>

          {/* 标题 */}
          <div>
            <Label htmlFor="detail-title">标题</Label>
            <Input
              id="detail-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (title.trim() && title.trim() !== task.title) {
                  patchTaskMutation.mutate({ title: title.trim() });
                }
              }}
              maxLength={200}
            />
          </div>

          {/* 所属作品 + 优先级 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="detail-work">所属作品</Label>
              <Input
                id="detail-work"
                list="detail-works-datalist"
                value={workNameInput}
                onChange={(e) => setWorkNameInput(e.target.value)}
                onBlur={() => {
                  const trimmed = workNameInput.trim();
                  const curWork = task.workId
                    ? wsData.works.find((x) => x.id === task.workId)
                    : null;
                  if (trimmed !== (curWork?.name ?? '')) {
                    patchTaskMutation.mutate({ workName: trimmed || null });
                  }
                }}
                placeholder="输入或选择作品名"
                maxLength={80}
              />
              <datalist id="detail-works-datalist">
                {wsData.works.map((w) => (
                  <option key={w.id} value={w.name} />
                ))}
              </datalist>
            </div>
            <div>
              <Label htmlFor="detail-priority">优先级</Label>
              <Select
                id="detail-priority"
                value={task.priority}
                onChange={(e) => patchTaskMutation.mutate({ priority: e.target.value })}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {/* 分工说明 */}
          <div>
            <Label htmlFor="detail-division">分工说明</Label>
            <Input
              id="detail-division"
              value={divisionNote}
              onChange={(e) => setDivisionNote(e.target.value)}
              onBlur={() => {
                if (divisionNote.trim() !== task.divisionNote) {
                  patchTaskMutation.mutate({ divisionNote: divisionNote.trim() });
                }
              }}
              placeholder="例如：P1 00:00–13:00"
              maxLength={500}
            />
          </div>

          {/* 发布信息 */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 space-y-2.5">
            <div className="text-xs font-semibold text-slate-700">发布信息</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="detail-publish-status" className="text-xs">
                  发布状态
                </Label>
                <Select
                  id="detail-publish-status"
                  value={task.publishStatus}
                  onChange={(e) => patchTaskMutation.mutate({ publishStatus: e.target.value })}
                >
                  {PUBLISH_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {PUBLISH_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="detail-published-at" className="text-xs">
                  发布日期
                </Label>
                <Input
                  id="detail-published-at"
                  type="date"
                  value={publishedAt}
                  onChange={(e) => {
                    setPublishedAt(e.target.value);
                    patchTaskMutation.mutate({ publishedAt: e.target.value || null });
                  }}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="detail-publish-url" className="text-xs">
                发布链接
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="detail-publish-url"
                  type="url"
                  value={publishUrl}
                  onChange={(e) => setPublishUrl(e.target.value)}
                  onBlur={() => {
                    if ((publishUrl.trim() || null) !== task.publishUrl) {
                      patchTaskMutation.mutate({ publishUrl: publishUrl.trim() || null });
                    }
                  }}
                  placeholder="https://..."
                />
                {task.publishUrl && (
                  <a
                    href={task.publishUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="打开外链"
                    className="rounded-md border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* 工序卡片 */}
          {stageCols.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-700">工序与分工</div>
              {stageCols.map((col) => {
                const cell = getEffectiveStageCell(task, col.id);
                return (
                  <DetailStageCard
                    key={col.id}
                    columnName={col.name}
                    cell={cell}
                    users={users}
                    userMap={userMap}
                    onSave={(next) =>
                      patchStageMutation.mutate({
                        columnId: col.id,
                        body: { ...next, baseRevision: cell.revision },
                      })
                    }
                  />
                );
              })}
            </div>
          )}

          {/* 自定义列 */}
          {customCols.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-700">自定义字段</div>
              {customCols.map((col) => {
                const val = customDrafts[col.id] ?? '';
                return (
                  <div key={col.id}>
                    <Label htmlFor={`detail-custom-${col.id}`} className="text-xs">
                      {col.name}
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id={`detail-custom-${col.id}`}
                        type={col.type === 'date' ? 'date' : col.type === 'link' ? 'url' : 'text'}
                        value={val}
                        onChange={(e) => {
                          const next = e.target.value;
                          setCustomDrafts((prev) => ({ ...prev, [col.id]: next }));
                          if (col.type === 'date') {
                            patchTaskMutation.mutate({
                              customValues: { [col.id]: next || null },
                            });
                          }
                        }}
                        onBlur={() => {
                          if (col.type === 'date') return;
                          const cur = task.customValues[col.id] ?? '';
                          if (val.trim() !== cur) {
                            patchTaskMutation.mutate({
                              customValues: { [col.id]: val.trim() || null },
                            });
                          }
                        }}
                        placeholder={col.type === 'link' ? 'https://...' : '填写内容'}
                      />
                      {col.type === 'link' && task.customValues[col.id] && (
                        <a
                          href={task.customValues[col.id] ?? '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
                          aria-label={`打开 ${col.name} 链接`}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 文件区占位（阶段 3 启用） */}
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/50 p-4 text-center">
            <FolderOpen className="mx-auto h-5 w-5 text-slate-400" />
            <div className="mt-1.5 text-sm font-medium text-slate-700">任务文件</div>
            <p className="mt-0.5 text-xs text-slate-500">任务文件与网盘入口将在阶段 3 启用</p>
          </div>

          {/* 本任务修改记录 */}
          <div className="border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={() => setLogsExpanded((v) => !v)}
              className="flex w-full items-center justify-between text-left text-xs font-semibold text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" />
                本任务修改记录
              </span>
              {logsExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {logsExpanded && (
              <div className="mt-2.5 space-y-2">
                {!taskLogs ? (
                  <p className="text-xs text-slate-500">加载中…</p>
                ) : taskLogs.items.length === 0 ? (
                  <p className="text-xs text-slate-500">暂无修改记录</p>
                ) : (
                  taskLogs.items.map((item) => (
                    <div
                      key={item.id}
                      className="rounded border border-slate-200 bg-slate-50/60 p-2 text-xs"
                    >
                      <div className="flex items-center justify-between text-slate-500">
                        <span className="font-medium text-slate-700">{item.actor.displayName}</span>
                        <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                      </div>
                      <div className="mt-1 text-slate-800">{item.summary}</div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function DetailStageCard({
  columnName,
  cell,
  users,
  userMap,
  onSave,
}: {
  columnName: string;
  cell: StageCell;
  users: UserListItem[];
  userMap: Map<string, string>;
  onSave: (next: { assignees?: Assignee[]; status?: StageStatus; note?: string }) => void;
}) {
  const [note, setNote] = useState(cell.note);
  const [textName, setTextName] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setNote(cell.note);
  }, [cell.note]);

  const statusStyle = STAGE_STATUS_STYLES[cell.status];

  const toggleUser = (userId: string) => {
    const exists = cell.assignees.some((a) => a.type === 'user' && a.userId === userId);
    const next = exists
      ? cell.assignees.filter((a) => !(a.type === 'user' && a.userId === userId))
      : [...cell.assignees, { type: 'user' as const, userId }];
    onSave({ assignees: next });
  };

  const addTextAssignee = () => {
    const name = textName.trim();
    if (!name) return;
    if (!cell.assignees.some((a) => a.type === 'text' && a.name === name)) {
      onSave({ assignees: [...cell.assignees, { type: 'text', name }] });
    }
    setTextName('');
  };

  const removeAssignee = (idx: number) => {
    const next = cell.assignees.filter((_, i) => i !== idx);
    onSave({ assignees: next });
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{columnName}</span>
        <select
          aria-label={`${columnName} 状态`}
          value={cell.status}
          onChange={(e) => onSave({ status: e.target.value as StageStatus })}
          className={cn(
            'rounded-md border px-2 py-1 text-xs font-medium outline-none cursor-pointer',
            statusStyle.cell,
          )}
        >
          {STAGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STAGE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {/* 负责人芯片 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {cell.assignees.length === 0 ? (
          <span className="text-xs text-slate-400">暂无负责人</span>
        ) : (
          cell.assignees.map((a, idx) => {
            const label = a.type === 'user' ? (userMap.get(a.userId) ?? '未知用户') : a.name;
            const key = a.type === 'user' ? `u:${a.userId}` : `t:${a.name}`;
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
              >
                {label}
                {a.type === 'text' && <span className="text-[10px] text-slate-400">文本</span>}
                <button
                  type="button"
                  onClick={() => removeAssignee(idx)}
                  aria-label={`移除负责人 ${label}`}
                  className="text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })
        )}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:border-slate-500 cursor-pointer"
        >
          <Plus className="h-3 w-3" />
          负责人
        </button>
      </div>

      {pickerOpen && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-2 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {users.map((u) => {
              const checked = cell.assignees.some((a) => a.type === 'user' && a.userId === u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggleUser(u.id)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs cursor-pointer',
                    checked
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
                  )}
                >
                  {u.displayName}
                </button>
              );
            })}
          </div>
          <div className="flex gap-1.5">
            <Input
              value={textName}
              onChange={(e) => setTextName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTextAssignee();
                }
              }}
              placeholder="输入纯文本名字回车添加"
              className="h-7 py-1 text-xs"
              maxLength={32}
            />
            <Button type="button" size="sm" variant="secondary" onClick={addTextAssignee}>
              添加
            </Button>
          </div>
        </div>
      )}

      {/* 备注 */}
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note.trim() !== cell.note) {
            onSave({ note: note.trim() });
          }
        }}
        placeholder="工序备注（如初校/终校说明）"
        className="h-7 py-1 text-xs"
        maxLength={200}
      />
    </div>
  );
}
