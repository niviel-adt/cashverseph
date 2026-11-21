'use strict';
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { parse } = require('csv-parse/sync');
const crypto = require('node:crypto');
const path = require('node:path');
const {toCents, calculate} = require('./lib/money');
const {makePasswordHash,verifyPassword} = require('./lib/passwords');
const {publicRoutes,staffRoutes,initOrders,drawerChange} = require('./orders');

for(const k of ['DATABASE_URL','OWNER_PASSWORD','SESSION_SECRET'])
  if(!process.env[k]) throw Error('Missing environment variable: '+k);
// A six-digit owner PIN is supported only when the manager explicitly opts in.
// Prefer a long, unique owner password for public-facing installations.
const shortOwnerPinAllowed=process.env.OWNER_ALLOW_SHORT_PIN==='true' && /^\d{6}$/.test(process.env.OWNER_PASSWORD);
if(process.env.NODE_ENV==='production' &&
  ((!shortOwnerPinAllowed && process.env.OWNER_PASSWORD.length<12) || process.env.SESSION_SECRET.length<32))
  throw Error('Production requires a 12+ character owner password (or explicit 6-digit PIN opt-in) and a 32+ character session secret.');

const db = new Pool({connectionString:process.env.DATABASE_URL,max:10});
const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(express.json({limit:'1mb'}));
// Reject cross-site browser mutations; session cookies also use SameSite=strict.
app.use('/api',(req,res,next)=>{
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  const origin=req.get('origin');
  const host=req.get('x-forwarded-host') || req.get('host');
  if(origin){
    let source;
    try{source=new URL(origin);}catch(e){return res.status(403).json({error:'Invalid origin.'});}
    if(source.host!==host)return res.status(403).json({error:'Cross-site changes are not permitted.'});
  }
  next();
});
app.use(session({
  store:new PgSession({pool:db,createTableIfMissing:true}),
  secret:process.env.SESSION_SECRET,name:'cashverse.sid',
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:43200000}
}));
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.use(express.static(path.join(__dirname,'public')));
const providers=['GCASH','MAYA'], types=['CASH_IN','CASH_OUT'], modes=['ADD','DEDUCT'];
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function choice(v,list,name){if(!list.includes(v))throw error('Invalid '+name);return v;}
function cents(v,signed=false){
  try{return toCents(v,signed);}catch(e){throw error(e.message);}
}
function field(v,max,name){
  if(v==null)return '';
  if(typeof v!=='string'||v.length>max)throw error('Invalid '+name);
  return v.trim();
}
function secureHash(v){return crypto.createHash('sha256').update(v).digest();}
const attemptMap=new Map();

