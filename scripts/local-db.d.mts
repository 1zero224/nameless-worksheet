export const LOCAL_ADMIN_URL: string;
export const LOCAL_DB: {
  dataDir: string;
  port: number;
  user: string;
  password: string;
};
export function isRunning(): boolean;
export function startLocalDb(): void;
export function stopLocalDb(): void;
