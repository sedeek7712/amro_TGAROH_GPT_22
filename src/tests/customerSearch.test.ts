import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPermission } from '../config/rbac';
import { searchCustomers } from '../utils/customerSearch';
import type { Party } from '../types/erp';

const customers: Party[] = [
  { id: 'customer-1', type: 'CUSTOMER', nameAr: 'أحمد محمد', phone: '771280940', balance: 1250, advanceBalance: 300 },
  { id: 'customer-2', type: 'CUSTOMER', nameAr: 'محمد علي', phone: '٧٧٣١٢٣٤٥٦', balance: 0, advanceBalance: 0 },
];

test('customer search matches partial Arabic names', () => {
  assert.deepEqual(searchCustomers(customers, 'محمد').map((customer) => customer.id), ['customer-1', 'customer-2']);
});

test('customer search normalizes Arabic and Persian phone digits', () => {
  assert.deepEqual(searchCustomers(customers, '٧٧١٢٨٠').map((customer) => customer.id), ['customer-1']);
  assert.deepEqual(searchCustomers(customers, '۷۷۳۱۲۳').map((customer) => customer.id), ['customer-2']);
});

test('cashier can create customers but cannot edit existing customers', () => {
  const cashier = { role: 'CASHIER' as const, active: true };
  assert.equal(hasPermission(cashier, 'party:create'), true);
  assert.equal(hasPermission(cashier, 'party:write'), false);
});

test('inventory keeper cannot create a customer from POS', () => {
  const inventoryKeeper = { role: 'INVENTORY_KEEPER' as const, active: true };
  assert.equal(hasPermission(inventoryKeeper, 'party:create'), false);
});
