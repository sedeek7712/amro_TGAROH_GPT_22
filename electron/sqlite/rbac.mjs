export const ROLE_PERMISSIONS = {
  ADMIN: new Set([
    'view:dashboard',
    'view:reports',
    'view:profits',
    'view:accounting',
    'view:audit_logs',
    'pos:sale',
    'invoices:view',
    'purchase:create',
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
  ]),
  ACCOUNTANT: new Set([
    'view:dashboard',
    'view:reports',
    'view:profits',
    'view:accounting',
    'view:audit_logs',
    'pos:sale',
    'invoices:view',
    'purchase:create',
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
  INVENTORY_KEEPER: new Set([
    'view:dashboard',
    'inventory:view',
    'inventory:write',
    'inventory:adjust',
    'purchase:create',
    'invoices:view',
    'party:view',
    'cashbox:view',
    'branches:view',
  ]),
  CASHIER: new Set([
    'view:dashboard',
    'pos:sale',
    'invoices:view',
    'inventory:view',
    'party:view',
    'cashbox:view',
    'branches:view',
  ]),
};

export class PermissionError extends Error {
  constructor(message, requiredPermission) {
    super(message);
    this.name = 'PermissionError';
    this.code = 'FORBIDDEN';
    this.requiredPermission = requiredPermission;
  }
}

export function hasPermission(actor, permission) {
  if (!actor || !actor.active) return false;
  const set = ROLE_PERMISSIONS[actor.role];
  return set ? set.has(permission) : false;
}

export function assertPermission(actor, permission, actionLabel) {
  if (!actor || !actor.active) {
    throw new PermissionError('حظر أمني: الجلسة غير مصادق عليها أو المستخدم موقوف.', permission);
  }
  if (!hasPermission(actor, permission)) {
    throw new PermissionError(
      `حظر صلاحيات (RBAC): الدور (${actor.role}) لا يملك صلاحية تنفيذ (${actionLabel || permission}).`,
      permission
    );
  }
}

export function getAuthorizedBranchIds(actor) {
  if (!actor || !actor.active) return new Set();
  const ids = [
    ...(Array.isArray(actor.allowedBranches) ? actor.allowedBranches : []).map((b) => String(b).trim()).filter(Boolean),
    ...(actor.branchId && String(actor.branchId).trim() ? [String(actor.branchId).trim()] : []),
  ];
  return new Set(ids);
}

export function assertBranchAccess(actor, targetBranchId) {
  if (!actor || !actor.active) {
    throw new PermissionError('حظر أمني: الجلسة غير صالحة.', 'branch:access');
  }
  if (!actor.tenantId || !String(actor.tenantId).trim()) {
    throw new PermissionError('حظر أمني: المستخدم لا ينتمي إلى مؤسسة (tenantId) صالحة.', 'tenant:access');
  }
  const normalizedTarget = typeof targetBranchId === 'string' ? targetBranchId.trim() : '';
  if (!normalizedTarget) {
    throw new PermissionError('حظر عزل الفروع: يجب تحديد معرف فرع صالح لتنفيذ العملية.', 'branch:required');
  }
  if (actor.role === 'ADMIN') return;
  const allowed = getAuthorizedBranchIds(actor);
  if (allowed.size === 0) {
    throw new PermissionError('حظر عزل الفروع: المستخدم غير مرتبط بأي فرع مصرح به.', 'branch:unassigned');
  }
  if (!allowed.has(normalizedTarget)) {
    throw new PermissionError(
      `حظر عزل الفروع: المستخدم غير مصرح له بالعمل على الفرع (${normalizedTarget}).`,
      `branch:${normalizedTarget}`
    );
  }
}

export function filterRecordsByBranchScope(records, actor) {
  if (!actor || !actor.active) return [];
  if (actor.role === 'ADMIN') return records;
  const allowed = getAuthorizedBranchIds(actor);
  if (allowed.size === 0) return [];
  return records.filter((rec) => Boolean(rec && rec.branchId && allowed.has(rec.branchId)));
}

export function filterAuditLogsForUser(logs, actor) {
  if (!actor || !actor.active || !actor.tenantId || !String(actor.tenantId).trim()) return [];
  if (actor.role === 'ADMIN') {
    return logs.filter((log) => !log.tenantId || log.tenantId === actor.tenantId);
  }
  const allowed = getAuthorizedBranchIds(actor);
  if (allowed.size === 0) return [];
  if (actor.role === 'ACCOUNTANT') {
    return logs.filter(
      (log) =>
        (!log.tenantId || log.tenantId === actor.tenantId) &&
        Boolean(log.branchId && allowed.has(log.branchId))
    );
  }
  return logs.filter(
    (log) => log.userId === actor.id && (!log.branchId || allowed.has(log.branchId))
  );
}
