const SUPABASE_URL = 'https://comlppiwzniskjbeneos.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvbWxwcGl3em5pc2tqYmVuZW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwODg2MjYsImV4cCI6MjA5MTY2NDYyNn0.jQOYaPklzSxQxTUd7rzktljHpW7ivbxbtilsUUi-TBE';

async function invoke(body) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/sync-pedidos-vendedor-backfill`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok ? await r.json() : { error: `${r.status} ${await r.text()}` };
}

let iter = 0;
const inicio = Date.now();
while (true) {
  iter++;
  const t0 = Date.now();
  const res = await invoke({ inicio: '2026-01-01', limite: 50 });
  const dt = Math.round((Date.now() - t0) / 1000);
  const elapsed = Math.round((Date.now() - inicio) / 60);
  if (res.error) {
    console.log(`[${iter}] ERRO (${dt}s):`, res.error);
    await new Promise(r => setTimeout(r, 10000));
    continue;
  }
  console.log(`[${iter}] (${dt}s, total ${elapsed}min) atualizados=${res.atualizados} sem-vend=${res.sem_vendedor} restam=${res.falta_ainda}`);
  if (res.completo || res.falta_ainda === 0) {
    console.log('\n✅ BACKFILL COMPLETO após', iter, 'iterações e', elapsed, 'minutos');
    break;
  }
  await new Promise(r => setTimeout(r, 3000));
}
