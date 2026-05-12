-- ═══════════════════════════════════════════════════════════════════════════
-- RANKINGS DE VENDEDORAS — 3 visões (Geral / Desempenho / Mensal)
-- ═══════════════════════════════════════════════════════════════════════════
-- Ranking 1 (Geral): já existe via view `vendedor_performance` — só reusar.
-- Ranking 2 (Desempenho): reativações de clientes 90+ dias sem comprar (mês corrente).
-- Ranking 3 (Mensal): faturamento do mês × meta definida pela vendedora ou gerência.
--
-- Tabela `vendedor_metas_mensais`: 1 row por (ano, mês, vendedor_profile_id).
-- Não precisa "resetar mensalmente" — basta nova row no novo mês.
-- Histórico de alterações em JSONB pra auditar quem mudou.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tabela: metas mensais por vendedor ──────────────────────────────────
-- Meta é por (ano, mes, vendedor) — não por empresa. Empresa fica como atributo informativo.
CREATE TABLE IF NOT EXISTS vendedor_metas_mensais (
  ano                  INT NOT NULL,
  mes                  INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  vendedor_profile_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  empresa              TEXT,                                  -- atributo informativo (opcional)
  meta_reais           NUMERIC(12,2) NOT NULL DEFAULT 0,
  setado_por           UUID REFERENCES profiles(id),
  setado_por_cargo     TEXT,
  setado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  historico            JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{quando, quem, cargo, de, para}]
  PRIMARY KEY (ano, mes, vendedor_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_metas_vendedor ON vendedor_metas_mensais(vendedor_profile_id, ano DESC, mes DESC);
CREATE INDEX IF NOT EXISTS idx_metas_periodo  ON vendedor_metas_mensais(ano, mes);

-- ── 2. View: Ranking 2 — Desempenho (reativações 90+ dias do mês corrente) ─
-- "Reativação" = cliente cujo pedido anterior foi há 90+ dias antes do início do mês,
--   e que voltou a comprar no mês corrente.
-- Cada reativação = +50 pontos.
CREATE OR REPLACE VIEW vendedor_ranking_desempenho AS
WITH inicio_mes AS (
  SELECT DATE_TRUNC('month', CURRENT_DATE)::date AS dia
),
pedidos_mes AS (
  -- Primeira ocorrência (no mês) de cada (vendedor, contato)
  SELECT
    p.empresa,
    p.vendedor_id,
    p.contato_nome,
    MIN(p.data) AS data_primeira_mes
  FROM pedidos p, inicio_mes i
  WHERE p.data >= i.dia
    AND p.vendedor_id IS NOT NULL
    AND p.contato_nome IS NOT NULL
    AND p.contato_nome <> ''
  GROUP BY p.empresa, p.vendedor_id, p.contato_nome
),
com_anterior AS (
  -- Junta com a última compra ANTES do mês corrente
  SELECT
    pm.empresa,
    pm.vendedor_id,
    pm.contato_nome,
    pm.data_primeira_mes,
    (
      SELECT MAX(p2.data)
      FROM pedidos p2, inicio_mes i
      WHERE p2.contato_nome = pm.contato_nome
        AND p2.empresa = pm.empresa
        AND p2.data < i.dia
    ) AS ultima_antes
  FROM pedidos_mes pm
),
reativacoes AS (
  SELECT *,
    (data_primeira_mes - ultima_antes) AS gap_dias
  FROM com_anterior
  WHERE ultima_antes IS NOT NULL
    AND (data_primeira_mes - ultima_antes) >= 90
)
SELECT
  vm.profile_id            AS vendedor_profile_id,
  vm.display_name          AS vendedor_nome,
  r.empresa,
  COUNT(*)                 AS reativacoes_90d,
  50 * COUNT(*)            AS pontos,
  MAX(r.data_primeira_mes) AS ultima_reativacao,
  MIN(r.gap_dias)          AS menor_gap_dias,
  MAX(r.gap_dias)          AS maior_gap_dias
FROM reativacoes r
JOIN vendedor_mapping vm ON vm.bling_vendedor_id = r.vendedor_id
                        AND vm.empresa = r.empresa
                        AND vm.ativo = true
                        AND COALESCE(vm.excluir_ranking, false) = false
GROUP BY vm.profile_id, vm.display_name, r.empresa
ORDER BY pontos DESC, reativacoes_90d DESC;

-- ── 3. View: Ranking 3 — Vendas mensais com meta ──────────────────────────
CREATE OR REPLACE VIEW vendedor_ranking_mensal AS
WITH inicio_mes AS (
  SELECT
    DATE_TRUNC('month', CURRENT_DATE)::date AS dia,
    EXTRACT(YEAR FROM CURRENT_DATE)::INT  AS ano,
    EXTRACT(MONTH FROM CURRENT_DATE)::INT AS mes
),
vendas_mes AS (
  SELECT
    vm.profile_id   AS vendedor_profile_id,
    vm.display_name AS vendedor_nome,
    p.empresa,
    SUM(p.total)       AS faturamento_mes,
    COUNT(DISTINCT p.id) AS pedidos_mes,
    COUNT(DISTINCT p.contato_nome) AS clientes_unicos_mes
  FROM pedidos p
  JOIN inicio_mes i ON p.data >= i.dia
  JOIN vendedor_mapping vm ON vm.bling_vendedor_id = p.vendedor_id
                          AND vm.empresa = p.empresa
                          AND vm.ativo = true
                          AND COALESCE(vm.excluir_ranking, false) = false
  GROUP BY vm.profile_id, vm.display_name, p.empresa
)
SELECT
  v.vendedor_profile_id,
  v.vendedor_nome,
  v.empresa,
  (SELECT ano FROM inicio_mes) AS ano,
  (SELECT mes FROM inicio_mes) AS mes,
  v.faturamento_mes,
  v.pedidos_mes,
  v.clientes_unicos_mes,
  COALESCE(m.meta_reais, 0) AS meta_reais,
  CASE WHEN COALESCE(m.meta_reais, 0) > 0
       THEN ROUND((v.faturamento_mes / m.meta_reais * 100)::NUMERIC, 1)
       ELSE NULL END AS pct_meta,
  m.setado_por_cargo,
  m.setado_em      AS meta_setada_em
FROM vendas_mes v
LEFT JOIN vendedor_metas_mensais m
       ON m.vendedor_profile_id = v.vendedor_profile_id
      AND m.ano = (SELECT ano FROM inicio_mes)
      AND m.mes = (SELECT mes FROM inicio_mes)
ORDER BY v.faturamento_mes DESC;

-- ── 4. RPC: setar/atualizar meta com histórico ─────────────────────────────
CREATE OR REPLACE FUNCTION setar_meta_mensal(
  p_ano INT,
  p_mes INT,
  p_vendedor_profile_id UUID,
  p_meta_reais NUMERIC,
  p_empresa TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_uid UUID;
  v_cargo TEXT;
  v_meta_antiga NUMERIC;
  v_pode_setar BOOLEAN := false;
  v_hist_entry JSONB;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_sessao');
  END IF;

  SELECT cargo INTO v_cargo FROM profiles WHERE id = v_uid;

  -- Vendedora só pode setar a própria meta. Admin/gerente comercial pode override.
  IF v_cargo IN ('admin', 'gerente_comercial') THEN
    v_pode_setar := true;
  ELSIF v_uid = p_vendedor_profile_id THEN
    v_pode_setar := true;
  END IF;

  IF NOT v_pode_setar THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_permissao',
      'mensagem', 'Você só pode definir a sua própria meta.');
  END IF;

  -- Pega meta antiga (pra histórico)
  SELECT meta_reais INTO v_meta_antiga
  FROM vendedor_metas_mensais
  WHERE ano = p_ano AND mes = p_mes
    AND vendedor_profile_id = p_vendedor_profile_id
  LIMIT 1;

  v_hist_entry := jsonb_build_object(
    'quando', NOW(),
    'quem', v_uid,
    'cargo', v_cargo,
    'de', COALESCE(v_meta_antiga, 0),
    'para', p_meta_reais
  );

  INSERT INTO vendedor_metas_mensais (
    ano, mes, vendedor_profile_id, empresa, meta_reais,
    setado_por, setado_por_cargo, setado_em, historico
  )
  VALUES (
    p_ano, p_mes, p_vendedor_profile_id, p_empresa, p_meta_reais,
    v_uid, v_cargo, NOW(), jsonb_build_array(v_hist_entry)
  )
  ON CONFLICT (ano, mes, vendedor_profile_id)
  DO UPDATE SET
    meta_reais = EXCLUDED.meta_reais,
    setado_por = v_uid,
    setado_por_cargo = v_cargo,
    setado_em = NOW(),
    historico = vendedor_metas_mensais.historico || v_hist_entry;

  RETURN jsonb_build_object(
    'ok', true,
    'meta_anterior', COALESCE(v_meta_antiga, 0),
    'meta_nova', p_meta_reais,
    'cargo', v_cargo
  );
END $$;

-- ── 5. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE vendedor_metas_mensais ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vmm_select_all ON vendedor_metas_mensais;
DROP POLICY IF EXISTS vmm_insert_self_or_admin ON vendedor_metas_mensais;
DROP POLICY IF EXISTS vmm_update_self_or_admin ON vendedor_metas_mensais;

-- SELECT: todos cargos autorizados podem ver as metas (transparência interna)
CREATE POLICY vmm_select_all ON vendedor_metas_mensais FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM profiles
  WHERE id = auth.uid()
    AND cargo IN ('admin','gerente_comercial','gerente_marketing','vendedora')
));

