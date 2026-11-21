'use strict';
const express=require('express');
const crypto=require('node:crypto');
const QRCode=require('qrcode');
const {toCents,calculate}=require('./lib/money');

const fail=(msg,status=400)=>Object.assign(new Error(msg),{status});
const wallets=['GCASH','MAYA'];
const modes=['ADD','DEDUCT'];
const statuses=['NEW','IN_PROGRESS','RESERVED','AWAITING_APPROVAL','COMPLETED','REJECTED','EXPIRED'];
const cashoutMax=5000000; // ₱50,000 upper guardrail; adjustable operational cap defaults to ₱20,000
const attempts=new Map();
const safe=(v,max=80)=>{
  if(v==null)return '';
  if(typeof v!=='string'||v.length>max)throw fail('Invalid text field.');
  return v.trim();
};
const cents=(v,signed=false)=>{try{return toCents(v,signed)}catch(e){throw fail(e.message)}};
function rateLimit(req){
  const now=Date.now(),key=req.ip||'unknown';
  if(attempts.size>10000)attempts.clear();
  const items=(attempts.get(key)||[]).filter(t=>now-t<15*60000);
  if(items.length>=6)throw fail('Too many requests. Try again later.',429);
  items.push(now);attempts.set(key,items);
}
function parseImage(data,required){
  if(!data && !required)return {data:null,mime:null};
  if(typeof data!=='string'||data.length>850000)throw fail('QR screenshot is too large (max 600 KB).');
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if(!match)throw fail('Upload a PNG, JPG or WebP image of the receiving QR code.');
  const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length||bytes.length>600000||bytes.toString('base64')!==match[2])
    throw fail('Invalid or oversized QR screenshot.');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg=bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  const mime=match[1]==='png'?'image/png':match[1]==='jpeg'?'image/jpeg':'image/webp';
  if(!(png&&mime==='image/png'||jpg&&mime==='image/jpeg'||webp&&mime==='image/webp'))
    throw fail('Image contents do not match the uploaded image type.');
  return {data:bytes,mime};
}
async function config(db){
  const r=await db.query('SELECT enabled,max_cashout_cents FROM order_settings WHERE id=1');
  return r.rows[0];
}
async function calculateOrder(db,p){
  if(!wallets.includes(p.provider)||!modes.includes(p.mode)||
    !['CASH_IN','CASH_OUT'].includes(p.service))throw fail('Select a valid wallet, service and fee method.');
  const amountCents=cents(p.amount);
  if(amountCents<=0)throw fail('Enter an amount above zero.');
  const setting=await config(db);
  if(p.service==='CASH_OUT'&&amountCents>Number(setting.max_cashout_cents))
    throw fail('Requested cash-out is above the store limit.');
  const r=await db.query(
    'SELECT fee_cents FROM fee_rates WHERE provider=$1 AND txn_type=$2 AND min_cents<=$3 AND max_cents>=$3 '+
    'ORDER BY CASE WHEN min_cents=max_cents THEN 0 ELSE 1 END,(max_cents-min_cents) LIMIT 1',
    [p.provider,p.service,amountCents]);
  if(!r.rows.length)throw fail('No rate configured for this amount. Contact the store.');
  const feeCents=Number(r.rows[0].fee_cents);
  let values;try{values=calculate(p.service,p.mode,amountCents,feeCents);}
  catch(e){throw fail(e.message);}
  return {service:p.service,provider:p.provider,mode:p.mode,amountCents,feeCents,...values};
}
function expiryFromPickup(pickupAt,kind){
  if(kind!=='PICKUP')return {pickup:null,expiry:new Date(Date.now()+60*60000)};
  if(typeof pickupAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(pickupAt))
    throw fail('Choose a pickup date and time.');
  const pickup=new Date(pickupAt+':00+08:00');
  const delay=pickup.getTime()-Date.now();
  if(!Number.isFinite(delay)||delay<30*60000||delay>7*86400000)
    throw fail('Pickup must be at least 30 minutes from now and within the next 7 days (Philippine time).');
  return {pickup,expiry:new Date(pickup.getTime()+60*60000)};
}
async function expireOrders(db){
  await db.query("UPDATE customer_orders SET status='EXPIRED',updated_at=now() "+
    "WHERE status IN ('NEW','RESERVED') AND expires_at<=now()");
  await db.query("UPDATE customer_orders SET qr_image=NULL,qr_mime=NULL "+
    "WHERE created_at<now()-interval '14 days' AND status IN ('COMPLETED','REJECTED','EXPIRED')");
}
// Call while holding the cash_drawer row lock.
async function holds(db,ignore=null){
  const r=await db.query(
    "SELECT COALESCE(SUM(cash_cents),0)::bigint AS held FROM customer_orders "+
    "WHERE fulfillment='PICKUP' AND status IN ('RESERVED','IN_PROGRESS','AWAITING_APPROVAL') "+
    "AND (expires_at>now() OR status IN ('IN_PROGRESS','AWAITING_APPROVAL')) AND id IS DISTINCT FROM $1",
    [ignore]);
  return Number(r.rows[0].held);
}
async function drawerChange(client,kind,amount,actor,orderId=null,transactionId=null){
  const d=(await client.query('SELECT balance_cents,enabled FROM cash_drawer WHERE id=1 FOR UPDATE')).rows[0];
  if(!d?.enabled)return false;
  const delta=kind==='CASH_IN'?amount:-amount;
  const otherHolds=await holds(client,orderId);
  if(Number(d.balance_cents)+delta<otherHolds)
    throw fail('Not enough unreserved cash in the drawer for this payout.',409);
  await client.query('UPDATE cash_drawer SET balance_cents=balance_cents+$1,updated_at=now() WHERE id=1',[delta]);
  await client.query('INSERT INTO cash_drawer_movements(id,delta_cents,reason,actor,order_id,transaction_id) VALUES($1,$2,$3,$4,$5,$6)',
    [crypto.randomUUID(),delta,kind==='CASH_IN'?'Cash-in collected':'Cash-out released',actor,orderId,transactionId]);
  return true;
}
function publicRoutes(db){
  const r=express.Router();
  r.get('/qr.svg',async(req,res)=>{
    const base=process.env.PUBLIC_BASE_URL ||
      'https://'+(process.env.RAILWAY_PUBLIC_DOMAIN||'cashverse-web-production.up.railway.app');
    const url=new URL('/order.html',base).toString();
    const svg=await QRCode.toString(url,{type:'svg',margin:2,width:320,errorCorrectionLevel:'M'});
    res.type('image/svg+xml').set('Cache-Control','public,max-age=300').send(svg);
  });
  r.get('/config',async(req,res)=>{
    const s=await config(db);
    res.set('Cache-Control','no-store').json({enabled:s.enabled,maxCashoutCents:Number(s.max_cashout_cents),
      timezone:'Asia/Manila',pickupMinMinutes:30,pickupMaxDays:7});
  });
  r.get('/quote',async(req,res)=>{
    const s=await config(db);
    if(!s.enabled)throw fail('Customer orders are not open yet.',503);
    res.set('Cache-Control','no-store').json(await calculateOrder(db,req.query));
  });
  r.post('/',async(req,res)=>{
    rateLimit(req);
    const s=await config(db);
    if(!s.enabled)throw fail('Customer orders are not open yet.',503);
    const p=req.body||{};
    if(typeof p.requestId!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(p.requestId))
      throw fail('Please reload the request page and try again.');
    const quote=await calculateOrder(db,p);
    const fulfillment=quote.service==='CASH_IN'?'WALK_IN':p.fulfillment;
    if(!['WALK_IN','PICKUP'].includes(fulfillment))throw fail('Select walk-in or pickup.');
    const {pickup,expiry}=expiryFromPickup(p.pickupAt,fulfillment);
    const name=safe(p.customerName,60);
    const image=parseImage(p.imageData,quote.service==='CASH_IN');
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([
      quote,fulfillment,pickup?.toISOString()||'',name,
      image.data?crypto.createHash('sha256').update(image.data).digest('hex'):''
    ])).digest('hex');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const prior=await client.query('SELECT id,order_code,public_token,request_fingerprint FROM customer_orders WHERE request_id=$1 FOR UPDATE',[p.requestId]);
      if(prior.rows.length){
        if(prior.rows[0].request_fingerprint!==fingerprint)throw fail('This request was already used with different details.',409);
        await client.query('COMMIT');
        return res.json({orderCode:prior.rows[0].order_code,token:prior.rows[0].public_token,duplicate:true});
      }
      const id=crypto.randomUUID(),token=crypto.randomBytes(24).toString('hex');
      const orderCode='CV-'+crypto.randomBytes(6).toString('hex').toUpperCase();
      await client.query(
        'INSERT INTO customer_orders(id,request_id,request_fingerprint,order_code,public_token,service,fulfillment,provider,fee_mode,'+
        'amount_cents,fee_cents,wallet_cents,cash_cents,float_delta_cents,customer_name,qr_image,qr_mime,pickup_at,expires_at) '+
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
        [id,p.requestId,fingerprint,orderCode,token,quote.service,fulfillment,quote.provider,quote.mode,
          quote.amountCents,quote.feeCents,quote.walletCents,quote.cashCents,quote.floatDeltaCents,name,
          image.data,image.mime,pickup,expiry]);
      await client.query('INSERT INTO order_events(order_id,actor,action) VALUES($1,$2,$3)',
        [id,'Customer','CREATED']);
      await client.query('COMMIT');
      res.status(201).json({orderCode,token,expiresAt:expiry.toISOString(),status:'NEW'});
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  r.get('/:token',async(req,res)=>{
    if(!/^[a-f0-9]{48}$/.test(req.params.token))throw fail('Order not found.',404);
    await expireOrders(db);
    const q=await db.query(
      'SELECT order_code,status,service,fulfillment,provider,amount_cents,fee_cents,wallet_cents,cash_cents,pickup_at,expires_at,created_at FROM customer_orders WHERE public_token=$1',
      [req.params.token]);
    if(!q.rows.length)throw fail('Order not found.',404);
    res.set('Cache-Control','no-store').json(q.rows[0]);
  });
  return r;
}
function staffRoutes(db){
  const r=express.Router();
  const manager=(req,res,next)=>req.actor?.role==='manager'?next():next(fail('Manager access required.',403));
  r.get('/summary',async(req,res)=>{
    await expireOrders(db);
    const q=await db.query("SELECT status,COUNT(*)::int AS count FROM customer_orders "+
      "WHERE created_at>now()-interval '30 days' GROUP BY status");
    const result={counts:Object.fromEntries(q.rows.map(x=>[x.status,x.count]))};
    if(req.actor.role==='manager'){
      const d=(await db.query('SELECT balance_cents,enabled FROM cash_drawer WHERE id=1')).rows[0];
      const held=await holds(db);
      result.drawer={balanceCents:Number(d.balance_cents),enabled:d.enabled,heldCents:held,availableCents:Number(d.balance_cents)-held};
    }
    res.json(result);
  });
  r.get('/',async(req,res)=>{
    await expireOrders(db);
    const q=await db.query(
      'SELECT id,order_code,service,fulfillment,provider,fee_mode,status,amount_cents,fee_cents,wallet_cents,cash_cents,'+
      'customer_name,pickup_at,expires_at,created_at,updated_at,assigned_to,assigned_name,completed_by,completed_at,payment_reference,'+
      '(qr_image IS NOT NULL) AS has_qr FROM customer_orders ORDER BY created_at DESC LIMIT 150');
    res.json(q.rows);
  });
  r.get('/store-qr/:provider',async(req,res)=>{
    if(!wallets.includes(req.params.provider))throw fail('Invalid wallet.');
    const q=await db.query('SELECT image,mime FROM store_receiving_qr WHERE provider=$1',[req.params.provider]);
    if(!q.rows.length)throw fail('Receiving QR not configured.',404);
    res.set('Cache-Control','no-store').set('X-Content-Type-Options','nosniff').type(q.rows[0].mime).send(q.rows[0].image);
  });
  r.post('/store-qr',manager,async(req,res)=>{
    if(!wallets.includes(req.body?.provider))throw fail('Invalid wallet.');
    const image=parseImage(req.body.imageData,true);
    await db.query('INSERT INTO store_receiving_qr(provider,image,mime,updated_at) VALUES($1,$2,$3,now()) '+
      'ON CONFLICT(provider) DO UPDATE SET image=$2,mime=$3,updated_at=now()',
      [req.body.provider,image.data,image.mime]);
    res.json({ok:true});
  });
  r.get('/config',async(req,res)=>{
    const s=await config(db);
    res.json({enabled:s.enabled,maxCashoutCents:Number(s.max_cashout_cents),
      canConfigure:req.actor.role==='manager'});
  });
  r.post('/config',manager,async(req,res)=>{
    if(typeof req.body?.enabled!=='boolean')throw fail('Select enabled or disabled.');
    const max=cents(req.body.maxCashout);
    if(max<=0||max>cashoutMax)throw fail('Cash-out limit must be between ₱0.01 and ₱50,000.');
    if(req.body.enabled){
      const drawer=(await db.query('SELECT enabled FROM cash_drawer WHERE id=1')).rows[0];
      if(!drawer.enabled)throw fail('Set up physical cash in the Cash drawer section before accepting orders.',409);
      const rates=await db.query('SELECT COUNT(*)::int AS count FROM fee_rates');
      if(!rates.rows[0].count)throw fail('Upload fee rates before enabling customer orders.',409);
    }
    await db.query('UPDATE order_settings SET enabled=$1,max_cashout_cents=$2 WHERE id=1',[req.body.enabled,max]);
    res.json({enabled:req.body.enabled,maxCashoutCents:max});
  });
  r.get('/drawer',manager,async(req,res)=>{
    const d=(await db.query('SELECT balance_cents,enabled FROM cash_drawer WHERE id=1')).rows[0];
    const q=await db.query('SELECT id,delta_cents,reason,actor,created_at FROM cash_drawer_movements ORDER BY created_at DESC LIMIT 100');
    const held=await holds(db);
    res.json({enabled:d.enabled,balanceCents:Number(d.balance_cents),heldCents:held,availableCents:Number(d.balance_cents)-held,
      movements:q.rows});
  });
  r.post('/drawer/adjust',manager,async(req,res)=>{
    const delta=cents(req.body?.amount,true),reason=safe(req.body?.reason,160);
    if(!reason)throw fail('Reason is required.');
    if(delta===0 && req.body.initial!==true)throw fail('Enter a nonzero adjustment.');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await expireOrders(client);
      const d=(await client.query('SELECT balance_cents,enabled FROM cash_drawer WHERE id=1 FOR UPDATE')).rows[0];
      if(!d.enabled && req.body.initial!==true)throw fail('Set the opening physical cash amount first.');
      if(d.enabled && req.body.initial===true)throw fail('Cash drawer was already initialized.');
      const held=await holds(client);
      if(Number(d.balance_cents)+delta<held)throw fail('The adjustment cannot reduce cash below active reservations.',409);
      await client.query('UPDATE cash_drawer SET balance_cents=balance_cents+$1,enabled=true,updated_at=now() WHERE id=1',[delta]);
      await client.query('INSERT INTO cash_drawer_movements(id,delta_cents,reason,actor) VALUES($1,$2,$3,$4)',
        [crypto.randomUUID(),delta,reason,req.actor.name]);
      await client.query('COMMIT');
      res.json({ok:true,newBalanceCents:Number(d.balance_cents)+delta});
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  r.get('/:id/qr',async(req,res)=>{
    const q=await db.query('SELECT qr_image,qr_mime FROM customer_orders WHERE id=$1',[req.params.id]);
    if(!q.rows.length||!q.rows[0].qr_image)throw fail('QR image is unavailable or expired.',404);
    res.set('Cache-Control','no-store').set('X-Content-Type-Options','nosniff').type(q.rows[0].qr_mime)
      .send(q.rows[0].qr_image);
  });
  r.post('/:id/claim',async(req,res)=>{
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await expireOrders(client);
      const q=await client.query('SELECT * FROM customer_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rows.length)throw fail('Order not found.',404);
      const order=q.rows[0];
      if(order.status==='NEW'&&order.fulfillment==='PICKUP'){
        if(req.actor.role!=='manager')throw fail('The manager must accept and reserve cash for advance pickup.',403);
        const d=(await client.query('SELECT balance_cents,enabled FROM cash_drawer WHERE id=1 FOR UPDATE')).rows[0];
        if(!d.enabled)throw fail('Set up the physical cash drawer first.',409);
        const reserved=await holds(client);
        if(Number(d.balance_cents)-reserved<Number(order.cash_cents))throw fail('Not enough unreserved cash for this pickup.',409);
        await client.query("UPDATE customer_orders SET status='RESERVED',assigned_to=$2,assigned_name=$3,updated_at=now() WHERE id=$1",
          [order.id,req.actor.id,req.actor.name]);
        await client.query('INSERT INTO order_events(order_id,actor,action) VALUES($1,$2,$3)',
          [order.id,req.actor.name,'RESERVED']);
        await client.query('COMMIT');
        return res.json({ok:true,status:'RESERVED'});
      }
      if(order.status==='NEW' && order.fulfillment==='WALK_IN' ||
         order.status==='RESERVED' && order.fulfillment==='PICKUP'){
        if(order.status==='RESERVED' && order.pickup_at &&
          new Date(order.pickup_at).getTime()-Date.now()>30*60000)throw fail('Pickup is not yet due.',409);
        await client.query("UPDATE customer_orders SET status='IN_PROGRESS',assigned_to=$2,assigned_name=$3,updated_at=now() WHERE id=$1",
          [order.id,req.actor.id,req.actor.name]);
        await client.query('INSERT INTO order_events(order_id,actor,action) VALUES($1,$2,$3)',
          [order.id,req.actor.name,'CLAIMED']);
        await client.query('COMMIT');
        return res.json({ok:true,status:'IN_PROGRESS'});
      }
      throw fail('This order cannot be claimed in its current status.',409);
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  async function settle(client,order,actor,reference){
    const wallet=(await client.query('SELECT balance_cents FROM wallet_balances WHERE provider=$1 FOR UPDATE',[order.provider])).rows[0];
    if(Number(wallet.balance_cents)+Number(order.float_delta_cents)<0)throw fail('Not enough wallet float for this cash-in.',409);
    const tracked=await drawerChange(client,order.service,Number(order.cash_cents),actor,order.id,null);
    if(!tracked)throw fail('Cash drawer is not initialized. Ask the manager to set opening cash.',409);
    const txId=crypto.randomUUID();
    await client.query("INSERT INTO transactions(id,provider,txn_type,fee_mode,status,amount_cents,fee_cents,wallet_cents,"+
      "cash_cents,float_delta_cents,reference,notes,completed_at,created_by_id,created_by_name,created_by_role,"+
      "cashier_verified,approved_by,order_id) VALUES($1,$2,$3,$4,'COMPLETED',$5,$6,$7,$8,$9,$10,$11,now(),$12,$13,$14,true,$15,$16)",
      [txId,order.provider,order.service,order.fee_mode,order.amount_cents,order.fee_cents,order.wallet_cents,
        order.cash_cents,order.float_delta_cents,reference,'Customer QR order '+order.order_code,
        order.assigned_to||null,order.assigned_name||actor,order.assigned_to?'cashier':'manager',actor,order.id]);
    await client.query('UPDATE wallet_balances SET balance_cents=balance_cents+$1,updated_at=now() WHERE provider=$2',
      [order.float_delta_cents,order.provider]);
    await client.query("UPDATE customer_orders SET status='COMPLETED',payment_reference=$2,completed_by=$3,"+
      "completed_at=now(),updated_at=now() WHERE id=$1",[order.id,reference,actor]);
    await client.query('INSERT INTO order_events(order_id,actor,action) VALUES($1,$2,$3)',
      [order.id,actor,'COMPLETED']);
    return txId;
  }
  async function perform(req,res,approvalOnly=false){
    if(approvalOnly && req.actor.role!=='manager')throw fail('Manager approval is required.',403);
    if(req.body?.verified!==true||req.body?.cashConfirmed!==true)
      throw fail('Confirm official wallet verification and physical cash transfer before completion.');
    const reference=safe(req.body.reference,70);
    if(!reference)throw fail('Enter the official wallet transaction reference.');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await expireOrders(client);
      const q=await client.query('SELECT * FROM customer_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rows.length)throw fail('Order not found.',404);
      const order=q.rows[0];
      if(approvalOnly && order.status!=='AWAITING_APPROVAL')throw fail('This order is not awaiting approval.',409);
      if(!approvalOnly && order.status!=='IN_PROGRESS')throw fail('Claim this order before completing.',409);
      if(order.fulfillment==='PICKUP'&&order.expires_at &&
        Date.now()>new Date(order.expires_at).getTime()+15*60000)
        throw fail('Pickup window has passed; cancel or update the reservation.',409);
      // Recheck that the original submitted fee cannot silently change after rate uploads.
      const settings=(await client.query("SELECT cashier_approval_required FROM app_settings WHERE key='main'")).rows[0];
      if(!approvalOnly&&req.actor.role==='cashier'&&settings.cashier_approval_required){
        await client.query("UPDATE customer_orders SET status='AWAITING_APPROVAL',payment_reference=$2,updated_at=now() WHERE id=$1",
          [order.id,reference]);
        await client.query('INSERT INTO order_events(order_id,actor,action) VALUES($1,$2,$3)',
          [order.id,req.actor.name,'AWAITING_APPROVAL']);
        await client.query('COMMIT');
        return res.json({ok:true,status:'AWAITING_APPROVAL'});
      }
      const txId=await settle(client,order,req.actor.name,reference);
      await client.query('COMMIT');
      res.json({ok:true,status:'COMPLETED',transactionId:txId});
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  r.post('/:id/finish',async(req,res)=>perform(req,res,false));
  r.post('/:id/approve',manager,async(req,res)=>perform(req,res,true));
  r.post('/:id/reject',async(req,res)=>{
    const reason=safe(req.body?.reason,160);
    if(!reason)throw fail('Enter a reason for rejection.');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const q=await client.query('SELECT status FROM customer_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rows.length)throw fail('Order not found.',404);
      if(['COMPLETED','EXPIRED','REJECTED'].includes(q.rows[0].status))throw fail('This order is closed.',409);
      if(q.rows[0].status==='AWAITING_APPROVAL'&&req.actor.role!=='manager')
        throw fail('The manager must reject orders awaiting approval.',403);
      await client.query("UPDATE customer_orders SET status='REJECTED',rejection_reason=$2,updated_at=now() WHERE id=$1",
        [req.params.id,reason]);
      await client.query('INSERT INTO order_events(order_id,actor,action,details) VALUES($1,$2,$3,$4)',
        [req.params.id,req.actor.name,'REJECTED',JSON.stringify({reason})]);
      await client.query('COMMIT');res.json({ok:true,status:'REJECTED'});
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  return r;
}
async function initOrders(db){
  await db.query(
    "CREATE TABLE IF NOT EXISTS order_settings(id integer PRIMARY KEY CHECK(id=1),"+
    "enabled boolean NOT NULL DEFAULT false,max_cashout_cents bigint NOT NULL DEFAULT 2000000);"+
    "INSERT INTO order_settings(id) VALUES(1) ON CONFLICT DO NOTHING;"+
    "CREATE TABLE IF NOT EXISTS cash_drawer(id integer PRIMARY KEY CHECK(id=1),"+
    "enabled boolean NOT NULL DEFAULT false,balance_cents bigint NOT NULL DEFAULT 0 CHECK(balance_cents>=0),"+
    "updated_at timestamptz NOT NULL DEFAULT now());"+
    "INSERT INTO cash_drawer(id) VALUES(1) ON CONFLICT DO NOTHING;"+
    "CREATE TABLE IF NOT EXISTS customer_orders("+
    "id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,request_fingerprint text NOT NULL,"+
    "order_code text NOT NULL UNIQUE,public_token text NOT NULL UNIQUE,"+
    "service text NOT NULL CHECK(service IN ('CASH_IN','CASH_OUT')),"+
    "fulfillment text NOT NULL CHECK(fulfillment IN ('WALK_IN','PICKUP')),"+
    "provider text NOT NULL CHECK(provider IN ('GCASH','MAYA')),"+
    "fee_mode text NOT NULL CHECK(fee_mode IN ('ADD','DEDUCT')),"+
    "status text NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','IN_PROGRESS','RESERVED','AWAITING_APPROVAL','COMPLETED','REJECTED','EXPIRED')),"+
    "amount_cents bigint NOT NULL,fee_cents bigint NOT NULL,wallet_cents bigint NOT NULL,"+
    "cash_cents bigint NOT NULL,float_delta_cents bigint NOT NULL,"+
    "customer_name text NOT NULL DEFAULT '',qr_image bytea,qr_mime text,pickup_at timestamptz,"+
    "expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),"+
    "updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,"+
    "assigned_to text,assigned_name text,completed_by text,payment_reference text NOT NULL DEFAULT '',"+
    "rejection_reason text NOT NULL DEFAULT '');"+
    "CREATE INDEX IF NOT EXISTS cashverse_order_created ON customer_orders(created_at DESC);"+
    "CREATE INDEX IF NOT EXISTS cashverse_order_open ON customer_orders(status,expires_at);"+
    "CREATE TABLE IF NOT EXISTS order_events(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,"+
    "order_id uuid NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,"+
    "actor text NOT NULL,action text NOT NULL,details jsonb,"+
    "created_at timestamptz NOT NULL DEFAULT now());"+
    "CREATE TABLE IF NOT EXISTS cash_drawer_movements(id uuid PRIMARY KEY,delta_cents bigint NOT NULL,"+
    "reason text NOT NULL,actor text NOT NULL,order_id uuid REFERENCES customer_orders(id) ON DELETE SET NULL,"+
    "transaction_id text,created_at timestamptz NOT NULL DEFAULT now());"+
    "CREATE TABLE IF NOT EXISTS store_receiving_qr(provider text PRIMARY KEY CHECK(provider IN ('GCASH','MAYA')),"+
    "image bytea NOT NULL,mime text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());"+
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS order_id uuid UNIQUE;"
  );
}
module.exports={publicRoutes,staffRoutes,initOrders,drawerChange,expireOrders};
