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

  // V1.1 manager creates cashier credentials and can control verification approvals.
  const created=await request('/api/cashiers',{
    username:'cashier_test',name:'Test Cashier',password:'cashier-test-password-123'
  });
  assert.equal(created.active,true);
  assert.equal((await request('/api/cashiers')).length,1);
  assert.equal((await request('/api/settings')).cashierApprovalRequired,false);
  const managerCookie=cookie;
  cookie=''; // Start a separate cashier browser session.
  await request('/api/login',{username:'CASHIER_TEST',password:'cashier-test-password-123'});
  assert.equal((await request('/api/me')).role,'cashier');
  const cashierCookie=cookie;
  const forbidden=async(p,method='GET',body)=>{
    const res=await fetch(BASE+p,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(res.status,403,'Expected forbidden access to '+p);
  };
  await forbidden('/api/dashboard');
  await forbidden('/api/transactions');
  await forbidden('/api/rates');
  await forbidden('/api/report?date=2026-11-16');
  await forbidden('/api/adjustments','POST',{provider:'MAYA',amount:'1000',reason:'No permission'});
  await forbidden('/api/rates/import','POST',{csv:'cannot import'});
  await forbidden('/api/cashiers');
  await forbidden('/api/settings');
  await forbidden('/api/transactions/'+cashIn.id+'/complete','POST',{verified:true});

  const cashierTransaction=await request('/api/transactions',{
    provider:'MAYA',type:'CASH_OUT',mode:'DEDUCT',amount:'100',verified:true
  });
  assert.equal(cashierTransaction.status,'COMPLETED');
  cookie=managerCookie;
  let records=await request('/api/transactions');
  const cashierRow=records.find(r=>r.id===cashierTransaction.id);
  assert.equal(cashierRow.created_by_role,'cashier');
  assert.equal(cashierRow.created_by_name,'Test Cashier');
  assert.equal(wallet(await request('/api/dashboard'),'MAYA'),10000);

  await request('/api/settings',{cashierApprovalRequired:true});
  cookie=cashierCookie;
  const pendingApproval=await request('/api/transactions',{
    provider:'MAYA',type:'CASH_OUT',mode:'DEDUCT',amount:'100',verified:true
  });
  assert.equal(pendingApproval.status,'PENDING');
  assert.equal(pendingApproval.approvalRequired,true);
  cookie=managerCookie;
  assert.equal(wallet(await request('/api/dashboard'),'MAYA'),10000);
  records=await request('/api/transactions');
  assert.equal(records.find(r=>r.id===pendingApproval.id).cashier_verified,true);
  await request('/api/transactions/'+pendingApproval.id+'/complete',{verified:true});
  assert.equal(wallet(await request('/api/dashboard'),'MAYA'),20000);

  await request('/api/cashiers/'+created.id+'/password',{password:'new-cashier-password-123'});
  await request('/api/cashiers/'+created.id+'/active',{active:false});
  cookie=cashierCookie;
  const revoked=await request('/api/me');
  assert.equal(revoked.loggedIn,false);
  cookie=managerCookie;
  await request('/api/cashiers/'+created.id+'/active',{active:true});
  cookie=cashierCookie;
  assert.equal((await request('/api/me')).loggedIn,false,
    'Old cashier sessions must stay revoked after re-enabling.');
  cookie=''; // Separate new cashier session keeps manager session active.
  await request('/api/login',{username:'cashier_test',password:'new-cashier-password-123'});
  assert.equal((await request('/api/me')).role,'cashier');
  await request('/api/logout',{});
  assert.equal((await request('/api/me')).loggedIn,false);
  cookie=managerCookie;
  await request('/api/logout',{});
  assert.equal((await request('/api/me')).loggedIn,false);
  console.log('CASHVERSE v1.1 smoke tests passed: role access, cashier creation, approval, account disabling, password reset, floats and reporting.');
})().catch(err=>{console.error(err);process.exitCode=1;});
