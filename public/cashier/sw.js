// Only handle navigation. API requests and receipts always use the network.
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<meta name="viewport" content="width=device-width"><main style="font:18px system-ui;margin:3rem 1rem"><h1>Cashverse Cashier</h1><p>Reconnect to check your transaction or start a new one.</p><a href="/cashier/">Try again</a></main>',
    {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});