app.get('/health',async(req,res)=>{
  try{await db.query('SELECT 1');res.json({ok:true,app:'CASHVERSE',version:'1.2.0'});}
  catch(e){res.status(503).json({ok:false});}
});
// The original owner password remains valid, preserving existing manager access.
const isManager=req=>req.session.role==='manager'||req.session.owner===true;
async function identity(req){
  if(isManager(req))return {role:'manager',name:'Manager',id:null};
  if(req.session.role==='cashier'&&req.session.cashierId){
    const q=await db.query('SELECT id,username,display_name,auth_version FROM cashiers WHERE id=$1 AND active=true',
      [req.session.cashierId]);
    if(q.rows.length && q.rows[0].auth_version===req.session.cashierAuthVersion)
      return {role:'cashier',id:q.rows[0].id,name:q.rows[0].display_name,
      username:q.rows[0].username};
  }
  return null;
}
app.get('/api/me',async(req,res)=>{
  const actor=await identity(req);
  res.json({loggedIn:Boolean(actor),role:actor?.role||null,name:actor?.name||null,username:actor?.username||null});
});
app.post('/api/login',async(req,res)=>{
  const p=req.body?.password;
  const user=req.body?.username;
  if(typeof p!=='string'||p.length>200)throw error('Invalid username or password.',401);
  if(user!=null && (typeof user!=='string'||user.length>40))throw error('Invalid username or password.',401);
  const username=(user||'owner').trim().toLowerCase();
  if(req.body.cashierOnly && username==='owner')throw error('Use your cashier account.',403);
  const now=Date.now(),ip=req.ip;
  const tries=(attemptMap.get(ip)||[]).filter(t=>now-t<900000);
  if(tries.length>=7)throw error('Too many attempts. Try again in 15 minutes.',429);
  let cashier=null,valid=false;
  if(username==='owner'){
    valid=crypto.timingSafeEqual(secureHash(p),secureHash(process.env.OWNER_PASSWORD));
  }else if(/^[a-z][a-z0-9_.-]{2,29}$/.test(username)){
    const r=await db.query('SELECT id,username,display_name,password_hash,active,auth_version FROM cashiers WHERE username=$1',[username]);
    if(r.rows.length){
      cashier=r.rows[0];
      valid=cashier.active && await verifyPassword(p,cashier.password_hash);
    }
  }
  if(!valid){
    tries.push(now);attemptMap.set(ip,tries);
    throw error('Invalid username or password.',401);
  }
  attemptMap.delete(ip);
  await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
  req.session.role=username==='owner'?'manager':'cashier';
  req.session.owner=username==='owner';
  if(cashier){req.session.cashierId=cashier.id;req.session.cashierAuthVersion=cashier.auth_version;}
  res.json({ok:true,role:req.session.role});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>{
  res.clearCookie('cashverse.sid');res.json({ok:true});
}));
// Public, rate-limited QR order submission; no login needed.
app.use('/api/public/orders',publicRoutes(db));
app.use('/api',async(req,res,next)=>{
  const actor=await identity(req);
  if(!actor)throw error('Sign in first.',401);
  req.actor=actor;
  next();
});
const managerOnly=(req,res,next)=>req.actor.role==='manager'?next():next(error('Manager access required.',403));
app.use('/api/orders',staffRoutes(db));
// Cashier access is specifically limited to quote and create-transaction routes.
// Register manager-only routes behind this middleware.
app.get('/api/cashiers',managerOnly,async(req,res)=>{
  const q=await db.query('SELECT id,username,display_name,active,created_at FROM cashiers ORDER BY created_at DESC');
  res.json(q.rows);
});
app.post('/api/cashiers',managerOnly,async(req,res)=>{
  const username=field(req.body?.username,30,'username').toLowerCase();
  const name=field(req.body?.name,80,'name');
  const password=req.body?.password;
  if(!/^[a-z][a-z0-9_.-]{2,29}$/.test(username)||username==='owner')
    throw error('Use a unique username with 3–30 letters, digits, dots, underscores or hyphens (starting with a letter).');
  if(!name)throw error('Cashier name is required.');
  const passwordHash=await makePasswordHash(password);
  try{
    const q=await db.query(
      'INSERT INTO cashiers(id,username,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,active,created_at',
      [crypto.randomUUID(),username,name,passwordHash]);
    res.status(201).json(q.rows[0]);
  }catch(e){if(e.code==='23505')throw error('That cashier username already exists.',409);throw e;}
});
app.post('/api/cashiers/:id/active',managerOnly,async(req,res)=>{
  if(typeof req.body?.active!=='boolean')throw error('Choose active or inactive.');
  const q=await db.query('UPDATE cashiers SET active=$1,auth_version=auth_version+1 WHERE id=$2 RETURNING id,username,display_name,active',
    [req.body.active,req.params.id]);
  if(!q.rows.length)throw error('Cashier not found.',404);
  res.json(q.rows[0]);
});
app.post('/api/cashiers/:id/password',managerOnly,async(req,res)=>{
  const passwordHash=await makePasswordHash(req.body?.password);
  const q=await db.query('UPDATE cashiers SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2 RETURNING id',
    [passwordHash,req.params.id]);
  if(!q.rows.length)throw error('Cashier not found.',404);
  res.json({ok:true});
});
app.get('/api/settings',managerOnly,async(req,res)=>{
  const r=await db.query("SELECT cashier_approval_required FROM app_settings WHERE key='main'");
  res.json({cashierApprovalRequired:r.rows[0].cashier_approval_required});
});
app.post('/api/settings',managerOnly,async(req,res)=>{
  const enabled=req.body?.cashierApprovalRequired;
  if(typeof enabled!=='boolean')throw error('Choose whether cashier approval is required.');
  await db.query("UPDATE app_settings SET cashier_approval_required=$1 WHERE key='main'",[enabled]);
  res.json({cashierApprovalRequired:enabled});
});
// PRE-LAUNCH SETUP: this keeps accounts and fee rates unchanged.
// A reset archives existing records transactionally before clearing test ledger data.
app.get('/api/launch/summary',managerOnly,async(req,res)=>{
  const result=await db.query(
    "SELECT (SELECT COUNT(*)::int FROM transactions) AS transactions,"+
    "(SELECT COUNT(*)::int FROM adjustments) AS adjustments,"+
    "(SELECT COUNT(*)::int FROM customer_orders) AS customer_orders,"+
    "(SELECT (SELECT balance_cents FROM cash_drawer WHERE id=1)) AS cash_drawer_cents,"+
    "(SELECT COUNT(*)::int FROM cashiers) AS cashiers,"+
    "(SELECT COUNT(*)::int FROM fee_rates) AS rates,"+
    "(SELECT COUNT(*)::int FROM launch_archives) AS archive_count,"+
    "(SELECT COALESCE(jsonb_agg(jsonb_build_object('provider',provider,'balanceCents',balance_cents)), '[]'::jsonb) FROM wallet_balances) AS wallets"
  );
  res.json(result.rows[0]);
});

