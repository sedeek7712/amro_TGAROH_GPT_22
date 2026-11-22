/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * المصدر الموحد لمصفوفة الصلاحيات والتحقق الأمني (RBAC Matrix & Server/Service Guard)
 * يعالج SEC-02, SEC-03, SEC-04, BR-01, BR-03, BR-04, RBAC-08:
 * - صلاحيات دقيقة منفصلة للقراءة والتشغيل والإدارة والنسخ الاحتياطي.
 * - تصنيف صريح للكيانات المشتركة على مستوى المؤسسة مقابل الكيانات المعزولة حسب الفرع.
 * - فرض عزل الفروع بصرامة دون تجاوز أو قبول فروع/مؤسسات فارغة.
 */

import { SystemAuditLog, SystemUser, UserRole } from '../types/erp';

export type ActiveView =
  | 'dashboard'
  | 'pos'
  | 'inventory'
  | 'purchases'
  | 'amanat'
  | 'accounting'
  | 'parties'
  | 'cash'
  | 'reports'
  | 'users'
  | 'settings'
  | 'sync';

export type Permission =
  | 'view:dashboard'
  | 'view:reports'
  | 'view:profits'
  | 'view:accounting'
  | 'view:audit_logs'
  | 'pos:sale'
  | 'pos:return'
  | 'invoices:view'
  | 'purchase:create'
  | 'purchase:return'
  | 'inventory:view'
  | 'inventory:write'
  | 'inventory:adjust'
  | 'inventory:delete'
  | 'party:view'
  | 'party:write'
  | 'vouchers:view'
  | 'voucher:receipt'
  | 'voucher:payment'
  | 'voucher:cancel'
  | 'voucher:reverse'
  | 'payment:allocation:override'
  | 'party:advance:use'
  | 'supplier:advance:approve'
  | 'audit:allocation:view'
  | 'cashbox:view'
  | 'cashbox:create'
  | 'cashbox:central_access'
  | 'amanat:view'
  | 'amanat:manage'
  | 'journal:post'
  | 'journal:reverse'
  | 'accounting:adjust'
  | 'account:create'
  | 'users:read'
  | 'users:manage'
  | 'branches:view'
  | 'branches:manage'
  | 'settings:manage'
  | 'sync:manage'
  | 'backup:export'
  | 'backup:restore'
  | 'backup:manage';

export type EntityScopeClassification = 'TENANT_SHARED' | 'BRANCH_SCOPED';

export const ENTITY_SCOPE_POLICY = {
  TENANT_SHARED: ['Account', 'Product', 'Party', 'CommercialActivity', 'Branch'],
  BRANCH_SCOPED: [
    'CashBox',
    'Invoice',
    'JournalEntry',
    'PaymentVoucher',
    'PaymentAllocation',
    'PartyAdvanceTransaction',
    'AllocationAudit',
    'AmanatRecord',
    'SystemAuditLog',
    'OutboxQueueItem',
    'SyncConflict',
    'SystemUser',
  ],
} as const;

export const ROLE_ALLOWED_VIEWS: Record<UserRole, readonly ActiveView[]> = {
  ADMIN: [
    'dashboard',
    'pos',
    'inventory',
    'purchases',
    'amanat',
    'accounting',
    'parties',
    'cash',
    'reports',
    'users',
    'sync',
    'settings',
  ],
  ACCOUNTANT: [
    'dashboard',
    'pos',
    'inventory',
    'purchases',
    'amanat',
    'accounting',
    'parties',
    'cash',
    'reports',
    'sync',
  ],
  INVENTORY_KEEPER: ['dashboard', 'inventory', 'purchases'],
  CASHIER: ['dashboard', 'pos', 'inventory'],
};

const ALL_PERMISSIONS: Permission[] = [
  'view:dashboard',
  'view:reports',
  'view:profits',
  'view:accounting',
  'view:audit_logs',
  'pos:sale',
  'pos:return',
  'invoices:view',
  'purchase:create',
  'purchase:return',
  'inventory:view',
  'inventory:write',
  'inventory:adjust',
  'inventory:delete',
  'party:view',
  'party:write',
  'vouchers:view',
  'voucher:receipt',
  'voucher:payment',
  'voucher:cancel',
  'voucher:reverse',
  'payment:allocation:override',
  'party:advance:use',
  'supplier:advance:approve',
  'audit:allocation:view',
  'cashbox:view',
  'cashbox:create',
  'cashbox:central_access',
  'amanat:view',
  'amanat:manage',
  'journal:post',
  'journal:reverse',
  'accounting:adjust',
  'account:create',
  'users:read',
  'users:manage',
  'branches:view',
  'branches:manage',
  'settings:manage',
  'sync:manage',
  'backup:export',
  'backup:restore',
  'backup:manage',
];

