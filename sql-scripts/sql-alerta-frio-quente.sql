-- ══════════════════════════════════════════════════════════════════════════
-- ALERTA: Lead esquentou (frio→quente em <7d)
-- ══════════════════════════════════════════════════════════════════════════
-- Detecta quando um lead que estava FRIO (lead_score < 40) virou QUENTE
-- (lead_score >= 70) numa janela de até 7 dias entre 2 qualificações.
-- Pattern segue sql-alertas-personalizados.sql:
--   - Função plpgsql gerar_alertas_frio_quente()
--   - Insert em alertas com destinatario_id (criado_por do prospect)
--   - Anti-spam: 1 alerta por prospect por dia
--   - Cron diário 09:30 BRT (depois do alerta de prazos das 9h)
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION gerar_alertas_frio_quente() RETURNS void AS $$
DECLARE
  r RECORD;
  v_destinatario_id UUID;
  v_destinatario_nome TEXT;
  v_dias INT;
BEGIN
  -- Pra cada prospect que teve qualificação nos últimos 7d:
  -- compara última (atual) com a penúltima (anterior)
  -- e gera alerta se houve transição frio (<40) → quente (>=70)
  FOR r IN
    WITH ranked AS (
      SELECT prospect_id, lead_score, created_at,
             ROW_NUMBER() OVER (PARTITION BY prospect_id ORDER BY created_at DESC) AS rn
      FROM lead_qualificacao
      WHERE prospect_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '14 days'
    ),
    atual AS (
      SELECT prospect_id, lead_score, created_at FROM ranked WHERE rn = 1
    ),
    anterior AS (
      SELECT prospect_id, lead_score, created_at FROM ranked WHERE rn = 2
    )
    SELECT a.prospect_id,
           a.lead_score AS score_atual,
           p.lead_score AS score_anterior,
           a.created_at AS atual_at,
           p.created_at AS anterior_at,
           EXTRACT(DAY FROM (a.created_at - p.created_at))::INT AS dias_entre
    FROM atual a
    JOIN anterior p ON p.prospect_id = a.prospect_id
    WHERE a.lead_score >= 70
      AND p.lead_score < 40
      AND a.created_at - p.created_at <= INTERVAL '7 days'
      AND a.created_at >= NOW() - INTERVAL '24 hours'  -- só transições do último dia (evita re-alertar dias passados)
  LOOP
    -- Resolver destinatário: criado_por do prospect (vendedora que criou o lead)
    SELECT pr.criado_por,
           COALESCE(prof.nome, 'Vendedora')
      INTO v_destinatario_id, v_destinatario_nome
    FROM prospects pr
    LEFT JOIN profiles prof ON prof.id = pr.criado_por
    WHERE pr.id = r.prospect_id
    LIMIT 1;

    -- Sem destinatário identificado → pula
    IF v_destinatario_id IS NULL THEN CONTINUE; END IF;

    -- Anti-spam: 1 alerta por prospect por dia
    IF EXISTS (
      SELECT 1 FROM alertas
      WHERE destinatario_id = v_destinatario_id
        AND dados->>'prospect_id' = r.prospect_id::text
        AND dados->>'tipo' = 'lead_esquentou'
        AND created_at >= current_date
    ) THEN CONTINUE; END IF;

    v_dias := GREATEST(1, r.dias_entre);  -- evita "0 dias" (mesmo dia)

    INSERT INTO alertas(
      tipo, titulo, mensagem, nivel, lido,
      destinatario_id, destinatario_nome,
      link_ref, link_label, dados
    )
    VALUES (
      'lead_esquentou',
      '🔥 Lead esquentou em ' || v_dias || ' dia' || CASE WHEN v_dias = 1 THEN '' ELSE 's' END || '!',
      (SELECT 'O lead "' || COALESCE(p.nome, 'sem nome') || '" subiu de '
              || r.score_anterior || ' (frio) pra ' || r.score_atual || ' (quente) em ' || v_dias
              || ' dia' || CASE WHEN v_dias = 1 THEN '' ELSE 's' END
              || '. Aja agora antes que esfrie.'
       FROM prospects p WHERE p.id = r.prospect_id),
      'urgent',
      false,
      v_destinatario_id,
      v_destinatario_nome,
      'prospeccao',
      'Abrir lead',
      jsonb_build_object(
        'prospect_id', r.prospect_id,
        'tipo', 'lead_esquentou',
        'score_atual', r.score_atual,
        'score_anterior', r.score_anterior,
        'dias_entre', v_dias
      )
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Cron diário 09:30 BRT (12:30 UTC) ──
DO $$
DECLARE jid INT;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'gerar-alertas-frio-quente-diario' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'gerar-alertas-frio-quente-diario',
  '30 12 * * *',                            -- 12:30 UTC = 09:30 BRT
  $$ SELECT gerar_alertas_frio_quente(); $$
);

-- ── Validação: ver job criado ──
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'gerar-alertas-frio-quente-diario';

-- Reverter:
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='gerar-alertas-frio-quente-diario';
--   DROP FUNCTION IF EXISTS gerar_alertas_frio_quente();
