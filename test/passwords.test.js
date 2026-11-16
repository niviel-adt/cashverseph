'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {makePasswordHash,verifyPassword}=require('../lib/passwords');
test('Cashier passwords are salted and verified',async()=>{
  const a=await makePasswordHash('cashier-test-password-123');
  const b=await makePasswordHash('cashier-test-password-123');
  assert.notEqual(a,b);
  assert.equal(await verifyPassword('cashier-test-password-123',a),true);
  assert.equal(await verifyPassword('wrong-password',a),false);
  assert.equal(await verifyPassword('cashier-test-password-123','bad'),false);
});
test('Reject weak cashier credentials',async()=>{
  await assert.rejects(()=>makePasswordHash('short'));
});
