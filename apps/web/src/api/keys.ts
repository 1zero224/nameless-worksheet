export const queryKeys = {
  me: ['auth', 'me'] as const,
  users: ['users'] as const,
  invites: ['invites'] as const,
  invitePreview: (token: string) => ['invites', 'preview', token] as const,
  resetPreview: (token: string) => ['password-resets', 'preview', token] as const,
  boardColumns: ['board-columns'] as const,
  worksheets: ['worksheets'] as const,
  worksheet: (id: string) => ['worksheets', id] as const,
  changeLogs: (worksheetId: string, taskId?: string | null) =>
    ['change-logs', worksheetId, taskId ?? 'all'] as const,
  board: ['board'] as const,
  myTasks: ['my-tasks'] as const,
  search: (params: Record<string, string>) => ['search', params] as const,
};
