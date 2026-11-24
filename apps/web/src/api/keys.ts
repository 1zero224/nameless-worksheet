export const queryKeys = {
  me: ['auth', 'me'] as const,
  users: ['users'] as const,
  invites: ['invites'] as const,
  invitePreview: (token: string) => ['invites', 'preview', token] as const,
  resetPreview: (token: string) => ['password-resets', 'preview', token] as const,
};
