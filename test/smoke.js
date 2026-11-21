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
  // A cashier is never allowed to archive or reset the store.
  cookie='';
  await request('/api/login',{username:'cashier_test',password:'new-cashier-password-123'});
  await forbidden('/api/launch/summary');
  await forbidden('/api/launch/backup');
  await forbidden('/api/launch/reset','POST',{
    confirmation:'RESET CASHVERSE',password:process.env.OWNER_PASSWORD,backupAcknowledged:true
  });
  await request('/api/logout',{});
  cookie=managerCookie;

  // V1.2 public QR ordering is OFF by default. Cashier cannot change store settings.
  const publicSettings=await request('/api/public/orders/config');
  assert.equal(publicSettings.enabled,false);
  const deniedPublic=await fetch(BASE+'/api/public/orders',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})
  });
  assert.equal(deniedPublic.status,503);
  cookie='';
  await request('/api/login',{username:'cashier_test',password:'new-cashier-password-123'});
  await forbidden('/api/orders/drawer');
  await forbidden('/api/orders/config','POST',{enabled:true,maxCashout:'200'});
  await forbidden('/api/orders/store-qr','POST',{provider:'GCASH',imageData:'bad'});
  await request('/api/logout',{});
  cookie=managerCookie;

  const openingDrawer=await request('/api/orders/drawer/adjust',{
    initial:true,amount:'2000',reason:'V1.2 smoke test opening cash'
  });
  assert.equal(openingDrawer.ok,true);
  const drawerStart=await request('/api/orders/drawer');
  assert.equal(drawerStart.balanceCents,200000);
  assert.equal(drawerStart.enabled,true);
  await request('/api/orders/config',{enabled:true,maxCashout:'1500'});
  assert.equal((await request('/api/public/orders/config')).enabled,true);
  const orderQuote=await request('/api/public/orders/quote?provider=GCASH&service=CASH_OUT&mode=DEDUCT&amount=100');
  assert.equal(orderQuote.cashCents,9000);
  assert.equal(orderQuote.walletCents,10000);
  const tinyPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9xK3N9sAAAAASUVORK5CYII=';
  const crypto=require('node:crypto');
  const cashinPayload={
    requestId:crypto.randomUUID(),service:'CASH_IN',provider:'GCASH',mode:'ADD',amount:'100',
    customerName:'QR Test Customer',imageData:tinyPng
  };
  cookie=''; // Public customer, no cashier/manager session.
  const customerCashIn=await request('/api/public/orders',cashinPayload);
  assert.ok(customerCashIn.orderCode.startsWith('CV-'));
  assert.equal(customerCashIn.status,'NEW');
  const duplicate=await request('/api/public/orders',cashinPayload);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.orderCode,customerCashIn.orderCode);
  const visibleStatus=await request('/api/public/orders/'+customerCashIn.token);
  assert.equal(visibleStatus.status,'NEW');
  assert.equal(Object.hasOwn(visibleStatus,'qr_image'),false);
  cookie=managerCookie;
  let orderRows=await request('/api/orders');
  const cashInOrder=orderRows.find(o=>o.order_code===customerCashIn.orderCode);
  assert.equal(cashInOrder.has_qr,true);
  await request('/api/orders/'+cashInOrder.id+'/claim',{});
  await request('/api/orders/'+cashInOrder.id+'/finish',{
    verified:true,cashConfirmed:true,reference:'QR-CI-001'
  });
  const afterCashIn=await request('/api/orders/drawer');
  assert.equal(afterCashIn.balanceCents,211000);
  assert.equal(wallet(await request('/api/dashboard'),'GCASH'),41000);
  assert.equal((await request('/api/public/orders/'+customerCashIn.token)).status,'COMPLETED');
  const cashOutPayload={
    requestId:crypto.randomUUID(),service:'CASH_OUT',fulfillment:'WALK_IN',
    provider:'GCASH',mode:'DEDUCT',amount:'100'
  };
  cookie='';
  const customerCashOut=await request('/api/public/orders',cashOutPayload);
  cookie=managerCookie;
  orderRows=await request('/api/orders');
  const walkInOrder=orderRows.find(o=>o.order_code===customerCashOut.orderCode);
  assert.equal(Number(walkInOrder.cash_cents),9000);
  await request('/api/orders/'+walkInOrder.id+'/claim',{});
  await request('/api/orders/'+walkInOrder.id+'/finish',{
    verified:true,cashConfirmed:true,reference:'QR-CO-001'
  });
  assert.equal((await request('/api/orders/drawer')).balanceCents,202000);
  assert.equal(wallet(await request('/api/dashboard'),'GCASH'),51000);
  const pickupDate=new Date(Date.now()+2*3600000+8*3600000).toISOString().slice(0,16);
  cookie='';
  const customerPickup=await request('/api/public/orders',{
    requestId:crypto.randomUUID(),service:'CASH_OUT',fulfillment:'PICKUP',provider:'GCASH',
    mode:'DEDUCT',amount:'300',pickupAt:pickupDate,customerName:'Pickup Test'
  });
  cookie=managerCookie;
  orderRows=await request('/api/orders');
  const pickupOrder=orderRows.find(o=>o.order_code===customerPickup.orderCode);
  assert.equal(pickupOrder.status,'NEW');
  await request('/api/orders/'+pickupOrder.id+'/claim',{});
  assert.equal((await request('/api/orders/drawer')).heldCents,29000);
  assert.equal((await request('/api/orders/drawer')).availableCents,173000);
  const noOverspend=await fetch(BASE+'/api/orders/drawer/adjust',{
    method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
    body:JSON.stringify({amount:'-1900',reason:'Not enough cash'})
  });
  assert.equal(noOverspend.status,409);
  cookie='';
  await request('/api/login',{username:'cashier_test',password:'new-cashier-password-123'});
  await request('/api/orders/'+pickupOrder.id+'/claim',{});
  const waiting=await request('/api/orders/'+pickupOrder.id+'/finish',{
    verified:true,cashConfirmed:true,reference:'QR-PICKUP-001'
  });
  assert.equal(waiting.status,'AWAITING_APPROVAL');
  cookie=managerCookie;
  assert.equal((await request('/api/orders/drawer')).heldCents,29000);
  await request('/api/orders/'+pickupOrder.id+'/approve',{
    verified:true,cashConfirmed:true,reference:'QR-PICKUP-001'
  });
  assert.equal((await request('/api/orders/drawer')).heldCents,0);
  assert.equal((await request('/api/orders/drawer')).balanceCents,173000);
  assert.equal(wallet(await request('/api/dashboard'),'GCASH'),81000);
  cookie='';
  const other=await request('/api/public/orders',{...cashOutPayload,requestId:crypto.randomUUID()});
  cookie=managerCookie;
  orderRows=await request('/api/orders');
  const reject=orderRows.find(o=>o.order_code===other.orderCode);
  await request('/api/orders/'+reject.id+'/reject',{reason:'Customer did not appear'});
  assert.equal((await request('/api/public/orders/'+other.token)).status,'REJECTED');
  const transactionRows=await request('/api/transactions');
  assert.equal(transactionRows.filter(x=>x.notes?.startsWith('Customer QR order')).length,3);
  const exportedOrders=await request('/api/launch/backup');
  assert.equal(exportedOrders.orders.length,4);
  assert.equal(exportedOrders.cash_drawer.balance_cents,173000);
  assert.equal(exportedOrders.orders.every(x=>!Object.hasOwn(x,'qr_image')),true);
  await request('/api/orders/config',{enabled:false,maxCashout:'1500'});

  // Owner can download a record export and reset test activity while retaining settings/accounts/rates.
  const before=await request('/api/launch/summary');
  assert.ok(before.transactions>=5);
  assert.ok(before.adjustments>=1);
  const backup=await request('/api/launch/backup');
  assert.equal(backup.format,'cashverse-v1.1-prelaunch');
  assert.ok(backup.transactions.length>=5);
  assert.equal(backup.cashier_profiles.length,1);
  assert.ok(!JSON.stringify(backup).includes('password_hash'));
  const missingConsent=await fetch(BASE+'/api/launch/reset',{
    method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
    body:JSON.stringify({password:process.env.OWNER_PASSWORD,confirmation:'WRONG',backupAcknowledged:true})
  });
  assert.equal(missingConsent.status,400);

  const reset=await request('/api/launch/reset',{
    password:process.env.OWNER_PASSWORD,confirmation:'RESET CASHVERSE',backupAcknowledged:true
  });
  assert.equal(reset.ok,true);
  const archive=await request('/api/launch/archives/'+reset.archiveId);
  assert.ok(archive.transactions.length>=5);
  assert.equal(archive.orders.length,4);
  assert.equal(archive.drawer_state.balance_cents,173000);
  const after=await request('/api/launch/summary');
  assert.equal(after.transactions,0);
  assert.equal(after.adjustments,0);
  assert.equal(after.customer_orders,0);
  assert.equal(Number(after.cash_drawer_cents),0);
  assert.equal((await request('/api/orders/drawer')).enabled,false);
  assert.equal((await request('/api/public/orders/config')).enabled,false);
  assert.equal(after.rates,5);
  assert.equal(after.cashiers,1);
  assert.equal(after.wallets.every(w=>Number(w.balanceCents)===0),true);
  assert.equal(after.archive_count,before.archive_count+1);
  assert.equal((await request('/api/transactions')).length,0);
  assert.equal(wallet(await request('/api/dashboard'),'GCASH'),0);
  const postReset=await request('/api/transactions',{
    provider:'GCASH',type:'CASH_OUT',mode:'DEDUCT',amount:'100',verified:true
  });
  assert.equal(postReset.status,'COMPLETED');
  assert.equal(wallet(await request('/api/dashboard'),'GCASH'),10000);

  await request('/api/logout',{});
  assert.equal((await request('/api/me')).loggedIn,false);
  console.log('CASHVERSE v1.2 smoke tests passed: role access, cashier creation, approval, account disabling, password reset, floats, reporting, launch backup and reset.');
})().catch(err=>{console.error(err);process.exitCode=1;});
