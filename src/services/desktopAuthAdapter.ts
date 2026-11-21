import type { CommercialActivityId, SystemUser } from '../types/erp';

/**
 * Typed adapter for the trusted Electron authentication bridge.
 * No browser/Dexie fallback is permitted from this provider.
 */
type DesktopBridge = NonNullable<Window['amroDesktop']>;

function requireBridge(): DesktopBridge {
  const bridge = typeof window !== 'undefined' ? window.amroDesktop : undefined;
  if (!bridge) throw new Error('مصادقة Windows غير متاحة في بيئة المتصفح.');
  return bridge;
}

export const desktopAuthAdapter = {
  isAvailable(): boolean {
    return typeof window !== 'undefined' && Boolean(window.amroDesktop);
  },
  getSetupStatus() {
    return requireBridge().getAuthSetupStatus();
  },
  createInitialAdmin(input: { username: string; fullName: string; password: string }) {
    return requireBridge().createInitialAdmin(input);
  },
  login(input: { username: string; password: string }) {
    return requireBridge().login(input);
  },
  getCurrentActor(input: { token: string; branchId?: string }) {
    return requireBridge().getCurrentActor(input);
  },
  completeMandatoryPasswordChange(input: { token: string; newPassword: string }) {
    return requireBridge().completeMandatoryPasswordChange(input);
  },
  logout(token: string) {
    return requireBridge().logout(token);
  },
  previewLegacyBackup(rawJson: string, token?: string) {
    return requireBridge().previewLegacyBackup({ rawJson, token });
  },
  importLegacyBackup(rawJson: string, token?: string) {
    return requireBridge().importLegacyBackup({ rawJson, token });
  },
  createUser(
    token: string,
    input: {
      username: string;
      fullName: string;
      role: SystemUser['role'];
      allowedActivities: CommercialActivityId[];
      branchId: string;
      allowedBranches?: string[];
      plainPassword: string;
      mustChangePassword?: boolean;
    }
  ) {
    return requireBridge().createUser({ token, input });
  },
  saveUserProfile(token: string, user: SystemUser) {
    return requireBridge().saveUserProfile({ token, user });
  },
  adminResetPassword(token: string, targetUserId: string, newPassword: string) {
    return requireBridge().adminResetPassword({ token, targetUserId, newPassword });
  },
  switchUser(token: string, adminPassword: string, targetUserId: string) {
    return requireBridge().switchUser({ token, adminPassword, targetUserId });
  },
};