app.get('/api/launch/backup',managerOnly,async(req,res)=>{
  const q=await db.query(
    "SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at),'[]'::jsonb) FROM transactions t) AS transactions,"+
    "(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at),'[]'::jsonb) FROM adjustments a) AS adjustments,"+
    "(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.provider),'[]'::jsonb) FROM wallet_balances w) AS wallets,"+
    "(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.provider,r.txn_type,r.min_cents),'[]'::jsonb) FROM fee_rates r) AS fee_rates,"+
    "(SELECT COALESCE(jsonb_agg(to_jsonb(o)-'qr_image' ORDER BY o.created_at),'[]'::jsonb) FROM customer_orders o) AS orders,"+
    "(SELECT to_jsonb(d) FROM cash_drawer d WHERE id=1) AS cash_drawer,"+
    "(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.created_at),'[]'::jsonb) FROM cash_drawer_movements m) AS cash_drawer_movements,"+
    "(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'username',username,'display_name',display_name,'active',active,'created_at',created_at)),'[]'::jsonb) FROM cashiers) AS cashier_profiles"
  );
  res.set('Content-Disposition','attachment; filename="cashverse-prelaunch-export.json"');
  res.json({format:'cashverse-v1.1-prelaunch',exportedAt:new Date().toISOString(),
    note:'Record export for audit/reference; not an automatically restorable PostgreSQL backup. No login credentials included.',
    ...q.rows[0]});
});

