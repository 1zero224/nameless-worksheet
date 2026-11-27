import {
  type Assignee,
  buildStageAssigneeOptions,
  normalizeText,
  resolveTypedAssignee,
  type StageAssigneeStatsResponse,
  type UserListItem,
} from '@nw/shared';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/api/client.js';
import { queryKeys } from '@/api/keys.js';
import { useMe } from '@/app/AuthContext.js';
import { Button, cn, Input } from '@/components/ui/primitives.js';

export function useStageAssigneeStats(enabled = true) {
  return useQuery<StageAssigneeStatsResponse>({
    queryKey: queryKeys.stageAssigneeStats,
    queryFn: () => apiFetch<StageAssigneeStatsResponse>('/api/stages/assignee-stats'),
    staleTime: 30_000,
    enabled,
  });
}

function isAssigneeSelected(assignees: readonly Assignee[], target: Assignee): boolean {
  if (target.type === 'user') {
    return assignees.some((a) => a.type === 'user' && a.userId === target.userId);
  }
  return assignees.some((a) => a.type === 'text' && a.name === target.name);
}

export function StageAssigneeInput({
  columnName,
  assignees,
  users,
  onToggleAssignee,
  onAddAssignee,
  placeholder = '输入或选择负责人（回车添加）',
  showCheckIcon = false,
}: {
  columnName: string;
  assignees: readonly Assignee[];
  users: readonly UserListItem[];
  onToggleAssignee: (assignee: Assignee) => void;
  onAddAssignee: (assignee: Assignee) => void;
  placeholder?: string;
  showCheckIcon?: boolean;
}) {
  const [textInput, setTextInput] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { data: me } = useMe();
  const { data: statsData } = useStageAssigneeStats(true);

  const stageStats = statsData?.byStageName[normalizeText(columnName)];
  const options = useMemo(
    () =>
      buildStageAssigneeOptions({
        users,
        currentUserId: me?.user.id,
        stageStats,
        filterText: textInput,
      }),
    [users, me?.user.id, stageStats, textInput],
  );

  const handleAdd = () => {
    const resolved = resolveTypedAssignee(textInput, users);
    if (!resolved) return;
    onAddAssignee(resolved);
    setTextInput('');
  };

  const trimmed = normalizeText(textInput);

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          data-testid="stage-assignee-input"
          value={textInput}
          onChange={(e) => {
            setTextInput(e.target.value);
            if (!menuOpen) setMenuOpen(true);
          }}
          onFocus={() => setMenuOpen(true)}
          onBlur={() => setMenuOpen(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            } else if (e.key === 'Escape' && menuOpen) {
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen(false);
            }
          }}
          placeholder={placeholder}
          className="h-7 min-w-0 flex-1 py-1 text-xs"
          maxLength={32}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 shrink-0 whitespace-nowrap px-2.5 text-xs"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleAdd}
        >
          添加
        </Button>
      </div>

      {menuOpen && (
        <div
          role="listbox"
          aria-label="选择负责人"
          data-testid="stage-assignee-menu"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute right-0 left-0 top-full z-50 mt-1.5 rounded-lg border border-black/[0.1] bg-white p-2 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.16),0_2px_6px_-2px_rgba(0,0,0,0.06)]"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
            <span>选择负责人</span>
            <span className="truncate">按「{columnName}」频次排序</span>
          </div>

          {options.length > 0 ? (
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {options.map((opt) => {
                const active = isAssigneeSelected(assignees, opt.assignee);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    data-testid={
                      opt.assignee.type === 'user'
                        ? `assignee-option-user-${opt.assignee.userId}`
                        : `assignee-option-text-${opt.label}`
                    }
                    data-assignee-label={opt.label}
                    data-assignee-count={opt.count}
                    data-current-user={opt.isCurrentUser ? 'true' : 'false'}
                    onClick={() => onToggleAssignee(opt.assignee)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors cursor-pointer',
                      active
                        ? 'border-zinc-900 bg-zinc-900 text-white'
                        : 'border-black/[0.1] bg-white text-zinc-700 hover:bg-black/[0.04]',
                    )}
                  >
                    {showCheckIcon && active && <Check className="h-3 w-3 shrink-0" />}
                    <span>{opt.label}</span>
                    {opt.isCurrentUser && (
                      <span
                        aria-hidden="true"
                        className={cn('text-[10px]', active ? 'text-zinc-300' : 'text-zinc-400')}
                      >
                        我
                      </span>
                    )}
                    {opt.count > 0 && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'text-[10px] tabular-nums',
                          active ? 'text-zinc-300' : 'text-zinc-400',
                        )}
                      >
                        {opt.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="py-1 text-xs text-zinc-400">
              {trimmed ? (
                <button
                  type="button"
                  onClick={handleAdd}
                  className="w-full rounded-md px-1.5 py-1 text-left text-zinc-600 hover:bg-black/[0.04] cursor-pointer"
                >
                  添加纯文本负责人「{trimmed}」
                </button>
              ) : (
                <span>暂无可选用户，直接输入名字回车添加</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
