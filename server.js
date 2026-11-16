'use strict';
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { parse } = require('csv-parse/sync');
const crypto = require('node:crypto');
const path = require('node:path');
const {toCents, calculate} = require('./lib/money');

for(const k of ['DATABASE_URL','OWNER_PASSWORD','SESSION_SECRET'])
  if(!process.env[k]) throw Error('Missing environment variable: '+k);
if(process.env.NODE_ENV==='production' &&
  (process.env.OWNER_PASSWORD.length<12 || process.env.SESSION_SECRET.length<32))
  throw Error('Production requires a 12+ character OWNER_PASSWORD and 32+ character SESSION_SECRET.');

const db = new Pool({connectionString:process.env.DATABASE_URL,max:10});
const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(express.json({limit:'150kb'}));
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
  try{await db.query('SELECT 1');res.json({ok:true,app:'CASHVERSE',version:'1.0.0'});}
  catch(e){res.status(503).json({ok:false});}
});
app.get('/api/me',(req,res)=>res.json({loggedIn:req.session.owner===true}));
app.post('/api/login',async(req,res)=>{
  const p=req.body?.password;
  if(typeof p!=='string'||p.length>200)throw error('Invalid password.');
  const now=Date.now(),ip=req.ip;
  const tries=(attemptMap.get(ip)||[]).filter(t=>now-t<900000);
  if(tries.length>=7)throw error('Too many attempts. Try again in 15 minutes.',429);
  if(!crypto.timingSafeEqual(secureHash(p),secureHash(process.env.OWNER_PASSWORD))){
    tries.push(now);attemptMap.set(ip,tries);throw error('Incorrect password.',401);
  }
  attemptMap.delete(ip);
  await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
  req.session.owner=true;
  res.json({ok:true});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>{
  res.clearCookie('cashverse.sid');res.json({ok:true});
}));
app.use('/api',(req,res,next)=>req.session.owner===true?next():next(error('Sign in first.',401)));

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
app.get('/api/dashboard',async(req,res)=>{
  const [w,d,p]=await Promise.all([
    db.query('SELECT provider,balance_cents FROM wallet_balances ORDER BY provider'),
    db.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(fee_cents),0)::bigint AS fees FROM transactions "+
       "WHERE status='COMPLETED' AND (completed_at AT TIME ZONE 'Asia/Manila')::date=(now() AT TIME ZONE 'Asia/Manila')::date"),
    db.query("SELECT COUNT(*)::int AS count FROM transactions WHERE status='PENDING'")
  ]);
  res.json({wallets:w.rows.map(r=>({provider:r.provider,balanceCents:Number(r.balance_cents)})),
    today:{count:d.rows[0].count,feesCents:Number(d.rows[0].fees)},pending:p.rows[0].count});
});
app.get('/api/transactions',async(req,res)=>{
  const q=await db.query("SELECT id,provider,txn_type AS type,fee_mode AS mode,status,amount_cents,fee_cents,"+
    "wallet_cents,cash_cents,reference,notes,created_at,completed_at FROM transactions ORDER BY created_at DESC LIMIT 200");
  res.json(q.rows);
});
app.post('/api/transactions',async(req,res)=>{
  const p=req.body||{},reference=field(p.reference,70,'reference'),notes=field(p.notes,200,'notes');
  const verified=p.verified===true;
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const q=await makeQuote(client,p);
    if(verified){
      const w=await client.query('SELECT balance_cents FROM wallet_balances WHERE provider=$1 FOR UPDATE',[q.provider]);
      if(Number(w.rows[0].balance_cents)+q.floatDeltaCents<0)throw error('Not enough '+q.provider+' float for this cash-in.');
    }
    const id=crypto.randomUUID(),status=verified?'COMPLETED':'PENDING';
    await client.query(
      "INSERT INTO transactions(id,provider,txn_type,fee_mode,status,amount_cents,fee_cents,wallet_cents,"+
      "cash_cents,float_delta_cents,reference,notes,completed_at) "+
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $5='COMPLETED' THEN now() ELSE NULL END)",
      [id,q.provider,q.type,q.mode,status,q.amountCents,q.feeCents,q.walletCents,q.cashCents,q.floatDeltaCents,reference,notes]);
    if(verified)await client.query('UPDATE wallet_balances SET balance_cents=balance_cents+$1,updated_at=now() WHERE provider=$2',
      [q.floatDeltaCents,q.provider]);
    await client.query('COMMIT');
    res.status(201).json({id,status,...q});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/transactions/:id/complete',async(req,res)=>{
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
    await client.query('UPDATE wallet_balances SET balance_cents=balance_cents+$1,updated_at=now() WHERE provider=$2',
      [t.float_delta_cents,t.provider]);
    await client.query("UPDATE transactions SET status='COMPLETED',completed_at=now() WHERE id=$1",[t.id]);
    await client.query('COMMIT');
    res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/transactions/:id/fail',async(req,res)=>{
  const q=await db.query("UPDATE transactions SET status='FAILED' WHERE id=$1 AND status='PENDING' RETURNING id",[req.params.id]);
  if(!q.rows.length)throw error('Only pending transactions can be marked failed.');
  res.json({ok:true});
});
app.post('/api/adjustments',async(req,res)=>{
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
app.get('/api/adjustments',async(req,res)=>{
  const q=await db.query('SELECT provider,delta_cents,reason,created_at FROM adjustments ORDER BY created_at DESC LIMIT 100');
  res.json(q.rows);
});
app.get('/api/report',async(req,res)=>{
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
app.get('/api/rates',async(req,res)=>{
  const q=await db.query('SELECT provider,txn_type AS type,min_cents,max_cents,fee_cents FROM fee_rates ORDER BY provider,txn_type,min_cents');
  res.json(q.rows);
});
app.post('/api/rates/import',async(req,res)=>{
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
}
init().then(()=>app.listen(Number(process.env.PORT||3000),'0.0.0.0',
  ()=>console.log('CASHVERSE v1 is running'))).catch(e=>{console.error('Database setup failed',e);process.exit(1);});
