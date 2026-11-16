const test = require('node:test');
const assert = require('node:assert/strict');
const { toCents, calculate } = require('../lib/money');

test('Peso parsing is exact', () => {
  assert.equal(toCents('500'), 50000);
  assert.equal(toCents('0.05'), 5);
  assert.equal(toCents('-125.50', true), -12550);
  assert.throws(() => toCents('1.001'));
  assert.throws(() => toCents('abc'));
});

test('Cash-out deduct fee: wallet receives 500, customer gets 490', () => {
  assert.deepEqual(calculate('CASH_OUT', 'DEDUCT', 50000, 1000),
    {cashCents: 49000, walletCents: 50000, floatDeltaCents: 50000});
});
test('Cash-out add fee: wallet receives 510, customer gets 500', () => {
  assert.deepEqual(calculate('CASH_OUT', 'ADD', 50000, 1000),
    {cashCents: 50000, walletCents: 51000, floatDeltaCents: 51000});
});
test('Cash-in add fee: customer pays 510, wallet sends 500', () => {
  assert.deepEqual(calculate('CASH_IN', 'ADD', 50000, 1000),
    {cashCents: 51000, walletCents: 50000, floatDeltaCents: -50000});
});
test('Cash-in deduct fee: customer pays 500, wallet sends 490', () => {
  assert.deepEqual(calculate('CASH_IN', 'DEDUCT', 50000, 1000),
    {cashCents: 50000, walletCents: 49000, floatDeltaCents: -49000});
});
test('Reject fee equal to the amount in deduction mode', () => {
  assert.throws(() => calculate('CASH_IN','DEDUCT', 1000, 1000));
});
