'use strict';
const el=id=>document.getElementById(id);
const amount=cents=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(cents/100);
const form=el('details');
let username='', draft=null, pending=false;
const storageKey=()=>'cashverse.cashier.pending.'+username;
function show(id,message=''){
  for(const page of ['auth','entry','review','receipt'])el(page).hidden=page!==id;
  el('message').textContent=message;
}
async function api(path,body){
  const options=body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{};
  const response=await fetch('/api/'+path,{...options,cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.error||'Request failed.'),{status:response.status});
  return data;
}
function reset(){
  username='';draft=null;pending=false;form.reset();el('logout').hidden=true;
}
function review(){
  const {payload:p,quote:q}=draft;
  const cashIn=p.type==='CASH_IN';
  el('heading').textContent=pending?'Check transaction':'Review transaction';
  el('summary').textContent=(p.provider==='GCASH'?'GCash':'Maya')+' · '+(cashIn?'Cash in':'Cash out')+' · Requested '+amount(q.amountCents);
  el('cash').textContent=(cashIn?'Collect ':'Give customer ')+amount(q.cashCents)+' in cash';
  el('fee').textContent='Wallet transfer '+amount(q.walletCents)+' · Service fee '+amount(q.feeCents);
  el('statusHint').textContent=p.verified?'Transfer verified. Your store’s approval setting applies.':'This will be recorded as pending.';
  el('back').hidden=pending;
  el('confirm').textContent=pending?'Check or retry safely':'Record transaction';
  show('review',pending?'Confirmation pending. Retry this same entry to get its receipt.':'');
}
async function session(){
  const me=await api('me');
  reset();
  if(!me.loggedIn){show('auth');return;}
  el('logout').hidden=false;
  if(me.role!=='cashier'){show(null,'A manager is signed in. Sign out to use a cashier account here.');return;}
  username=me.username;
  const saved=localStorage.getItem(storageKey());
  if(saved){draft=JSON.parse(saved);pending=true;review();}
  else show('entry');
}
function action(node,event,fn){
  node.addEventListener(event,async e=>{
    e.preventDefault();
    const button=node.tagName==='FORM'?node.querySelector('button'):node;
    if(button.disabled)return;
    button.disabled=true;
    try{await fn();}
    catch(err){
      if(err.status===401){reset();show('auth','Sign in again to continue.');}
      else el('message').textContent=err.message||'Connection lost. Reconnect and try again.';
    }finally{button.disabled=false;}
  });
}
action(el('login'),'submit',async()=>{
  const login=el('login');
  await api('login',{...Object.fromEntries(new FormData(login)),cashierOnly:true});
  login.reset();await session();
});
action(el('logout'),'click',async()=>{await api('logout',{});reset();show('auth');});
form.elements.type.onchange=()=>{form.elements.mode.value=form.elements.type.value==='CASH_IN'?'ADD':'DEDUCT';};
action(form,'submit',async()=>{
  const p=Object.fromEntries(new FormData(form));
  p.verified=form.elements.verified.checked;
  const quote=await api('quote?'+new URLSearchParams({type:p.type,provider:p.provider,amount:p.amount,mode:p.mode}));
  draft={payload:{...p,requestId:crypto.randomUUID(),cashierUsername:username,expectedFeeCents:quote.feeCents},quote};
  pending=false;review();
});
el('back').onclick=()=>{if(!pending)show('entry');};
action(el('confirm'),'click',async()=>{
  localStorage.setItem(storageKey(),JSON.stringify(draft));
  pending=true;review();el('logout').disabled=true;
  try{
    const result=await api('transactions',draft.payload);
    if(!result.id||!['COMPLETED','PENDING'].includes(result.status))throw Error('Receipt unavailable. Retry to confirm.');
    localStorage.removeItem(storageKey());
    draft=null;pending=false;form.reset();
    el('result').textContent=result.status==='COMPLETED'?'Completed · Wallet balance updated.':
      (result.approvalRequired?'Pending · Awaiting manager approval.':'Pending · Awaiting verification.');
    el('ref').textContent='Record ID '+result.id;show('receipt');
  }catch(err){
    if([400,409].includes(err.status)){
      localStorage.removeItem(storageKey());pending=false;show('entry');
    }
    throw err;
  }finally{el('logout').disabled=false;}
});
el('next').onclick=()=>show('entry');
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
session().catch(()=>show('auth','Unable to open the cashier session. Reconnect and sign in.'));
