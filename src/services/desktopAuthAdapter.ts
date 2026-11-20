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
};
