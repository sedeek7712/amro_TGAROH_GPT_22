import { useEffect, useState } from 'react';
import { OFFICIAL_ACTIVITIES, storage } from '../services/storageService';
import { desktopSession } from '../services/desktopSession';
import { authService } from '../services/authService';
import { useLiveBranches } from './useLiveDexie';
import type { Branch, CommercialActivity, CompanyProfile, SystemUser } from '../types/erp';
import { resolveEnterpriseDocumentMeta, type ResolvedDocumentHeader } from '../utils/documentBranding';

export function useDocumentContext() {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.amroDesktop);
  const branches = useLiveBranches();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (isDesktop) {
      return desktopSession.subscribe(() => setVersion((v) => v + 1));
    }
    const onStorage = () => setVersion((v) => v + 1);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isDesktop]);

  void version;

  const profile: CompanyProfile | null = isDesktop
    ? desktopSession.getCompanyProfile()
    : storage.getCompanyProfile();

  const activities: CommercialActivity[] = isDesktop
    ? desktopSession.getActivitiesSnapshot().length > 0
      ? desktopSession.getActivitiesSnapshot()
      : OFFICIAL_ACTIVITIES
    : storage.getActivities();

  const actor: SystemUser | null =
    authService.getCurrentActorSync() || (isDesktop ? null : storage.getCurrentUser());

  const activeBranchId = isDesktop
    ? desktopSession.getActiveBranchId() || actor?.branchId || branches[0]?.id || 'branch_main'
    : storage.getActiveBranchId();

  const activeBranch: Branch | null =
    branches.find((b) => b.id === activeBranchId) ||
    branches[0] ||
    (isDesktop ? desktopSession.getActiveBranch() : storage.getActiveBranch()) ||
    null;

  const resolveMeta = (overrides?: {
    branchId?: string;
    branch?: Branch | null;
    activityId?: string;
    activity?: CommercialActivity | null;
    issuerName?: string;
  }): ResolvedDocumentHeader =>
    resolveEnterpriseDocumentMeta({
      profile,
      branch: overrides?.branch ?? (overrides?.branchId ? undefined : activeBranch),
      branches,
      branchId: overrides?.branchId || activeBranch?.id,
      activity: overrides?.activity,
      activities,
      activityId: overrides?.activityId,
      issuerName: overrides?.issuerName ?? actor?.fullName,
    });

  return {
    isDesktop,
    profile,
    branches,
    activeBranch,
    activities,
    actor,
    resolveMeta,
  };
}