app.post('/api/launch/reset',managerOnly,async(req,res)=>{
  const data=req.body || {};
  if(data.confirmation!=='RESET CASHVERSE' || data.backupAcknowledged!==true)
    throw error('Download your backup and type RESET CASHVERSE to confirm.');
  if(typeof data.password!=='string'||data.password.length>200||
    !crypto.timingSafeEqual(secureHash(data.password),secureHash(process.env.OWNER_PASSWORD)))
    throw error('Current owner password is incorrect.',403);

  const client=await db.connect();
  try{
    await client.query('BEGIN');
    // Exclude concurrent writers until the complete snapshot and reset have committed.
    await client.query('LOCK TABLE transactions, adjustments, cashier_requests, wallet_balances, customer_orders, order_events, cash_drawer, cash_drawer_movements, order_settings IN ACCESS EXCLUSIVE MODE');
    const archiveId=crypto.randomUUID();
    const archived=await client.query(
      "INSERT INTO launch_archives(id,transactions,adjustments,cashier_requests,wallets,orders,drawer_state,drawer_movements) "+
      "SELECT $1,"+
      "(SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM transactions t),"+
      "(SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM adjustments a),"+
      "(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM cashier_requests r),"+
      "(SELECT COALESCE(jsonb_agg(to_jsonb(w)),'[]'::jsonb) FROM wallet_balances w),"+
      "(SELECT COALESCE(jsonb_agg(to_jsonb(o)-'qr_image'),'[]'::jsonb) FROM customer_orders o),"+
      "(SELECT to_jsonb(d) FROM cash_drawer d WHERE id=1),"+
      "(SELECT COALESCE(jsonb_agg(to_jsonb(m)),'[]'::jsonb) FROM cash_drawer_movements m) "+
      "RETURNING id,created_at",
      [archiveId]);
    await client.query('DELETE FROM cash_drawer_movements');
    await client.query('DELETE FROM order_events');
    await client.query('DELETE FROM customer_orders');
    await client.query('UPDATE cash_drawer SET enabled=false,balance_cents=0,updated_at=now()');
    await client.query('UPDATE order_settings SET enabled=false');
    await client.query('DELETE FROM cashier_requests');
    await client.query('DELETE FROM transactions');
    await client.query('DELETE FROM adjustments');
    await client.query('UPDATE wallet_balances SET balance_cents=0,updated_at=now()');
    await client.query('COMMIT');
    res.json({ok:true,archiveId:archived.rows[0].id,archivedAt:archived.rows[0].created_at,
      message:'Pre-launch transactions, QR orders, cash drawer, adjustments and floats reset. Cashier logins and rates retained; public customer orders disabled.'});
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
});

app.get('/api/launch/archives/:id',managerOnly,async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/i.test(req.params.id))throw error('Invalid archive ID.');
  const q=await db.query(
    'SELECT id,created_at,transactions,adjustments,cashier_requests,wallets,orders,drawer_state,drawer_movements FROM launch_archives WHERE id=$1',
    [req.params.id]);
  if(!q.rows.length)throw error('Launch archive not found.',404);
  res.set('Content-Disposition','attachment; filename="cashverse-launch-archive.json"');
  res.json({format:'cashverse-v1.1-launch-archive',...q.rows[0]});
});

