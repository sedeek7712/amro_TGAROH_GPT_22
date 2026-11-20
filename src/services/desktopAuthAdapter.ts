/**
 * Typed adapter for the trusted Electron authentication bridge.
 *
 * This module deliberately does not fall back to browser/Dexie authentication.
 * Web/PWA callers must continue using their existing auth provider explicitly.
 */
type DesktopBridge = NonNullable<Window['amroDesktop']>;

export const desktopAuthAdapter = {
  isAvailable(): boolean {
    return typeof window !== 'undefined' && Boolean(window.amroDesktop);
  },

  requireBridge(): DesktopBridge {
    const bridge = typeof window !== 'undefined' ? window.amroDesktop : undefined;
    if (!bridge) {
      throw new Error('مصادقة Windows غير متاحة في بيئة المتصفح.');
    }
    return bridge;
  },

  getSetupStatus() {
    return this.requireBridge().getAuthSetupStatus();
  },

  createInitialAdmin(input: {
    username: string;
    fullName: string;
    password: string;
  }) {
    return this.requireBridge().createInitialAdmin(input);
  },

  login(input: { username: string; password: string }) {
    return this.requireBridge().login(input);
  },

  getCurrentActor(input: { token: string; branchId?: string }) {
    return this.requireBridge().getCurrentActor(input);
  },

  completeMandatoryPasswordChange(input: {
    token: string;
    newPassword: string;
  }) {
    return this.requireBridge().completeMandatoryPasswordChange(input);
  },

  logout(token: string) {
    return this.requireBridge().logout(token);
  },
};
