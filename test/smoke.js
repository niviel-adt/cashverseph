'use strict';
const assert = require('node:assert/strict');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
let cookie = '';
async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
  const headers = {'Accept':'application/json'};
  if (cookie) headers.Cookie = cookie;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,headers,body:data === undefined ? undefined : JSON.stringify(data)
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const payload = await res.json();
  if (!res.ok) throw Error(method + ' ' + path + ' → ' + res.status + ' ' + JSON.stringify(payload));
  return payload;
}
function wallet(dashboard, provider) {
  return dashboard.wallets.find(w => w.provider === provider).balanceCents;
}
(async()=>{
  const health = await request('/health');
  assert.equal(health.ok,true);
  assert.equal((await request('/api/me')).loggedIn,false);

  await request('/api/login',{password:process.env.OWNER_PASSWORD});
  assert.equal((await request('/api/me')).loggedIn,true);

  const csv = [
    'provider,transaction_type,min_amount,max_amount,fee',
    'GCASH,CASH_IN,1,500,10',
    'GCASH,CASH_OUT,1,500,10',
    'MAYA,CASH_IN,1,500,10',
    'MAYA,CASH_OUT,1,500,10',
    'GCASH,CASH_OUT,250,250,7'
  ].join('\n');
  const imported=await request('/api/rates/import',{csv});
  assert.equal(imported.imported,5);
  const exact=await request('/api/quote?provider=GCASH&type=CASH_OUT&mode=DEDUCT&amount=250');
  assert.equal(exact.feeCents,700);

  const quote=await request('/api/quote?provider=GCASH&type=CASH_OUT&mode=DEDUCT&amount=500');
  assert.equal(quote.cashCents,49000);
  assert.equal(quote.walletCents,50000);

  await request('/api/adjustments',{provider:'GCASH',amount:'1000',reason:'Test opening float'});
  let dashboard=await request('/api/dashboard');
  assert.equal(wallet(dashboard,'GCASH'),100000);
  assert.equal(wallet(dashboard,'MAYA'),0);

  const cashIn=await request('/api/transactions',{
    provider:'GCASH',type:'CASH_IN',mode:'ADD',amount:'500',
    reference:'CI-TEST',verified:true
  });
  assert.equal(cashIn.status,'COMPLETED');
  assert.equal(cashIn.cashCents,51000);
  dashboard=await request('/api/dashboard');
  assert.equal(wallet(dashboard,'GCASH'),50000);

  const cashOut=await request('/api/transactions',{
    provider:'GCASH',type:'CASH_OUT',mode:'DEDUCT',amount:'500',verified:true
  });
  assert.equal(cashOut.status,'COMPLETED');
  assert.equal(cashOut.cashCents,49000);
  dashboard=await request('/api/dashboard');
  assert.equal(wallet(dashboard,'GCASH'),100000);

  const pending=await request('/api/transactions',{
    provider:'GCASH',type:'CASH_IN',mode:'DEDUCT',amount:'500',verified:false
  });
  assert.equal(pending.status,'PENDING');
  dashboard=await request('/api/dashboard');
  assert.equal(wallet(dashboard,'GCASH'),100000);
  await request('/api/transactions/'+pending.id+'/complete',{verified:true});
  dashboard=await request('/api/dashboard');
  assert.equal(wallet(dashboard,'GCASH'),51000);

  const failed=await request('/api/transactions',{
    provider:'MAYA',type:'CASH_OUT',mode:'DEDUCT',amount:'500',verified:false
  });
  await request('/api/transactions/'+failed.id+'/fail',{});
  dashboard=await request('/api/dashboard');
  assert.equal(wallet(dashboard,'MAYA'),0);
  assert.equal(dashboard.today.feesCents,3000);

  const list=await request('/api/transactions');
  assert.equal(list.length,4);
  assert.equal(list.find(r=>r.id===failed.id).status,'FAILED');

  await request('/api/logout',{});
  assert.equal((await request('/api/me')).loggedIn,false);
  console.log('CASHVERSE smoke test passed: auth, CSV rates, quote, cash-in, cash-out, pending, failure, float, daily earnings.');
})().catch(err=>{console.error(err);process.exitCode=1;});