async function rate(client,provider,type,amount){
  const q=await client.query(
    "SELECT fee_cents FROM fee_rates WHERE provider=$1 AND txn_type=$2 AND min_cents<=$3 AND max_cents>=$3 "+
    "ORDER BY CASE WHEN min_cents=max_cents THEN 0 ELSE 1 END, (max_cents-min_cents) LIMIT 1",
    [provider,type,amount]);
  if(!q.rows.length)throw error('No matching fee. Upload your CSV rate list in Rates first.');
  return Number(q.rows[0].fee_cents);
}
async function makeQuote(client,p){
  const provider=choice(p.provider,providers,'wallet');
  const type=choice(p.type,types,'type');
  const mode=choice(p.mode,modes,'fee method');
  const amountCents=cents(p.amount);
  if(amountCents<=0)throw error('Amount must be greater than zero.');
  const feeCents=await rate(client,provider,type,amountCents);
  let calc;
  try{calc=calculate(type,mode,amountCents,feeCents);}catch(e){throw error(e.message);}
  return {provider,type,mode,amountCents,feeCents,...calc};
}
app.get('/api/quote',async(req,res)=>res.json(await makeQuote(db,req.query)));
app.get('/api/dashboard',managerOnly,async(req,res)=>{
  const [w,d,p]=await Promise.all([
    db.query('SELECT provider,balance_cents FROM wallet_balances ORDER BY provider'),
    db.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(fee_cents),0)::bigint AS fees FROM transactions "+
       "WHERE status='COMPLETED' AND (completed_at AT TIME ZONE 'Asia/Manila')::date=(now() AT TIME ZONE 'Asia/Manila')::date"),
    db.query("SELECT COUNT(*)::int AS count FROM transactions WHERE status='PENDING'")
  ]);
  res.json({wallets:w.rows.map(r=>({provider:r.provider,balanceCents:Number(r.balance_cents)})),
    today:{count:d.rows[0].count,feesCents:Number(d.rows[0].fees)},pending:p.rows[0].count});
});
app.get('/api/transactions',managerOnly,async(req,res)=>{
  const q=await db.query("SELECT id,provider,txn_type AS type,fee_mode AS mode,status,amount_cents,fee_cents,"+
    "wallet_cents,cash_cents,reference,notes,created_at,completed_at,created_by_name,created_by_role,"+
    "cashier_verified,approved_by FROM transactions ORDER BY created_at DESC LIMIT 200");
  res.json(q.rows);
});
app.post('/api/transactions',async(req,res)=>{
  const p=req.body||{},reference=field(p.reference,70,'reference'),notes=field(p.notes,200,'notes');
  const verified=p.verified===true;
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const keyed=p.requestId!==undefined;
    if(keyed){
      if(req.actor.role!=='cashier'||req.actor.username!==p.cashierUsername)
        throw error('Sign in as the cashier who started this transaction.',403);
      if(typeof p.requestId!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(p.requestId))
        throw error('Invalid transaction request.');
      const fingerprint=secureHash(JSON.stringify([p.provider,p.type,p.mode,p.amount,p.expectedFeeCents,
        reference,notes,verified])).toString('hex');
      const key=[req.actor.id,p.requestId];
      const inserted=await client.query(
        'INSERT INTO cashier_requests(cashier_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [...key,fingerprint]);
      if(!inserted.rowCount){
        const prior=(await client.query('SELECT fingerprint,receipt FROM cashier_requests WHERE cashier_id=$1 AND request_id=$2',key)).rows[0];
        if(prior.fingerprint!==fingerprint)throw error('Request already used for another transaction.',409);
        await client.query('COMMIT');
        return res.json(prior.receipt);
      }
    }
    const q=await makeQuote(client,p);
    if(keyed && p.expectedFeeCents!==q.feeCents)throw error('The service fee changed. Review the updated amount.',409);
    const approval=await client.query("SELECT cashier_approval_required FROM app_settings WHERE key='main'");
    const needsApproval=req.actor.role==='cashier'&&approval.rows[0].cashier_approval_required;
    const completed=verified&&!needsApproval;
    if(completed){
      const w=await client.query('SELECT balance_cents FROM wallet_balances WHERE provider=$1 FOR UPDATE',[q.provider]);
      if(Number(w.rows[0].balance_cents)+q.floatDeltaCents<0)throw error('Not enough '+q.provider+' float for this cash-in.');
    }
    const id=crypto.randomUUID(),status=completed?'COMPLETED':'PENDING';
    await client.query(
      "INSERT INTO transactions(id,provider,txn_type,fee_mode,status,amount_cents,fee_cents,wallet_cents,"+
      "cash_cents,float_delta_cents,reference,notes,completed_at,created_by_id,created_by_name,created_by_role,"+
      "cashier_verified,approved_by) "+
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $5='COMPLETED' THEN now() ELSE NULL END,$13,$14,$15,$16,$17)",
      [id,q.provider,q.type,q.mode,status,q.amountCents,q.feeCents,q.walletCents,q.cashCents,q.floatDeltaCents,
        reference,notes,req.actor.id,req.actor.name,req.actor.role,verified,
        completed?req.actor.name:null]);
    if(completed){
      // When the owner has initialized the physical cash drawer, all manual ledger
      // completions update it atomically with the wallet balance.
      await drawerChange(client,q.type,q.cashCents,req.actor.name,null,id);
      await client.query('UPDATE wallet_balances SET balance_cents=balance_cents+$1,updated_at=now() WHERE provider=$2',
        [q.floatDeltaCents,q.provider]);
    }
    const receipt={id,status,approvalRequired:needsApproval,verifiedByCashier:verified,...q};
    if(keyed)await client.query('UPDATE cashier_requests SET receipt=$3 WHERE cashier_id=$1 AND request_id=$2',
      [req.actor.id,p.requestId,receipt]);
    await client.query('COMMIT');
    res.status(201).json(receipt);
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/transactions/:id/complete',managerOnly,async(req,res)=>{
  if(req.body?.verified!==true)throw error('Verify the transfer in the official wallet app first.');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!q.rows.length)throw error('Transaction not found.',404);
    const t=q.rows[0];
    if(t.status!=='PENDING')throw error('Only pending transactions can be completed.');
    const w=await client.query('SELECT balance_cents FROM wallet_balances WHERE provider=$1 FOR UPDATE',[t.provider]);
    if(Number(w.rows[0].balance_cents)+Number(t.float_delta_cents)<0)throw error('Not enough '+t.provider+' float for this cash-in.');
    await drawerChange(client,t.txn_type,Number(t.cash_cents),'Manager',null,t.id);
    await client.query('UPDATE wallet_balances SET balance_cents=balance_cents+$1,updated_at=now() WHERE provider=$2',
      [t.float_delta_cents,t.provider]);
    await client.query("UPDATE transactions SET status='COMPLETED',completed_at=now(),approved_by='Manager' WHERE id=$1",[t.id]);
    await client.query('COMMIT');
    res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/transactions/:id/fail',managerOnly,async(req,res)=>{
  const q=await db.query("UPDATE transactions SET status='FAILED' WHERE id=$1 AND status='PENDING' RETURNING id",[req.params.id]);
  if(!q.rows.length)throw error('Only pending transactions can be marked failed.');
  res.json({ok:true});
});
app.post('/api/adjustments',managerOnly,async(req,res)=>{
  const p=req.body||{},provider=choice(p.provider,providers,'wallet'),
    delta=cents(p.amount,true),reason=field(p.reason,160,'reason');
  if(!delta)throw error('Adjustment cannot be zero.');
  if(!reason)throw error('Please enter a reason.');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query('SELECT balance_cents FROM wallet_balances WHERE provider=$1 FOR UPDATE',[provider]);
    const next=Number(q.rows[0].balance_cents)+delta;
    if(next<0)throw error('Wallet balance cannot become negative.');
    if(next>100000000)throw error('Balance must be no more than ₱1,000,000 in v1.');
    await client.query('UPDATE wallet_balances SET balance_cents=$1,updated_at=now() WHERE provider=$2',[next,provider]);
    await client.query('INSERT INTO adjustments(id,provider,delta_cents,reason) VALUES($1,$2,$3,$4)',
      [crypto.randomUUID(),provider,delta,reason]);
    await client.query('COMMIT');res.status(201).json({provider,balanceCents:next});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/adjustments',managerOnly,async(req,res)=>{
  const q=await db.query('SELECT provider,delta_cents,reason,created_at FROM adjustments ORDER BY created_at DESC LIMIT 100');
  res.json(q.rows);
});
app.get('/api/report',managerOnly,async(req,res)=>{
  const date=req.query.date;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z')))
    throw error('Invalid report date.');
  const q=await db.query("SELECT provider,txn_type AS type,COUNT(*)::int AS count,"+
    "COALESCE(SUM(amount_cents),0)::bigint AS amount_cents,COALESCE(SUM(fee_cents),0)::bigint AS fees_cents "+
    "FROM transactions WHERE status='COMPLETED' AND (completed_at AT TIME ZONE 'Asia/Manila')::date=$1::date "+
    "GROUP BY provider,txn_type ORDER BY provider,txn_type",[date]);
  const rows=q.rows.map(r=>({...r,amount_cents:Number(r.amount_cents),fees_cents:Number(r.fees_cents)}));
  res.json({date,timezone:'Asia/Manila',rows,totalCount:rows.reduce((n,r)=>n+r.count,0),
    totalFeesCents:rows.reduce((n,r)=>n+r.fees_cents,0)});
});
app.get('/api/rates',managerOnly,async(req,res)=>{
  const q=await db.query('SELECT provider,txn_type AS type,min_cents,max_cents,fee_cents FROM fee_rates ORDER BY provider,txn_type,min_cents');
  res.json(q.rows);
});
app.post('/api/rates/import',managerOnly,async(req,res)=>{
  const csv=req.body?.csv;
  if(typeof csv!=='string'||csv.length>100000)throw error('Select a CSV file under 100 KB.');
  let rows;
  try{rows=parse(csv,{columns:true,bom:true,skip_empty_lines:true,trim:true,max_record_size:2000});}
  catch(e){throw error('CSV could not be read: '+e.message);}
  if(rows.length<1||rows.length>500)throw error('Upload between 1 and 500 rate rows.');
  const header=['provider','transaction_type','min_amount','max_amount','fee'].sort().join(',');
  const rules=rows.map((r,i)=>{
    if(Object.keys(r).sort().join(',')!==header)throw error('CSV headers must be: provider,transaction_type,min_amount,max_amount,fee');
    try{
      const provider=choice(r.provider?.toUpperCase(),providers,'wallet');
      const type=choice(r.transaction_type?.toUpperCase(),types,'type');
      const min=cents(r.min_amount),max=cents(r.max_amount),fee=cents(r.fee);
      if(min<=0||max<min)throw error('Invalid rate range.');
      return {provider,type,min,max,fee};
    }catch(e){throw error('Row '+(i+2)+': '+e.message);}
  });
  for(let i=0;i<rules.length;i++)for(let j=i+1;j<rules.length;j++){
    const a=rules[i],b=rules[j];
    if(a.provider!==b.provider||a.type!==b.type)continue;
    const ae=a.min===a.max,be=b.min===b.max;
    if(ae&&be&&a.min===b.min)throw error('Duplicate exact rate on rows '+(i+2)+' and '+(j+2));
    if(!ae&&!be&&a.min<=b.max&&b.min<=a.max)throw error('Overlapping ranges on rows '+(i+2)+' and '+(j+2));
  }
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    await client.query('DELETE FROM fee_rates');
    for(const r of rules)
      await client.query('INSERT INTO fee_rates(provider,txn_type,min_cents,max_cents,fee_cents) VALUES($1,$2,$3,$4,$5)',
        [r.provider,r.type,r.min,r.max,r.fee]);
    await client.query('COMMIT');res.json({ok:true,imported:rules.length});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.use((e,req,res,next)=>{
  const status=e.status||500;
  if(status===500)console.error('[CASHVERSE]',e);
  if(res.headersSent)return next(e);
  res.status(status).json({error:status===500?'Server error. Please try again.':e.message});
});
async function init(){
  await db.query(
    "CREATE TABLE IF NOT EXISTS wallet_balances("+
    "provider text PRIMARY KEY CHECK(provider IN ('GCASH','MAYA')),"+
    "balance_cents bigint NOT NULL DEFAULT 0 CHECK(balance_cents>=0),updated_at timestamptz NOT NULL DEFAULT now());"+
    "INSERT INTO wallet_balances(provider,balance_cents) VALUES('GCASH',0),('MAYA',0) ON CONFLICT(provider) DO NOTHING;"+
    "CREATE TABLE IF NOT EXISTS fee_rates(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,"+
    "provider text NOT NULL CHECK(provider IN ('GCASH','MAYA')),txn_type text NOT NULL CHECK(txn_type IN ('CASH_IN','CASH_OUT')),"+
    "min_cents bigint NOT NULL CHECK(min_cents>0),max_cents bigint NOT NULL CHECK(max_cents>=min_cents),fee_cents bigint NOT NULL CHECK(fee_cents>=0));"+
    "CREATE TABLE IF NOT EXISTS transactions(id text PRIMARY KEY,"+
    "provider text NOT NULL CHECK(provider IN ('GCASH','MAYA')),txn_type text NOT NULL CHECK(txn_type IN ('CASH_IN','CASH_OUT')),"+
    "fee_mode text NOT NULL CHECK(fee_mode IN ('ADD','DEDUCT')),status text NOT NULL CHECK(status IN ('PENDING','COMPLETED','FAILED')),"+
    "amount_cents bigint NOT NULL CHECK(amount_cents>0),fee_cents bigint NOT NULL CHECK(fee_cents>=0),"+
    "wallet_cents bigint NOT NULL CHECK(wallet_cents>0),cash_cents bigint NOT NULL CHECK(cash_cents>0),"+
    "float_delta_cents bigint NOT NULL,reference text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',"+
    "created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);"+
    "CREATE INDEX IF NOT EXISTS cashverse_tx_created ON transactions(created_at DESC);"+
    "CREATE INDEX IF NOT EXISTS cashverse_tx_completed ON transactions(completed_at DESC);"+
    "CREATE TABLE IF NOT EXISTS adjustments(id text PRIMARY KEY,"+
    "provider text NOT NULL CHECK(provider IN ('GCASH','MAYA')),delta_cents bigint NOT NULL CHECK(delta_cents<>0),"+
    "reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());"
  );
  // Additive schema changes preserve all v1 transactions and balances.
  await db.query(
    "CREATE TABLE IF NOT EXISTS cashiers ("+
    "id text PRIMARY KEY, username text NOT NULL UNIQUE, display_name text NOT NULL,"+
    "password_hash text NOT NULL, active boolean NOT NULL DEFAULT true, auth_version integer NOT NULL DEFAULT 1,"+
    "created_at timestamptz NOT NULL DEFAULT now());"+
    "CREATE TABLE IF NOT EXISTS cashier_requests(cashier_id text NOT NULL REFERENCES cashiers(id),"+
    "request_id uuid NOT NULL,fingerprint text NOT NULL,receipt jsonb,PRIMARY KEY(cashier_id,request_id));"+
    "CREATE TABLE IF NOT EXISTS launch_archives ("+
    "id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),"+
    "transactions jsonb NOT NULL,adjustments jsonb NOT NULL,"+
    "cashier_requests jsonb NOT NULL,wallets jsonb NOT NULL);"+
    "CREATE TABLE IF NOT EXISTS app_settings ("+
    "key text PRIMARY KEY, cashier_approval_required boolean NOT NULL DEFAULT false);"+
    "INSERT INTO app_settings(key) VALUES('main') ON CONFLICT(key) DO NOTHING;"+
    "ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1;"+
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by_id text;"+
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by_name text NOT NULL DEFAULT 'Manager';"+
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by_role text NOT NULL DEFAULT 'manager';"+
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cashier_verified boolean NOT NULL DEFAULT false;"+
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approved_by text;"
  );
  await initOrders(db);
  await db.query(
    "ALTER TABLE launch_archives ADD COLUMN IF NOT EXISTS orders jsonb NOT NULL DEFAULT '[]'::jsonb;"+
    "ALTER TABLE launch_archives ADD COLUMN IF NOT EXISTS drawer_state jsonb NOT NULL DEFAULT '{}'::jsonb;"+
    "ALTER TABLE launch_archives ADD COLUMN IF NOT EXISTS drawer_movements jsonb NOT NULL DEFAULT '[]'::jsonb;"
  );
}
init().then(()=>app.listen(Number(process.env.PORT||3000),'0.0.0.0',
  ()=>console.log('CASHVERSE v1.2 is running'))).catch(e=>{console.error('Database setup failed',e);process.exit(1);});

