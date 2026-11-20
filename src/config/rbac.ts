/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * المصدر الموحد لمصفوفة الصلاحيات والتحقق الأمني (RBAC Matrix & Server/Service Guard)
 * يعالج SEC-02 و QA-02 و RBAC-08 عبر توحيد تعريف الشاشات والأذونات الدقيقة لكل دور
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
  | 'purchase:create'
  | 'inventory:view'
  | 'inventory:write'
  | 'inventory:adjust'
  | 'inventory:delete'
  | 'party:view'
  | 'party:write'
  | 'voucher:receipt'
  | 'voucher:payment'
  | 'cashbox:view'
  | 'cashbox:create'
  | 'amanat:manage'
  | 'journal:post'
  | 'journal:reverse'
  | 'account:create'
  | 'users:manage'
  | 'branches:manage'
  | 'settings:manage'
  | 'sync:manage'
  | 'backup:manage';

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
  'purchase:create',
  'inventory:view',
  'inventory:write',
  'inventory:adjust',
  'inventory:delete',
  'party:view',
  'party:write',
  'voucher:receipt',
  'voucher:payment',
  'cashbox:view',
  'cashbox:create',
  'amanat:manage',
  'journal:post',
  'journal:reverse',
  'account:create',
  'users:manage',
  'branches:manage',
  'settings:manage',
  'sync:manage',
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
    'purchase:create',
    'inventory:view',
    'inventory:write',
    'inventory:adjust',
    'party:view',
    'party:write',
    'voucher:receipt',
    'voucher:payment',
    'cashbox:view',
    'cashbox:create',
    'amanat:manage',
    'journal:post',
    'journal:reverse',
    'account:create',
    'sync:manage',
  ]),
  INVENTORY_KEEPER: new Set<Permission>([
    'view:dashboard',
    'inventory:view',
    'inventory:write',
    'inventory:adjust',
    'purchase:create',
  ]),
  CASHIER: new Set<Permission>([
    'view:dashboard',
    'pos:sale',
    'inventory:view',
    'party:view',
    'cashbox:view',
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
  const effectiveRole: UserRole = role && role in ROLE_ALLOWED_VIEWS ? role : 'CASHIER';
  return ROLE_ALLOWED_VIEWS[effectiveRole].includes(view);
}

export function hasPermission(user: Pick<SystemUser, 'role' | 'active'> | null | undefined, permission: Permission): boolean {
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

export function assertBranchAccess(
  user: Pick<SystemUser, 'role' | 'branchId' | 'allowedBranches' | 'active'> | null | undefined,
  targetBranchId?: string
): void {
  if (!user || !user.active) {
    throw new PermissionError('حظر أمني: الجلسة غير صالحة.', 'branch:access');
  }
  if (!targetBranchId) return;
  if (user.role === 'ADMIN') return;

  const allowed = new Set<string>([
    ...(user.allowedBranches || []),
    ...(user.branchId ? [user.branchId] : []),
  ]);

  if (allowed.size > 0 && !allowed.has(targetBranchId)) {
    throw new PermissionError(
      `حظر عزل الفروع: المستخدم غير مصرح له بالعمل على الفرع (${targetBranchId}).`,
      `branch:${targetBranchId}`
    );
  }
}

export function filterAuditLogsForUser(
  logs: SystemAuditLog[],
  user: Pick<SystemUser, 'id' | 'role' | 'branchId' | 'allowedBranches'> | null | undefined
): SystemAuditLog[] {
  if (!user) return [];
  if (user.role === 'ADMIN' || user.role === 'ACCOUNTANT') {
    return logs;
  }
  return logs.filter((log) => log.userId === user.id);
}