-- INSERT: vendedora só a própria, admin/gerente comercial qualquer uma
CREATE POLICY vmm_insert_self_or_admin ON vendedor_metas_mensais FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
          AND cargo IN ('admin', 'gerente_comercial'))
  OR auth.uid() = vendedor_profile_id
);

-- UPDATE: idem
CREATE POLICY vmm_update_self_or_admin ON vendedor_metas_mensais FOR UPDATE TO authenticated
USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
          AND cargo IN ('admin', 'gerente_comercial'))
  OR auth.uid() = vendedor_profile_id
)
WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
          AND cargo IN ('admin', 'gerente_comercial'))
  OR auth.uid() = vendedor_profile_id
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Validação
-- ═══════════════════════════════════════════════════════════════════════════
SELECT 'metas' AS tabela, COUNT(*) AS rows FROM vendedor_metas_mensais
UNION ALL SELECT 'ranking_desempenho', COUNT(*) FROM vendedor_ranking_desempenho
UNION ALL SELECT 'ranking_mensal', COUNT(*) FROM vendedor_ranking_mensal;

-- Reverter:
--   DROP TABLE IF EXISTS vendedor_metas_mensais CASCADE;
--   DROP VIEW IF EXISTS vendedor_ranking_desempenho, vendedor_ranking_mensal CASCADE;
--   DROP FUNCTION IF EXISTS setar_meta_mensal(INT, INT, UUID, NUMERIC, TEXT);
