export {};

interface DesktopSafeUser {
  id: string;
  tenantId: string;
  username: string;
  fullName: string;
  role: 'ADMIN' | 'ACCOUNTANT' | 'CASHIER' | 'INVENTORY_KEEPER';
  branchId: string;
  allowedBranches: string[];
  allowedActivities: string[];
  active: boolean;
  mustChangePassword?: boolean;
  failedLoginAttempts?: number;
}

interface DesktopAuthResult {
  success: boolean;
  token?: string;
  expiresAt?: string;
  user?: DesktopSafeUser;
  mustChangePassword?: boolean;
  error?: string;
  lockedUntil?: string;
}

declare global {
  interface Window {
    readonly amroDesktop?: {
      getRuntimeStatus(): Promise<{
        ready: boolean;
        databaseFile: string;
        schemaVersion: number;
        sqliteVersion: string;
      }>;
      getAuthSetupStatus(): Promise<{ setupRequired: boolean; userCount: number }>;
      createInitialAdmin(input: {
        username: string;
        fullName: string;
        password: string;
      }): Promise<{ success: boolean; user: DesktopSafeUser }>;
      login(input: { username: string; password: string }): Promise<DesktopAuthResult>;
      getCurrentActor(input: { token: string; branchId?: string }): Promise<DesktopSafeUser | null>;
      logout(token: string): Promise<{ success: boolean }>;
      completeMandatoryPasswordChange(input: {
        token: string;
        newPassword: string;
      }): Promise<DesktopAuthResult>;
    };
  }
}
