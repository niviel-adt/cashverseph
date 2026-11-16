'use strict';

const byId = id => document.getElementById(id);
const money = cents => '₱' + (Number(cents || 0) / 100).toLocaleString('en-PH', {minimumFractionDigits:2,maximumFractionDigits:2});
const signedMoney = cents => (Number(cents)<0?'-':'+') + money(Math.abs(Number(cents)));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[char]);
const labelProvider = p => p === 'GCASH' ? 'GCash' : 'Maya';
const labelType = t => t === 'CASH_IN' ? 'Cash-in' : 'Cash-out';
const labelMode = t => t === 'ADD' ? 'Added' : 'Deducted';
const datePh = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date());
  const p = name => parts.find(x => x.type === name).value;
  return p('year') + '-' + p('month') + '-' + p('day');
};
const timePh = d => new Date(d).toLocaleString('en-PH', {
  timeZone:'Asia/Manila',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'
});
let historyRows = [];
let quoteSequence = 0;
let quoteTimer;

async function api(url,method='GET',body) {
  const opts = {method,headers:{}};
  if(body!==undefined) {
    opts.headers['Content-Type']='application/json';
    opts.body=JSON.stringify(body);
  }
  let response;
  try{response=await fetch(url,opts);}
  catch(e){throw new Error('Could not connect to the server. Check your internet connection.');}
  const data = await response.json().catch(()=>({error:'Server returned an invalid response.'}));
  if(!response.ok) {
    if(response.status===401 && url!=='/api/login') showAuth();
    throw new Error(data.error||'Request failed.');
  }
  return data;
}
function notify(message,failed=false) {
  const el=byId('notice');
  el.textContent=message;
  el.classList.toggle('danger',failed);
  el.hidden=false;
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function clearNotice(){byId('notice').hidden=true;}
function showAuth() {
  byId('loginScreen').hidden=false;
  byId('appScreen').hidden=true;
}
function showApp() {
  byId('loginScreen').hidden=true;
  byId('appScreen').hidden=false;
}
function showPage(page) {
  clearNotice();
  document.querySelectorAll('.page').forEach(el=>{el.hidden=el.id!=='page-'+page;});
  document.querySelectorAll('.nav-btn').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
  if(page==='transaction') updateQuote();
  window.scrollTo({top:0,behavior:'smooth'});
}
function table(headings,rows) {
  if(!rows.length)return '<p class="empty">Nothing to show yet.</p>';
  return '<table><thead><tr>'+headings.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
function statusTag(status) {
  return '<span class="tag '+esc(status.toLowerCase())+'">'+esc(status)+'</span>';
}
function txColumns(t) {
  return [
    '<strong>'+esc(timePh(t.created_at))+'</strong>',
    esc(labelProvider(t.provider)),
    esc(labelType(t.type)),
    '<strong>'+money(t.amount_cents)+'</strong>',
    money(t.fee_cents),
    statusTag(t.status)
  ];
}
async function refreshDashboard() {
  const data=await api('/api/dashboard');
  const map=Object.fromEntries(data.wallets.map(w=>[w.provider,w.balanceCents]));
  byId('gcashFloat').textContent=money(map.GCASH);
  byId('mayaFloat').textContent=money(map.MAYA);
  byId('gcashFloat2').textContent=money(map.GCASH);
  byId('mayaFloat2').textContent=money(map.MAYA);
  byId('todayEarnings').textContent=money(data.today.feesCents);
  byId('todayCount').textContent=data.today.count;
  byId('summaryCompleted').textContent=data.today.count;
  byId('summaryPending').textContent=data.pending;
  byId('summaryFees').textContent=money(data.today.feesCents);
}
async function refreshHistory() {
  historyRows=await api('/api/transactions');
  const cols=['Date','Wallet','Service','Amount','Fee','Status'];
  byId('recentList').innerHTML=table(cols,historyRows.slice(0,5).map(txColumns));
  const rows=historyRows.map(t=>{
    const actions=t.status==='PENDING' ?
      '<button class="table-action" data-action="complete" data-id="'+esc(t.id)+'">Complete</button>'+
      '<button class="table-action fail" data-action="fail" data-id="'+esc(t.id)+'">Fail</button>' : '—';
    return [
      ...txColumns(t),esc(labelMode(t.mode)),money(t.cash_cents),
      esc(t.reference||'—'),esc(t.notes||'—'),actions
    ];
  });
  byId('historyTable').innerHTML=table(
    ['Date','Wallet','Service','Amount','Fee','Status','Fee mode','Cash amount','Reference','Notes','Actions'],rows);
}
async function refreshAdjustments() {
  const rows=await api('/api/adjustments');
  byId('adjustmentList').innerHTML=table(['Date','Wallet','Change','Reason'],
    rows.map(r=>[esc(timePh(r.created_at)),esc(labelProvider(r.provider)),
      '<strong>'+signedMoney(r.delta_cents)+'</strong>',esc(r.reason)]));
}
async function refreshRates() {
  const rows=await api('/api/rates');
  byId('rateCount').textContent=rows.length+' rule'+(rows.length===1?'':'s');
  byId('rateList').innerHTML=table(['Wallet','Service','From','To','Fee'],
    rows.map(r=>[
      esc(labelProvider(r.provider)),esc(labelType(r.type)),
      money(r.min_cents),money(r.max_cents),'<strong>'+money(r.fee_cents)+'</strong>'
    ]));
}
async function refreshReport() {
  const date=byId('reportDate').value||datePh();
  const report=await api('/api/report?date='+encodeURIComponent(date));
  byId('reportEarnings').textContent=money(report.totalFeesCents);
  byId('reportCount').textContent=report.totalCount;
  byId('reportTable').innerHTML=table(['Wallet','Service','Transactions','Base total','Earnings'],
    report.rows.map(r=>[esc(labelProvider(r.provider)),esc(labelType(r.type)),String(r.count),
      money(r.amount_cents),'<strong>'+money(r.fees_cents)+'</strong>']));
}

function payloadTransaction() {
  return {
    provider:byId('txProvider').value,
    type:byId('txType').value,
    mode:byId('txMode').value,
    amount:byId('txAmount').value
  };
}
async function updateQuote() {
  const seq=++quoteSequence,p=payloadTransaction();
  byId('quoteDetails').hidden=true;
  byId('quoteState').hidden=false;
  if(!p.amount||Number(p.amount)<=0) {
    byId('quoteState').textContent='Enter an amount to see the uploaded rate.';
    return;
  }
  byId('quoteState').textContent='Looking up your service fee…';
  try {
    const url='/api/quote?'+new URLSearchParams(p).toString();
    const q=await api(url);
    if(seq!==quoteSequence)return;
    byId('quoteAmount').textContent=money(q.amountCents);
    byId('quoteFee').textContent=money(q.feeCents);
    byId('quoteWallet').textContent=money(q.walletCents);
    byId('quoteCash').textContent=money(q.cashCents);
    byId('quoteCashLabel').textContent=q.type==='CASH_IN'?'Customer pays in cash':'Customer receives in cash';
    byId('quoteFloat').textContent=q.type==='CASH_IN'
      ? 'Your '+labelProvider(q.provider)+' float decreases by '+money(q.walletCents)+'.'
      : 'Your '+labelProvider(q.provider)+' float increases by '+money(q.walletCents)+'.';
    byId('quoteState').hidden=true;
    byId('quoteDetails').hidden=false;
  } catch(e) {if(seq===quoteSequence)byId('quoteState').textContent=e.message;}
}
function queueQuote() {
  clearTimeout(quoteTimer);
  quoteTimer=setTimeout(updateQuote,250);
}
async function loadAll(){
  await Promise.all([refreshDashboard(),refreshHistory(),refreshReport(),refreshAdjustments(),refreshRates()]);
}
function wire(){
  byId('loginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const btn=event.currentTarget.querySelector('button');
    btn.disabled=true;byId('loginError').textContent='';
    try{
      await api('/api/login','POST',{password:byId('loginPassword').value});
      byId('loginPassword').value='';
      showApp();showPage('overview');await loadAll();
    }catch(e){byId('loginError').textContent=e.message;}
    finally{btn.disabled=false;}
  });
  byId('logoutBtn').addEventListener('click',async()=>{
    try{await api('/api/logout','POST',{});showAuth();}
    catch(e){notify(e.message,true);}
  });
  document.querySelectorAll('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>showPage(btn.dataset.page)));
  document.querySelectorAll('[data-go]').forEach(btn=>btn.addEventListener('click',()=>{
    if(btn.dataset.setType){
      byId('txType').value=btn.dataset.setType;
      byId('txMode').value=btn.dataset.setType==='CASH_OUT'?'DEDUCT':'ADD';
    }
    showPage(btn.dataset.go);
  }));
  byId('txType').addEventListener('change',()=>{
    byId('txMode').value=byId('txType').value==='CASH_IN'?'ADD':'DEDUCT';
    updateQuote();
  });
  ['txProvider','txMode'].forEach(id=>byId(id).addEventListener('change',updateQuote));
  byId('txAmount').addEventListener('input',queueQuote);
  byId('transactionForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const btn=byId('saveTxBtn');
    const p={...payloadTransaction(),reference:byId('txReference').value,
      notes:byId('txNotes').value,verified:byId('txVerified').checked};
    if(p.verified&&!window.confirm('Have you verified the real transfer in the official '+labelProvider(p.provider)+' app?'))
      return;
    btn.disabled=true;
    try{
      const data=await api('/api/transactions','POST',p);
      byId('txAmount').value='';
      byId('txReference').value='';
      byId('txNotes').value='';
      byId('txVerified').checked=false;
      await Promise.all([refreshDashboard(),refreshHistory(),refreshReport()]);
      showPage('history');
      notify('Transaction saved as '+data.status.toLowerCase()+'.');
    }catch(e){notify(e.message,true);}
    finally{btn.disabled=false;updateQuote();}
  });
  byId('historyTable').addEventListener('click',async e=>{
    const btn=e.target.closest('[data-action]');
    if(!btn)return;
    const id=btn.dataset.id,action=btn.dataset.action;
    const message=action==='complete'
      ? 'Verify this transfer in the official wallet app first. Mark this transaction Completed?'
      : 'Mark this pending transaction Failed? No wallet float will be changed.';
    if(!window.confirm(message))return;
    btn.disabled=true;
    try{
      await api('/api/transactions/'+encodeURIComponent(id)+'/'+action,'POST',
        action==='complete'?{verified:true}:{});
      await Promise.all([refreshDashboard(),refreshHistory(),refreshReport()]);
      notify('Transaction updated.');
    }catch(err){notify(err.message,true);}
    finally{btn.disabled=false;}
  });
  byId('refreshHistory').addEventListener('click',async()=>{
    try{await refreshHistory();notify('Transaction history updated.');}
    catch(e){notify(e.message,true);}
  });
  byId('adjustForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const btn=e.currentTarget.querySelector('button');
    btn.disabled=true;
    try{
      await api('/api/adjustments','POST',{
        provider:byId('adjustProvider').value,
        amount:byId('adjustAmount').value,reason:byId('adjustReason').value
      });
      byId('adjustAmount').value='';byId('adjustReason').value='';
      await Promise.all([refreshDashboard(),refreshAdjustments()]);
      notify('Wallet float updated.');
    }catch(err){notify(err.message,true);}
    finally{btn.disabled=false;}
  });
  byId('loadReportBtn').addEventListener('click',async()=>{
    try{await refreshReport();clearNotice();}catch(e){notify(e.message,true);}
  });
  byId('ratesForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const file=byId('ratesFile').files[0];
    if(!file)return notify('Choose a CSV file first.',true);
    if(file.size>100000)return notify('CSV file must be under 100 KB.',true);
    if(!window.confirm('Replace the entire active service rate list with this CSV?'))return;
    const btn=e.currentTarget.querySelector('button');btn.disabled=true;
    try{
      const result=await api('/api/rates/import','POST',{csv:await file.text()});
      byId('ratesFile').value='';
      await refreshRates();
      notify('Uploaded '+result.imported+' rate rules successfully.');
    }catch(err){notify(err.message,true);}
    finally{btn.disabled=false;updateQuote();}
  });
}
async function boot(){
  byId('reportDate').value=datePh();
  wire();
  try{
    const me=await api('/api/me');
    if(me.loggedIn){
      showApp();showPage('overview');
      await loadAll();
    }else showAuth();
  }catch(e){
    showAuth();
    byId('loginError').textContent='Unable to reach the server. Please refresh the page.';
  }
}
boot();
