'use strict';
const $=id=>document.getElementById(id);
const peso=n=>'₱'+(Number(n||0)/100).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
let service='CASH_IN',fulfillment='WALK_IN',quote=null,token=null,config=null,requestId=null,quoteTimer,seq=0;
const error=e=>{$('error').textContent=e;$('error').hidden=false;};
function clearError(){$('error').hidden=true;$('error').textContent='';}
async function request(path,body){
  const opts={method:body?'POST':'GET',headers:{'Accept':'application/json'}};
  if(body){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}
  const response=await fetch('/api/public/orders'+path,opts);
  const data=await response.json().catch(()=>({error:'Could not read server response.'}));
  if(!response.ok)throw Error(data.error||'Unable to complete request.');
  return data;
}
function selectService(type,kind){
  service=type;fulfillment=kind;quote=null;requestId=null;
  document.querySelectorAll('.method').forEach(el=>el.classList.toggle('active',el.dataset.service===type&&el.dataset.fulfillment===kind));
  $('cashinQr').hidden=type!=='CASH_IN';$('qrFile').required=type==='CASH_IN';
  $('pickupInfo').hidden=kind!=='PICKUP';$('pickupAt').required=kind==='PICKUP';
  $('cashoutInfo').hidden=type!=='CASH_OUT';
  $('mode').value=type==='CASH_IN'?'ADD':'DEDUCT';
  $('formTitle').textContent=type==='CASH_IN'?'Request cash-in':kind==='PICKUP'?'Reserve cash for pickup':'Request walk-in cash-out';
  $('formSub').textContent=type==='CASH_IN'?'Upload your receiving QR and visit the store to pay cash.':
    kind==='PICKUP'?'Reserve physical cash for a future pickup time. Wait for store acceptance.':'Submit a request and complete the transfer at the counter.';
  updateQuote();
}
async function updateQuote(){
  const requestNo=++seq;
  quote=null;$('quote').hidden=true;$('sendBtn').disabled=true;$('quoteError').textContent='';
  if(!config?.enabled)return;
  const amount=$('amount').value;
  if(!amount||Number(amount)<=0)return;
  try{
    const p=new URLSearchParams({service,provider:$('provider').value,mode:$('mode').value,amount});
    const q=await request('/quote?'+p.toString());
    if(requestNo!==seq)return;
    quote=q;
    $('quoteAmount').textContent=peso(q.amountCents);
    $('quoteFee').textContent=peso(q.feeCents);
    $('quoteWalletLabel').textContent=service==='CASH_IN'?'Wallet receives':'Customer sends to store';
    $('quoteWallet').textContent=peso(q.walletCents);
    $('quoteCashLabel').textContent=service==='CASH_IN'?'Cash to pay at store':'Cash to receive at store';
    $('quoteCash').textContent=peso(q.cashCents);
    $('quote').hidden=false;$('sendBtn').disabled=false;
  }catch(e){if(requestNo===seq)$('quoteError').textContent=e.message;}
}
function delayedQuote(){clearTimeout(quoteTimer);quoteTimer=setTimeout(updateQuote,220);}
async function compress(file){
  if(!file)return null;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Choose a PNG, JPG or WebP screenshot.');
  if(file.size>10*1024*1024)throw Error('Please select an image smaller than 10MB.');
  const image=await createImageBitmap(file);
  try{
    const scale=Math.min(1,1100/Math.max(image.width,image.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    if(!canvas.width||!canvas.height)throw Error('This image could not be read.');
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    let data=canvas.toDataURL('image/png');
    if(data.length>800000)data=canvas.toDataURL('image/jpeg',.86);
    if(data.length>800000)throw Error('QR screenshot is too large. Crop the image around the QR and retry.');
    return data;
  }finally{image.close();}
}
function line(label,val){
  const a=document.createElement('div'),b=document.createElement('span'),c=document.createElement('strong');
  b.textContent=label;c.textContent=val;a.append(b,c);return a;
}
async function status(){
  if(!token||document.hidden)return;
  try{
    const x=await request('/'+token);
    $('orderCode').textContent=x.order_code;
    $('orderState').textContent=({
      NEW:'Waiting for store staff',RESERVED:'Pickup reservation accepted',
      IN_PROGRESS:'Being processed',AWAITING_APPROVAL:'Waiting for manager approval',
      COMPLETED:'Completed',REJECTED:'Rejected by store',EXPIRED:'Expired'
    })[x.status]||x.status;
    const d=$('orderDetails');d.replaceChildren(
      line('Service',x.service==='CASH_IN'?'Cash in':x.fulfillment==='PICKUP'?'Cash out — pickup':'Cash out — walk in'),
      line('Wallet',x.provider==='GCASH'?'GCash':'Maya'),
      line('Requested',peso(x.amount_cents)),
      line('Service fee',peso(x.fee_cents)),
      line(x.service==='CASH_IN'?'Cash to pay':'Cash to collect',peso(x.cash_cents)),
      line(x.fulfillment==='PICKUP'?'Pickup time':'Request expires',new Date(x.pickup_at||x.expires_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))
    );
  }catch(e){error(e.message);}
}
function showStatus(){
  $('newOrder').hidden=true;$('orderStatus').hidden=false;
  status();
}
async function init(){
  document.querySelectorAll('.method').forEach(b=>b.addEventListener('click',()=>selectService(b.dataset.service,b.dataset.fulfillment)));
  document.querySelectorAll('[data-amount]').forEach(b=>b.addEventListener('click',()=>{$('amount').value=b.dataset.amount;updateQuote();}));
  ['provider','mode'].forEach(id=>$(id).addEventListener('change',()=>{requestId=null;updateQuote();}));
  $('amount').addEventListener('input',()=>{requestId=null;delayedQuote();});
  $('qrFile').addEventListener('change',()=>{requestId=null;const f=$('qrFile').files?.[0];
    if(!f){$('qrPreview').hidden=true;return;}
    const url=URL.createObjectURL(f);
    $('qrPreview').src=url;$('qrPreview').hidden=false;
    $('qrPreview').onload=()=>URL.revokeObjectURL(url);
  });
  $('newOrderBtn').addEventListener('click',()=>{
    token=null;history.replaceState(null,'','/order.html');$('orderForm').reset();requestId=null;
    $('orderStatus').hidden=true;$('newOrder').hidden=false;clearError();
    selectService('CASH_IN','WALK_IN');
  });
  $('orderForm').addEventListener('submit',async event=>{
    event.preventDefault();clearError();
    if(!quote)return error('Wait for a valid fee quote before submitting.');
    const btn=$('sendBtn');btn.disabled=true;btn.textContent='Submitting…';
    try{
      requestId ||= crypto.randomUUID();
      const imageData=service==='CASH_IN'?await compress($('qrFile').files?.[0]):null;
      const p={requestId,service,fulfillment,provider:$('provider').value,mode:$('mode').value,
        amount:$('amount').value,customerName:$('customerName').value,imageData,
        pickupAt:fulfillment==='PICKUP'?$('pickupAt').value:null};
      const result=await request('/',p);
      token=result.token;history.replaceState(null,'','/order.html?order='+encodeURIComponent(token));
      showStatus();
    }catch(e){error(e.message);}
    finally{btn.disabled=false;btn.textContent='Submit request';}
  });
  try{
    config=await request('/config');
    $('offline').hidden=config.enabled;$('sendBtn').disabled=!config.enabled;
    const params=new URLSearchParams(location.search),old=params.get('order');
    if(old&&/^[a-f0-9]{48}$/.test(old)){token=old;showStatus();}else selectService('CASH_IN','WALK_IN');
  }catch(e){error('Could not connect to CASHVERSE. '+e.message);}
  setInterval(status,10000);
}
init();
