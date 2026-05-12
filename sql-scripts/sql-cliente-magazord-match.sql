-- ═══════════════════════════════════════════════════════════════════════════
-- CACHE PRÉ-COMPUTADO: cliente_tem_magazord
-- ═══════════════════════════════════════════════════════════════════════════
-- Cruza contatos Bling (tabela `contatos`) com pedidos do site Magazord
-- (tabela `magazord_pedidos.pessoa_nome`). Evita ILIKE custoso a cada abertura
-- do C360 (5720 pessoas × N contatos).
--
-- Estratégia em 2 níveis:
--   1) match exato por nome normalizado (LOWER+TRIM)
--   2) fallback por núcleo PJ (remove EIRELI/LTDA/SA/ME/EPP/MEI/CIA)
--   3) [futuro] match exato por CPF/CNPJ quando Magazord liberar /v2/site/cliente
--
-- Atualizado por cron noturno (06:50 BRT, 15min após sync-magazord).
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tabela cache ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cliente_tem_magazord (
  contato_nome              TEXT NOT NULL,                -- nome original do Bling
  contato_nome_normalizado  TEXT NOT NULL,                -- LOWER(TRIM(nome)) ou nucleo PJ
  qtd_pedidos               INT NOT NULL DEFAULT 0,
  total_gasto               NUMERIC(12,2) NOT NULL DEFAULT 0,
  primeiro_pedido           TIMESTAMPTZ,
  ultimo_pedido             TIMESTAMPTZ,
  match_strategy            TEXT NOT NULL,                -- 'nome' | 'nucleo_pj' | 'cpf'
  cpf_cnpj                  TEXT,                         -- preenche quando Magazord liberar /cliente
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contato_nome_normalizado)
);

CREATE INDEX IF NOT EXISTS idx_ctm_cpf       ON cliente_tem_magazord(cpf_cnpj) WHERE cpf_cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ctm_strategy  ON cliente_tem_magazord(match_strategy);
CREATE INDEX IF NOT EXISTS idx_ctm_qtd       ON cliente_tem_magazord(qtd_pedidos DESC) WHERE qtd_pedidos > 0;

-- ── 2. Função utilitária: normaliza nome (LOWER + trim + remove sufixo PJ) ──
CREATE OR REPLACE FUNCTION _ctm_normalizar(p_nome TEXT)
RETURNS TEXT
LANGUAGE SQL IMMUTABLE
AS $$
  SELECT LOWER(TRIM(REGEXP_REPLACE(
    REGEXP_REPLACE(
      COALESCE(p_nome, ''),
      '\s*[-–]\s*(eireli|ltda|s\.?\s*a\.?|s\/a|me|epp|mei|cia|s\.?\s*c\.?|empresa\s+individual)\b.*$',
      '',
      'gi'
    ),
    '\s+(eireli|ltda|s\.?\s*a\.?|s\/a|me|epp|mei|cia|s\.?\s*c\.?)\.?\s*$',
    '',
    'gi'
  )));
$$;

-- ── 3. RPC: refresh completo do cache ──────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_cliente_tem_magazord()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Limpa rows antigas (vamos recalcular tudo do zero pra evitar drift)
  TRUNCATE cliente_tem_magazord;

  -- Agrupa pedidos Magazord por nome normalizado + matche com contatos Bling
  INSERT INTO cliente_tem_magazord (
    contato_nome,
    contato_nome_normalizado,
    qtd_pedidos,
    total_gasto,
    primeiro_pedido,
    ultimo_pedido,
    match_strategy,
    cpf_cnpj,
    synced_at
  )
  WITH magazord_agregado AS (
    -- Agrega pedidos do Magazord por nome normalizado
    SELECT
      pessoa_nome AS nome_original,
      _ctm_normalizar(pessoa_nome) AS nome_normalizado,
      COUNT(*) AS qtd,
      SUM(valor_total) AS total,
      MIN(data_hora) AS primeiro,
      MAX(data_hora) AS ultimo,
      MAX(pessoa_cpf_cnpj) AS cpf
    FROM magazord_pedidos
    WHERE pessoa_nome IS NOT NULL
    GROUP BY pessoa_nome
  ),
  contatos_normalizados AS (
    -- Normaliza nomes dos contatos Bling pra busca
    SELECT DISTINCT
      nome AS contato_nome_orig,
      _ctm_normalizar(nome) AS contato_norm
    FROM contatos
    WHERE nome IS NOT NULL AND TRIM(nome) <> ''
  ),
  matches AS (
    -- INNER JOIN: só clientes Bling que tem pedido Magazord
    SELECT DISTINCT ON (c.contato_norm)
      c.contato_nome_orig,
      c.contato_norm,
      m.qtd,
      m.total,
      m.primeiro,
      m.ultimo,
      m.cpf,
      CASE
        WHEN c.contato_norm = LOWER(TRIM(m.nome_original)) THEN 'nome'
        ELSE 'nucleo_pj'
      END AS strategy
    FROM contatos_normalizados c
    INNER JOIN magazord_agregado m ON m.nome_normalizado = c.contato_norm
    ORDER BY c.contato_norm, m.qtd DESC
  )
  SELECT
    contato_nome_orig,
    contato_norm,
    qtd,
    total,
    primeiro,
    ultimo,
    strategy,
    cpf,
    NOW()
  FROM matches;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ── 4. RLS: leitura pros 5 cargos + vendedora ──────────────────────────────
ALTER TABLE cliente_tem_magazord ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ctm_select_authorized ON cliente_tem_magazord;
DROP POLICY IF EXISTS ctm_admin ON cliente_tem_magazord;

CREATE POLICY ctm_select_authorized ON cliente_tem_magazord FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM profiles
  WHERE id = auth.uid()
    AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')
));

CREATE POLICY ctm_admin ON cliente_tem_magazord FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

-- ── 5. Cron diário 06:50 BRT (09:50 UTC) — 15min após sync-magazord ────────
DO $$
DECLARE jid INT;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'cron-cliente-tem-magazord' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'cron-cliente-tem-magazord',
  '50 9 * * *',                            -- 09:50 UTC = 06:50 BRT
  $$ SELECT refresh_cliente_tem_magazord(); $$
);

-- ── 6. Execução inicial (popula imediatamente) ─────────────────────────────
SELECT refresh_cliente_tem_magazord() AS rows_inseridas;

-- ═══════════════════════════════════════════════════════════════════════════
-- Validação rápida
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  match_strategy,
  COUNT(*) AS qtd_clientes,
  SUM(qtd_pedidos) AS pedidos_total,
  ROUND(SUM(total_gasto)::NUMERIC, 2) AS gasto_total
FROM cliente_tem_magazord
GROUP BY match_strategy
ORDER BY qtd_clientes DESC;

-- Top 10 clientes pelo cruzamento
SELECT contato_nome, qtd_pedidos, total_gasto, match_strategy, ultimo_pedido
FROM cliente_tem_magazord
ORDER BY qtd_pedidos DESC, total_gasto DESC
LIMIT 10;

-- Reverter:
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='cron-cliente-tem-magazord';
--   DROP TABLE IF EXISTS cliente_tem_magazord CASCADE;
--   DROP FUNCTION IF EXISTS refresh_cliente_tem_magazord();
--   DROP FUNCTION IF EXISTS _ctm_normalizar(TEXT);