export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  ADMIN: new Set<Permission>(ALL_PERMISSIONS),
  ACCOUNTANT: new Set<Permission>([
    'view:dashboard',
    'view:reports',
    'view:profits',
    'view:accounting',
    'view:audit_logs',
    'pos:sale',
    'pos:return',
    'invoices:view',
    'purchase:create',
    'purchase:return',
    'inventory:view',
    'inventory:write',
    'inventory:adjust',
    'party:view',
    'party:write',
    'vouchers:view',
    'voucher:receipt',
    'voucher:payment',
    'voucher:cancel',
    'voucher:reverse',
    'party:advance:use',
    'supplier:advance:approve',
    'audit:allocation:view',
    'cashbox:view',
    'cashbox:create',
    'amanat:view',
    'amanat:manage',
    'journal:post',
    'journal:reverse',
    'accounting:adjust',
    'account:create',
    'branches:view',
    'sync:manage',
  ]),
  INVENTORY_KEEPER: new Set<Permission>([
    'view:dashboard',
    'inventory:view',
    'inventory:write',
    'inventory:adjust',
    'purchase:create',
    'purchase:return',
    'invoices:view',
    'party:view',
    'cashbox:view',
    'branches:view',
  ]),
  CASHIER: new Set<Permission>([
    'view:dashboard',
    'pos:sale',
    'pos:return',
    'invoices:view',
    'inventory:view',
    'party:view',
    'cashbox:view',
    'branches:view',
  ]),
};

export class PermissionError extends Error {
  public readonly code = 'FORBIDDEN';
  public readonly requiredPermission: Permission | string;

  constructor(message: string, requiredPermission: Permission | string) {
    super(message);
    this.name = 'PermissionError';
    this.requiredPermission = requiredPermission;
  }
}

export function canAccessView(role: UserRole | undefined, view: ActiveView): boolean {
  if (!role || !(role in ROLE_ALLOWED_VIEWS)) return false;
  return ROLE_ALLOWED_VIEWS[role].includes(view);
}

export function hasPermission(
  user: Pick<SystemUser, 'role' | 'active'> | null | undefined,
  permission: Permission
): boolean {
  if (!user || !user.active) return false;
  const allowed = ROLE_PERMISSIONS[user.role];
  return allowed ? allowed.has(permission) : false;
}

export function assertPermission(
  user: Pick<SystemUser, 'id' | 'role' | 'active' | 'fullName'> | null | undefined,
  permission: Permission,
  actionLabel?: string
): void {
  if (!user || !user.active) {
    throw new PermissionError('حظر أمني: الجلسة غير مصادق عليها أو المستخدم موقوف.', permission);
  }
  if (!hasPermission(user, permission)) {
    throw new PermissionError(
      `حظر صلاحيات (RBAC): الدور (${user.role}) لا يملك صلاحية تنفيذ (${actionLabel || permission}).`,
      permission
    );
  }
}

export function getAuthorizedBranchIds(
  user: Pick<SystemUser, 'role' | 'branchId' | 'allowedBranches' | 'active'> | null | undefined
): Set<string> {
  if (!user || !user.active) return new Set();
  const ids = [
    ...(user.allowedBranches || []).map((b) => b.trim()).filter(Boolean),
    ...(user.branchId?.trim() ? [user.branchId.trim()] : []),
  ];
  return new Set(ids);
}

export function assertBranchAccess(
  user: Pick<SystemUser, 'role' | 'branchId' | 'allowedBranches' | 'active' | 'tenantId'> | null | undefined,
  targetBranchId?: string,
  options?: { requireTarget?: boolean }
): void {
  if (!user || !user.active) {
    throw new PermissionError('حظر أمني: الجلسة غير صالحة.', 'branch:access');
  }
  if (!user.tenantId || !user.tenantId.trim()) {
    throw new PermissionError('حظر أمني: المستخدم لا ينتمي إلى مؤسسة (tenantId) صالحة.', 'tenant:access');
  }

  const normalizedTarget = targetBranchId?.trim();
  if (!normalizedTarget) {
    throw new PermissionError('حظر عزل الفروع: يجب تحديد معرف فرع صالح لتنفيذ العملية.', 'branch:required');
  }

  if (user.role === 'ADMIN') {
    return;
  }

  const allowed = getAuthorizedBranchIds(user);
  if (allowed.size === 0) {
    throw new PermissionError(
      'حظر عزل الفروع: المستخدم غير مرتبط بأي فرع مصرح به.',
      'branch:unassigned'
    );
  }

  if (!allowed.has(normalizedTarget)) {
    throw new PermissionError(
      `حظر عزل الفروع: المستخدم غير مصرح له بالعمل على الفرع (${normalizedTarget}).`,
      `branch:${normalizedTarget}`
    );
  }
}

export function filterRecordsByBranchScope<T extends { branchId?: string }>(
  records: T[],
  user: Pick<SystemUser, 'role' | 'branchId' | 'allowedBranches' | 'active'> | null | undefined
): T[] {
  if (!user || !user.active) return [];
  if (user.role === 'ADMIN') return records;
  const allowed = getAuthorizedBranchIds(user);
  if (allowed.size === 0) return [];
  return records.filter((rec) => Boolean(rec.branchId && allowed.has(rec.branchId)));
}

export function filterAuditLogsForUser(
  logs: SystemAuditLog[],
  user: Pick<SystemUser, 'id' | 'role' | 'branchId' | 'allowedBranches' | 'active' | 'tenantId'> | null | undefined
): SystemAuditLog[] {
  if (!user || !user.active) return [];
  if (!user.tenantId?.trim()) return [];
  if (user.role === 'ADMIN') {
    return logs.filter((log) => !log.tenantId || log.tenantId === user.tenantId);
  }
  const allowed = getAuthorizedBranchIds(user);
  if (allowed.size === 0) return [];
  if (user.role === 'ACCOUNTANT') {
    return logs.filter(
      (log) =>
        (!log.tenantId || log.tenantId === user.tenantId) &&
        Boolean(log.branchId && allowed.has(log.branchId))
    );
  }
  return logs.filter(
    (log) =>
      log.userId === user.id &&
      (!log.branchId || allowed.has(log.branchId))
  );
}
