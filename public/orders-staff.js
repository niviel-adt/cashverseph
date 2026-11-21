'use strict';
// Staff QR-order dashboard. All financial operations are authorized server-side.
(()=>{
  const $=id=>document.getElementById(id);
  let orders=[],filter='open',knownIds=null,loading=false,audioReady=false;
  const openStatuses=['NEW','RESERVED','IN_PROGRESS','AWAITING_APPROVAL'];
  const prettyStatus={NEW:'New',RESERVED:'Reserved',IN_PROGRESS:'Processing',
    AWAITING_APPROVAL:'Manager approval',COMPLETED:'Completed',REJECTED:'Rejected',EXPIRED:'Expired'};
  const serviceText=o=>o.service==='CASH_IN'?'Cash-in':o.fulfillment==='PICKUP'?'Cash-out pickup':'Walk-in cash-out';
  const dateText=v=>v?new Date(v).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}):'—';
  const f=m=>money(m);
  function toast(message){
    const t=$('ordersToast');t.textContent=message;t.hidden=false;
    setTimeout(()=>{if(t.textContent===message)t.hidden=true;},6500);
  }
  let audioCtx=null;
  function ding(){
    if(!$('ordersSound').checked)return;
    try{
      const Audio=window.AudioContext||window.webkitAudioContext;
      if(!Audio)return;
      audioCtx ||= new Audio();
      if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});
      const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
      osc.type='sine';osc.frequency.value=900;gain.gain.value=.045;
      gain.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.23);
      osc.connect(gain);gain.connect(audioCtx.destination);
      osc.start();osc.stop(audioCtx.currentTime+.23);
    }catch(e){}
  }
  function render(){
    const target=$('ordersList');
    const showing=orders.filter(o=>filter==='all'||filter==='open'&&openStatuses.includes(o.status)||
      filter==='PICKUP'&&o.fulfillment==='PICKUP'||o.service===filter);
    if(!showing.length){
      target.innerHTML='<p class="empty">No matching customer orders.</p>';
      return;
    }
    target.innerHTML=showing.map(o=>{
      const amount=o.service==='CASH_IN'?o.wallet_cents:o.cash_cents;
      let actions='';
      const button=(act,label)=>'<button type="button" class="btn outline tiny" data-order-act="'+act+
        '" data-order-id="'+esc(o.id)+'">'+esc(label)+'</button>';
      if(o.status==='NEW'&&o.fulfillment==='PICKUP'&&currentRole==='manager')actions+=button('claim','Accept & reserve');
      if(o.status==='NEW'&&o.fulfillment==='WALK_IN')actions+=button('claim','Start processing');
      if(o.status==='RESERVED')actions+=button('claim','Customer arrived');
      if(o.status==='IN_PROGRESS')actions+=button('finish','Verify & complete');
      if(o.status==='AWAITING_APPROVAL'&&currentRole==='manager')actions+=button('approve','Manager review');
      if(openStatuses.includes(o.status) && !(o.status==='AWAITING_APPROVAL'&&currentRole!=='manager'))
        actions+=button('reject','Reject');
      if(o.has_qr)actions+=button('qr','Receiving QR');
      if(o.service==='CASH_OUT')actions+=button('storeqr','Store QR');
      return '<article class="customer-order">'+
        '<div class="customer-order-head"><div><strong>'+esc(o.order_code)+'</strong>'+
        '<span class="order-service">'+esc(serviceText(o))+' • '+esc(labelProvider(o.provider))+'</span></div>'+
        '<span class="tag '+esc(o.status.toLowerCase())+'">'+esc(prettyStatus[o.status]||o.status)+'</span></div>'+
        '<div class="customer-order-values">'+
        '<div><small>Requested amount</small><strong>'+f(o.amount_cents)+'</strong></div>'+
        '<div><small>Service fee</small><strong>'+f(o.fee_cents)+'</strong></div>'+
        '<div><small>'+(o.service==='CASH_IN'?'Wallet transfer':'Cash payout')+'</small><strong>'+f(amount)+'</strong></div>'+
        '<div><small>'+(o.service==='CASH_IN'?'Cash collected':'Wallet incoming')+'</small><strong>'+
          f(o.service==='CASH_IN'?o.cash_cents:o.wallet_cents)+'</strong></div>'+
        '</div>'+
        '<div class="customer-order-meta"><span>Customer: '+esc(o.customer_name||'Not provided')+'</span>'+
        '<span>Created: '+esc(dateText(o.created_at))+'</span>'+
        (o.fulfillment==='PICKUP'?'<span>Pickup: '+esc(dateText(o.pickup_at))+'</span>':'')+
        (o.assigned_name?'<span>Handling: '+esc(o.assigned_name)+'</span>':'')+
        (o.payment_reference?'<span>Official reference: '+esc(o.payment_reference)+'</span>':'')+
        '</div><div class="customer-order-actions">'+actions+'</div></article>';
    }).join('');
  }
  async function refresh(silent=true){
    if(!currentRole||loading)return;
    loading=true;
    try{
      const [rows,s]=await Promise.all([api('/api/orders'),api('/api/orders/summary')]);
      orders=rows;
      const nowIds=new Set(rows.map(o=>o.id));
      if(knownIds){
        const fresh=rows.filter(o=>!knownIds.has(o.id)&&o.status==='NEW');
        if(fresh.length){toast('🔔 '+fresh.length+' new customer order'+(fresh.length===1?'':'s')+' received.');ding();}
      }
      knownIds=nowIds;
      const count=s.counts||{};
      const newCount=Number(count.NEW||0),processing=Number(count.IN_PROGRESS||0)+Number(count.RESERVED||0);
      $('ordersNewCount').textContent=newCount;
      $('ordersProcessingCount').textContent=processing;
      $('ordersApprovalsCount').textContent=Number(count.AWAITING_APPROVAL||0);
      const badge=$('orderBadge');
      badge.textContent=newCount+Number(count.AWAITING_APPROVAL||0);
      badge.hidden=Number(badge.textContent)===0;
      render();
      if(currentRole==='manager'&&s.drawer){
        $('drawerBalance').textContent=f(s.drawer.balanceCents);
        $('drawerHeld').textContent=f(s.drawer.heldCents);
        $('drawerAvailable').textContent=f(s.drawer.availableCents);
      }
      if(!silent)notify('Customer order queue updated.');
    }catch(e){if(!silent)notify(e.message,true);}
    finally{loading=false;}
  }
  async function refreshManager(){
    if(currentRole!=='manager')return;
    const [settings,drawer]=await Promise.all([api('/api/orders/config'),api('/api/orders/drawer')]);
    $('orderPublicEnabled').checked=settings.enabled;
    $('orderCashoutLimit').value=(settings.maxCashoutCents/100).toFixed(2);
    $('drawerBalance').textContent=f(drawer.balanceCents);
    $('drawerHeld').textContent=f(drawer.heldCents);
    $('drawerAvailable').textContent=f(drawer.availableCents);
    $('drawerButton').textContent=drawer.enabled?'Save cash adjustment':'Set opening cash';
    $('drawerHint').textContent=drawer.enabled
      ? 'Positive adds cash; negative deducts cash. Pickup reservations cannot be spent twice.'
      : 'Enter your actual opening physical cash. This enables cash drawer tracking for all new completed transactions.';
    $('drawerForm').dataset.initial=drawer.enabled?'false':'true';
  }
  async function imageData(file){
    if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Choose a PNG, JPG or WebP screenshot.');
    if(file.size>10*1024*1024)throw Error('Image must be under 10 MB.');
    const img=await createImageBitmap(file);
    try{
      const scale=Math.min(1,1100/Math.max(img.width,img.height));
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
      if(!canvas.width||!canvas.height)throw Error('Invalid screenshot.');
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      let data=canvas.toDataURL('image/png');
      if(data.length>800000)data=canvas.toDataURL('image/jpeg',.85);
      if(data.length>800000)throw Error('Screenshot too large. Crop to the QR code and try again.');
      return data;
    }finally{img.close();}
  }
  function openForm(order,action){
    const panel=$('orderFinishPanel');
    $('orderFinishId').value=order.id;
    $('orderFinishAction').value=action;
    $('orderFinishRef').value=order.payment_reference||'';
    $('orderFinishVerified').checked=false;$('orderFinishCash').checked=false;
    $('orderFinishTitle').textContent=(action==='approve'?'Manager verification: ':'Verify: ')+order.order_code;
    $('orderFinishSubmit').textContent=action==='approve'?'Approve and complete':'Submit verified order';
    $('orderCashConfirmLabel').textContent=order.service==='CASH_IN'
      ? 'Cash was collected and wallet transfer was completed.'
      : (currentRole==='cashier'&&action==='finish'
        ? 'Cash payout is prepared and will only be released when authorized.'
        : 'Physical cash will be handed over to the customer once this verification is complete.');
    $('orderCashConfirmHint').textContent=order.service==='CASH_OUT'
      ? 'For manager-approval orders, cashier must NOT hand out the cash until the manager approves.'
      : 'Confirm the customer has paid physical cash and the official wallet transfer succeeded.';
    panel.hidden=false;panel.scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function act(event){
    const btn=event.target.closest('[data-order-act]');if(!btn)return;
    const id=btn.dataset.orderId,action=btn.dataset.orderAct;
    const order=orders.find(x=>x.id===id);if(!order)return;
    if(action==='qr'||action==='storeqr'){
      const url=action==='qr'?'/api/orders/'+encodeURIComponent(id)+'/qr':
        '/api/orders/store-qr/'+encodeURIComponent(order.provider);
      window.open(url,'_blank','noopener');
      return;
    }
    if(action==='finish'||action==='approve'){openForm(order,action);return;}
    let body={};
    if(action==='reject'){
      const reason=window.prompt('Why should this order be rejected?');
      if(!reason||!reason.trim())return;
      body={reason};
    }else if(action==='claim'&&order.fulfillment==='PICKUP'&&order.status==='NEW'){
      if(!confirm('Accept this pickup reservation and hold '+f(order.cash_cents)+' of physical cash?'))return;
    }
    btn.disabled=true;
    try{
      await api('/api/orders/'+encodeURIComponent(id)+'/'+action,'POST',body);
      await refresh(false);
    }catch(e){notify(e.message,true);}
    finally{btn.disabled=false;}
  }
  function init(){
    const sound=$('ordersSound');
    sound.checked=localStorage.getItem('cashverseOrderSound')==='1';
    sound.addEventListener('change',()=>{
      localStorage.setItem('cashverseOrderSound',sound.checked?'1':'0');
      if(sound.checked)ding();
    });
    document.querySelectorAll('[data-order-filter]').forEach(btn=>btn.addEventListener('click',()=>{
      filter=btn.dataset.orderFilter;
      document.querySelectorAll('[data-order-filter]').forEach(el=>el.classList.toggle('active',el===btn));
      render();
    }));
    $('ordersRefreshBtn').addEventListener('click',async()=>{await refresh(false);if(currentRole==='manager')await refreshManager();});
    $('ordersList').addEventListener('click',act);
    $('orderFinishCancel').addEventListener('click',()=>{$('orderFinishPanel').hidden=true;});
    $('orderFinishForm').addEventListener('submit',async ev=>{
      ev.preventDefault();
      const btn=$('orderFinishSubmit');btn.disabled=true;
      try{
        const id=$('orderFinishId').value,action=$('orderFinishAction').value;
        if(!confirm('You independently verified this payment in the official wallet app. Confirm order completion?'))return;
        const r=await api('/api/orders/'+encodeURIComponent(id)+'/'+action,'POST',{
          verified:$('orderFinishVerified').checked,cashConfirmed:$('orderFinishCash').checked,
          reference:$('orderFinishRef').value.trim()
        });
        $('orderFinishPanel').hidden=true;$('orderFinishForm').reset();
        await refresh();
        if(currentRole==='manager'){
          await Promise.all([refreshDashboard(),refreshHistory(),refreshReport(),refreshManager()]);
        }
        notify(r.status==='AWAITING_APPROVAL'?'Sent to manager approval. Do not release cash yet.'
          :'Order completed and shared wallet/cash ledger updated.');
      }catch(e){notify(e.message,true);}
      finally{btn.disabled=false;}
    });
    $('orderSettingsForm').addEventListener('submit',async ev=>{
      ev.preventDefault();const btn=ev.currentTarget.querySelector('[type=submit]');btn.disabled=true;
      try{
        const enabled=$('orderPublicEnabled').checked;
        if(enabled && !confirm('Enable public customer orders? Verify current wallet floats, cash drawer and uploaded rates first.')){
          return;
        }
        await api('/api/orders/config','POST',{enabled,maxCashout:$('orderCashoutLimit').value});
        notify(enabled?'Customer QR orders are now open.':'Customer QR orders are disabled.');
        await refreshManager();
      }catch(e){notify(e.message,true);}finally{btn.disabled=false;}
    });
    $('drawerForm').addEventListener('submit',async ev=>{
      ev.preventDefault();const btn=$('drawerButton');btn.disabled=true;
      try{
        const initial=$('drawerForm').dataset.initial==='true';
        if(!confirm((initial?'Initialize cash drawer with ':'Adjust physical cash by ')+$('drawerAmount').value+' pesos?'))return;
        await api('/api/orders/drawer/adjust','POST',{
          amount:$('drawerAmount').value,reason:$('drawerReason').value,initial
        });
        $('drawerForm').reset();
        await Promise.all([refreshManager(),refresh()]);
        notify(initial?'Cash drawer initialized.':'Cash drawer adjustment saved.');
      }catch(e){notify(e.message,true);}finally{btn.disabled=false;}
    });
    $('storeQrForm').addEventListener('submit',async ev=>{
      ev.preventDefault();const btn=ev.currentTarget.querySelector('[type=submit]');btn.disabled=true;
      try{
        const data=await imageData($('storeQrFile').files?.[0]);
        await api('/api/orders/store-qr','POST',{provider:$('storeQrProvider').value,imageData:data});
        $('storeQrForm').reset();notify('Authorized store receiving QR saved for logged-in staff.');
      }catch(e){notify(e.message,true);}finally{btn.disabled=false;}
    });
    setInterval(()=>{if(currentRole&&document.visibilityState==='visible')refresh();},8000);
  }
  window.cashverseOrders={refresh,refreshManager};
  init();
})();
