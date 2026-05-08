-- ═══════════════════════════════════════════════════════════════════════════
-- CRON: sync-magazord — diário às 06:35 BRT (09:35 UTC)
-- ═══════════════════════════════════════════════════════════════════════════
-- Roda 10 minutos depois do sync-ml-ads (06:25 BRT) pra não competir.
-- Recurso 'all' com dias_atras=7 (incremental). Pessoas/produtos/categorias
-- também atualizam (são rápidos: <30s combinados).
--
-- Pattern do JWT segue o mesmo das outras 19 crons existentes (anon inline).
-- ═══════════════════════════════════════════════════════════════════════════

-- Limpa cron antigo se existir (idempotente)
DO $$
DECLARE jid INT;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'sync-magazord-diario' LIMIT 1;
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;

-- Agenda
SELECT cron.schedule(
  'sync-magazord-diario',
  '35 9 * * *',                            -- 09:35 UTC = 06:35 BRT
  $$
  SELECT net.http_post(
    url := 'https://wltmiqbhziefusnzmmkt.supabase.co/functions/v1/sync-magazord',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsdG1pcWJoemllZnVzbnptbWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NzUxMzEsImV4cCI6MjA5MjQ1MTEzMX0.GfdryMC-RTnp2h-6RSHf1WBVYCCTfGtqHAXtilYHzTY"}'::jsonb,
    body := '{"recurso":"all","dias_atras":7}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- Validação
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'sync-magazord-diario';
