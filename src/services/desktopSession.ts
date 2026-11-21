import type { Branch, CommercialActivity, CompanyProfile, SystemUser } from '../types/erp';
import { setDesktopCurrencyOverride } from '../config/currency';

type DesktopListener = (domains: string[]) => void;

interface DesktopSessionState {
  token: string | null;
  actor: SystemUser | null;
  activeBranchId: string | null;
  terminalCode: string;
  companyProfile: CompanyProfile | null;
  activities: CommercialActivity[];
  branches: Branch[];
  version: number;
}

const state: DesktopSessionState = {
  token: null,
  actor: null,
  activeBranchId: null,
  terminalCode: 'POS01',
  companyProfile: null,
  activities: [],
  branches: [],
  version: 0,
};

const listeners = new Set<DesktopListener>();
let bridgeUnsubscribe: (() => void) | null = null;

function ensureBridgeListener(): void {
  if (bridgeUnsubscribe) return;
  if (typeof window !== 'undefined' && window.amroDesktop?.onDataChanged) {
    bridgeUnsubscribe = window.amroDesktop.onDataChanged((domains) => {
      notifyListeners(domains);
    });
  }
}

function notifyListeners(domains: string[]): void {
  state.version += 1;
  for (const listener of listeners) {
    try {
      listener(domains);
    } catch (err) {
      console.warn('[desktopSession] listener notice:', err);
    }
  }
}

function normalizeCompanyCurrency(profile: CompanyProfile | null): void {
  if (!profile) {
    setDesktopCurrencyOverride(null);
    return;
  }
  setDesktopCurrencyOverride({
    code: profile.currencyCode || 'SAR',
    nameAr: profile.currency || 'ريال سعودي',
    symbol: profile.currencySymbol || 'ر.س',
    decimalPlaces:
      typeof profile.currencyDecimalPlaces === 'number' ? profile.currencyDecimalPlaces : 2,
    roundingMode: 'HALF_UP',
  });
}

export const desktopSession = {
  getToken(): string | null {
    return state.token;
  },

  requireToken(): string {
    if (!state.token) {
      throw new Error('انتهت جلسة Windows أو لم يتم تسجيل الدخول بعد.');
    }
    return state.token;
  },

  getActor(): SystemUser | null {
    return state.actor;
  },

  getActiveBranchId(): string | null {
    return state.activeBranchId || state.actor?.branchId || null;
  },

  getActiveBranch(): Branch | null {
    const id = this.getActiveBranchId();
    if (!id) return state.branches[0] || null;
    return state.branches.find((b) => b.id === id) || state.branches[0] || null;
  },

  getBranchesSnapshot(): Branch[] {
    return state.branches;
  },

  getTerminalCode(): string {
    return state.terminalCode || 'POS01';
  },

  getCompanyProfile(): CompanyProfile | null {
    return state.companyProfile;
  },

  getActivitiesSnapshot(): CommercialActivity[] {
    return state.activities;
  },

  getVersion(): number {
    return state.version;
  },

  setActorSession(token: string, actor: SystemUser): void {
    ensureBridgeListener();
    state.token = token;
    state.actor = actor;
    state.activeBranchId = actor.branchId || null;
    notifyListeners(['session']);
  },

  async hydrate(token: string, actor: SystemUser): Promise<void> {
    const bridge = typeof window !== 'undefined' ? window.amroDesktop : undefined;
    if (!bridge) {
      throw new Error('واجهة Electron غير متاحة.');
    }
    ensureBridgeListener();
    state.token = token;
    state.actor = actor;

    const [activeBranchId, terminalCode, companyProfile, activities, branches] = await Promise.all([
      bridge.getActiveBranchId({ token }).catch(() => actor.branchId),
      bridge.getTerminalCode({ token }).catch(() => 'POS01'),
      bridge.getCompanyProfile({ token }).catch(() => null),
      bridge.getActivities({ token }).catch(() => []),
      bridge.getBranches({ token }).catch(() => []),
    ]);

    state.activeBranchId = activeBranchId || actor.branchId || null;
    state.terminalCode = terminalCode || 'POS01';
    state.companyProfile = companyProfile;
    state.activities = activities;
    state.branches = branches;
    normalizeCompanyCurrency(companyProfile);
    notifyListeners(['session', 'settings', 'branches', 'activities']);
  },

  setActiveBranchLocal(branchId: string): void {
    state.activeBranchId = branchId;
    if (state.actor) {
      state.actor = { ...state.actor, branchId };
    }
    notifyListeners(['branches', 'session']);
  },

  setTerminalCodeLocal(terminalCode: string): void {
    state.terminalCode = terminalCode;
    notifyListeners(['settings']);
  },

  setCompanyProfileLocal(profile: CompanyProfile): void {
    state.companyProfile = profile;
    normalizeCompanyCurrency(profile);
    notifyListeners(['settings']);
  },

  setBranchesLocal(branches: Branch[]): void {
    state.branches = branches;
    notifyListeners(['branches']);
  },

  notifyChanged(domains: string[] = ['all']): void {
    notifyListeners(domains);
  },

  clear(): void {
    state.token = null;
    state.actor = null;
    state.activeBranchId = null;
    state.terminalCode = 'POS01';
    state.companyProfile = null;
    state.activities = [];
    state.branches = [];
    setDesktopCurrencyOverride(null);
    notifyListeners(['session']);
  },

  subscribe(listener: DesktopListener): () => void {
    ensureBridgeListener();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
