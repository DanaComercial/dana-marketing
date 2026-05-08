-- ═══════════════════════════════════════════════════════════════════════════
-- MAGAZORD (Site E-commerce danajalecos.com.br) — cache de API pra dashboard
-- ═══════════════════════════════════════════════════════════════════════════
-- API validada em 08/05/2026 (Section 73 da doc).
-- Auth: Basic Auth com TOKEN como USER e SENHA como password.
-- Caminho: /v2/site/* (não /v1/).
-- 5.133 pedidos · 5.720 pessoas · 755 produtos · 108 categorias · 4 marcas.
--
-- 5 tabelas:
--   1) magazord_pedidos       — cache de pedidos do site
--   2) magazord_pessoas       — clientes do site (espelho /v2/site/pessoa)
--   3) magazord_produtos      — catálogo do site (espelho /v2/site/produto)
--   4) magazord_categorias    — árvore de categorias
--   5) magazord_marcas        — marcas (Dana Jalecos = id 2)
--
-- + view magazord_pedido_completo (JOIN pedido + pessoa)
-- + RPC magazord_resumo_periodo(dias) — agregação por dia/forma_pgto/loja
-- + RPC magazord_top_clientes(dias, limite) — ranking por gasto
-- + RLS pros 5 cargos do Analytics IA
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1) PEDIDOS — espelho dos 26 campos validados em /v2/site/pedido
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magazord_pedidos (
  id                            BIGINT PRIMARY KEY,
  codigo                        TEXT,
  codigo_marketplace            TEXT,
  data_hora                     TIMESTAMPTZ,
  -- valores (todos em BRL)
  valor_produto                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_frete                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_desconto                NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_acrescimo               NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_total                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- cupom (Magazord não liberou /cupom, então só guardamos o ID)
  cupom_id                      BIGINT,
  -- pessoa (cliente do pedido)
  pessoa_id                     BIGINT,
  pessoa_nome                   TEXT,
  pessoa_cpf_cnpj               TEXT,
  pessoa_contato                TEXT,            -- telefone/email do contato
  -- forma de pagamento (PIX, Cartão, Boleto, etc)
  forma_pagamento_id            BIGINT,
  forma_pagamento_nome          TEXT,
  forma_recebimento_id          BIGINT,
  forma_recebimento_nome        TEXT,            -- MagaPay/Asaas, Pix, etc
  condicao_pagamento_id         BIGINT,
  condicao_pagamento_nome       TEXT,
  -- situação do pedido (Pago, Cancelado, Em separação, etc)
  pedido_situacao               BIGINT,
  pedido_situacao_descricao     TEXT,
  pedido_situacao_tipo          TEXT,
  -- loja / marketplace de origem
  loja_id                       BIGINT,
  loja_marketplace_id           BIGINT,
  loja_marketplace_nome         TEXT,
  -- raw + sync metadata
  raw                           JSONB,
  synced_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_data        ON magazord_pedidos(data_hora DESC);
CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_pessoa      ON magazord_pedidos(pessoa_id);
CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_situacao    ON magazord_pedidos(pedido_situacao_tipo);
CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_recebimento ON magazord_pedidos(forma_recebimento_nome);
CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_marketplace ON magazord_pedidos(loja_marketplace_nome);
CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_codigo      ON magazord_pedidos(codigo);
CREATE INDEX IF NOT EXISTS idx_mzd_pedidos_cpf_cnpj    ON magazord_pedidos(pessoa_cpf_cnpj);

-- ───────────────────────────────────────────────────────────────────────────
-- 2) PESSOAS — clientes do site (não tem /cliente, usamos /pessoa)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magazord_pessoas (
  id                BIGINT PRIMARY KEY,
  nome              TEXT,
  cpf_cnpj          TEXT,
  email             TEXT,
  email_hash        TEXT,                -- SHA256 hex pra cruzar com Lead Tracker
  telefone          TEXT,
  celular           TEXT,
  tipo              TEXT,                -- F (física) | J (jurídica)
  data_nascimento   DATE,
  cidade            TEXT,
  uf                TEXT,
  cep               TEXT,
  ativo             BOOLEAN,
  data_cadastro     TIMESTAMPTZ,
  raw               JSONB,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mzd_pessoas_email      ON magazord_pessoas(email);
CREATE INDEX IF NOT EXISTS idx_mzd_pessoas_email_hash ON magazord_pessoas(email_hash);
CREATE INDEX IF NOT EXISTS idx_mzd_pessoas_cpf        ON magazord_pessoas(cpf_cnpj);
CREATE INDEX IF NOT EXISTS idx_mzd_pessoas_telefone   ON magazord_pessoas(telefone);
CREATE INDEX IF NOT EXISTS idx_mzd_pessoas_celular    ON magazord_pessoas(celular);

-- ───────────────────────────────────────────────────────────────────────────
-- 3) PRODUTOS — catálogo do site
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magazord_produtos (
  id              BIGINT PRIMARY KEY,
  nome            TEXT,
  modelo          TEXT,
  palavra_chave   TEXT,
  categoria_id    BIGINT,
  marca_id        BIGINT,
  preco           NUMERIC(12,2),
  preco_promo     NUMERIC(12,2),
  ativo           BOOLEAN,
  estoque         INT,
  raw             JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mzd_produtos_nome      ON magazord_produtos USING GIN (to_tsvector('portuguese', nome));
CREATE INDEX IF NOT EXISTS idx_mzd_produtos_categoria ON magazord_produtos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_mzd_produtos_marca     ON magazord_produtos(marca_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 4) CATEGORIAS — árvore (108 categorias)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magazord_categorias (
  id           BIGINT PRIMARY KEY,
  nome         TEXT,
  pai_id       BIGINT,                 -- null = raiz
  caminho      TEXT,                   -- "Saúde > Jalecos > Femininos"
  ativo        BOOLEAN,
  raw          JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mzd_categorias_pai ON magazord_categorias(pai_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 5) MARCAS — só 4 (Dana Jalecos = id 2)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magazord_marcas (
  id         BIGINT PRIMARY KEY,
  nome       TEXT,
  ativo      BOOLEAN,
  raw        JSONB,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────────
-- 5b) CARRINHOS — abandonados/convertidos (endpoint LIST liberado em 08/05/2026 noite)
--     Limita\u00e7\u00e3o: GET individual /v2/site/carrinho/{id} ainda d\u00e1 405,
--     ent\u00e3o n\u00e3o temos itens/cliente/valor. S\u00f3 d\u00e1 pra contar + taxa convers\u00e3o.
--     status: 2 = abandonado, 3 = convertido em pedido (campo `pedido` populado)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magazord_carrinhos (
  id              BIGINT PRIMARY KEY,
  status          INT,                  -- 2 = abandonado, 3 = convertido
  hash            TEXT,
  data_inicio     TIMESTAMPTZ,
  data_atualizacao TIMESTAMPTZ,
  pedido_id       BIGINT,               -- preenchido quando status=3
  pedido_codigo   TEXT,
  raw             JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mzd_carrinhos_status ON magazord_carrinhos(status);
CREATE INDEX IF NOT EXISTS idx_mzd_carrinhos_data   ON magazord_carrinhos(data_atualizacao DESC);
CREATE INDEX IF NOT EXISTS idx_mzd_carrinhos_pedido ON magazord_carrinhos(pedido_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 6) VIEW: pedido completo com pessoa
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW magazord_pedido_completo AS
SELECT
  p.id,
  p.codigo,
  p.codigo_marketplace,
  p.data_hora,
  p.valor_produto,
  p.valor_frete,
  p.valor_desconto,
  p.valor_acrescimo,
  p.valor_total,
  p.cupom_id,
  p.pessoa_id,
  COALESCE(pe.nome, p.pessoa_nome) AS pessoa_nome,
  pe.email AS pessoa_email,
  pe.email_hash AS pessoa_email_hash,
  pe.telefone AS pessoa_telefone,
  pe.celular AS pessoa_celular,
  pe.cidade AS pessoa_cidade,
  pe.uf AS pessoa_uf,
  p.pessoa_cpf_cnpj,
  p.pessoa_contato,
  p.forma_pagamento_nome,
  p.forma_recebimento_nome,
  p.condicao_pagamento_nome,
  p.pedido_situacao_descricao,
  p.pedido_situacao_tipo,
  p.loja_marketplace_nome,
  p.synced_at
FROM magazord_pedidos p
LEFT JOIN magazord_pessoas pe ON pe.id = p.pessoa_id;

-- ───────────────────────────────────────────────────────────────────────────
-- 7) RPC: resumo do período (KPIs do E-commerce)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION magazord_resumo_periodo(p_dias INT DEFAULT 30)
RETURNS TABLE (
  total_pedidos          BIGINT,
  pedidos_pagos          BIGINT,
  pedidos_cancelados     BIGINT,
  faturamento_bruto      NUMERIC,
  faturamento_liquido    NUMERIC,    -- só pagos
  total_descontos        NUMERIC,
  total_frete            NUMERIC,
  ticket_medio           NUMERIC,
  pct_cancelamento       NUMERIC,
  clientes_unicos        BIGINT,
  clientes_recorrentes   BIGINT,     -- com 2+ pedidos no período
  primeira_venda         TIMESTAMPTZ,
  ultima_venda           TIMESTAMPTZ
)
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
  WITH base AS (
    SELECT *
    FROM magazord_pedidos
    WHERE data_hora >= NOW() - (p_dias || ' days')::INTERVAL
  ),
  pagos AS (
    SELECT * FROM base WHERE pedido_situacao_tipo IN ('aprovado','pago','separacao','enviado','entregue','faturado')
                             OR pedido_situacao_descricao ILIKE '%pago%'
                             OR pedido_situacao_descricao ILIKE '%aprovado%'
                             OR pedido_situacao_descricao ILIKE '%entregue%'
  ),
  recorrentes AS (
    SELECT pessoa_id, COUNT(*) AS qtd
    FROM base
    WHERE pessoa_id IS NOT NULL
    GROUP BY pessoa_id
    HAVING COUNT(*) >= 2
  )
  SELECT
    (SELECT COUNT(*) FROM base),
    (SELECT COUNT(*) FROM pagos),
    (SELECT COUNT(*) FROM base WHERE pedido_situacao_tipo = 'cancelado' OR pedido_situacao_descricao ILIKE '%cancel%'),
    COALESCE((SELECT SUM(valor_total) FROM base), 0),
    COALESCE((SELECT SUM(valor_total) FROM pagos), 0),
    COALESCE((SELECT SUM(valor_desconto) FROM base), 0),
    COALESCE((SELECT SUM(valor_frete) FROM base), 0),
    CASE WHEN (SELECT COUNT(*) FROM pagos) > 0
         THEN ROUND(((SELECT SUM(valor_total) FROM pagos) / (SELECT COUNT(*) FROM pagos))::NUMERIC, 2)
         ELSE 0 END,
    CASE WHEN (SELECT COUNT(*) FROM base) > 0
         THEN ROUND(
           ((SELECT COUNT(*) FROM base WHERE pedido_situacao_tipo = 'cancelado' OR pedido_situacao_descricao ILIKE '%cancel%')::NUMERIC
           / (SELECT COUNT(*) FROM base) * 100), 2)
         ELSE 0 END,
    (SELECT COUNT(DISTINCT pessoa_id) FROM base WHERE pessoa_id IS NOT NULL),
    (SELECT COUNT(*) FROM recorrentes),
    (SELECT MIN(data_hora) FROM base),
    (SELECT MAX(data_hora) FROM base);
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8) RPC: top clientes por gasto no período
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION magazord_top_clientes(p_dias INT DEFAULT 90, p_limite INT DEFAULT 20)
RETURNS TABLE (
  pessoa_id      BIGINT,
  pessoa_nome    TEXT,
  pessoa_email   TEXT,
  pessoa_cidade  TEXT,
  qtd_pedidos    BIGINT,
  total_gasto    NUMERIC,
  ticket_medio   NUMERIC,
  ultimo_pedido  TIMESTAMPTZ
)
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
  SELECT
    p.pessoa_id,
    COALESCE(pe.nome, p.pessoa_nome),
    pe.email,
    pe.cidade,
    COUNT(*),
    SUM(p.valor_total),
    ROUND((SUM(p.valor_total) / COUNT(*))::NUMERIC, 2),
    MAX(p.data_hora)
  FROM magazord_pedidos p
  LEFT JOIN magazord_pessoas pe ON pe.id = p.pessoa_id
  WHERE p.data_hora >= NOW() - (p_dias || ' days')::INTERVAL
    AND p.pessoa_id IS NOT NULL
  GROUP BY p.pessoa_id, pe.nome, p.pessoa_nome, pe.email, pe.cidade
  ORDER BY SUM(p.valor_total) DESC
  LIMIT p_limite;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9) RPC: distribuição por forma de pagamento (último N dias)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION magazord_dist_forma_pagamento(p_dias INT DEFAULT 30)
RETURNS TABLE (
  forma_recebimento  TEXT,
  qtd_pedidos        BIGINT,
  total              NUMERIC,
  ticket_medio       NUMERIC,
  pct                NUMERIC
)
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
  WITH base AS (
    SELECT forma_recebimento_nome, valor_total
    FROM magazord_pedidos
    WHERE data_hora >= NOW() - (p_dias || ' days')::INTERVAL
  ),
  total_pedidos AS (
    SELECT COUNT(*)::NUMERIC AS qtd FROM base
  )
  SELECT
    COALESCE(forma_recebimento_nome, 'Não informado'),
    COUNT(*),
    SUM(valor_total),
    ROUND((SUM(valor_total) / NULLIF(COUNT(*), 0))::NUMERIC, 2),
    ROUND((COUNT(*)::NUMERIC / NULLIF((SELECT qtd FROM total_pedidos), 0) * 100), 2)
  FROM base
  GROUP BY forma_recebimento_nome
  ORDER BY COUNT(*) DESC;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9b) RPC: estat\u00edsticas de carrinho (abandonados + taxa convers\u00e3o)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION magazord_carrinho_stats(p_dias INT DEFAULT 30)
RETURNS TABLE (
  total_carrinhos      BIGINT,
  abandonados          BIGINT,
  convertidos          BIGINT,
  taxa_conversao_pct   NUMERIC,
  primeiro             TIMESTAMPTZ,
  ultimo               TIMESTAMPTZ
)
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
  WITH base AS (
    SELECT * FROM magazord_carrinhos
    WHERE data_atualizacao >= NOW() - (p_dias || ' days')::INTERVAL
  )
  SELECT
    (SELECT COUNT(*) FROM base),
    (SELECT COUNT(*) FROM base WHERE status = 2),
    (SELECT COUNT(*) FROM base WHERE status = 3),
    CASE WHEN (SELECT COUNT(*) FROM base) > 0
         THEN ROUND(((SELECT COUNT(*) FROM base WHERE status = 3)::NUMERIC
                     / (SELECT COUNT(*) FROM base) * 100), 2)
         ELSE 0 END,
    (SELECT MIN(data_atualizacao) FROM base),
    (SELECT MAX(data_atualizacao) FROM base);
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 10) RPC: série diária pra gráfico de tendência
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION magazord_serie_diaria(p_dias INT DEFAULT 30)
RETURNS TABLE (
  dia            DATE,
  qtd_pedidos    BIGINT,
  faturamento    NUMERIC,
  ticket_medio   NUMERIC
)
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
  SELECT
    DATE(data_hora AT TIME ZONE 'America/Sao_Paulo'),
    COUNT(*),
    SUM(valor_total),
    ROUND((SUM(valor_total) / NULLIF(COUNT(*), 0))::NUMERIC, 2)
  FROM magazord_pedidos
  WHERE data_hora >= NOW() - (p_dias || ' days')::INTERVAL
  GROUP BY 1
  ORDER BY 1;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 11) RLS — leitura pros 5 cargos do Analytics IA
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE magazord_pedidos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE magazord_pessoas    ENABLE ROW LEVEL SECURITY;
ALTER TABLE magazord_produtos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE magazord_categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE magazord_marcas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE magazord_carrinhos  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mzd_pedidos_select    ON magazord_pedidos;
DROP POLICY IF EXISTS mzd_pedidos_admin     ON magazord_pedidos;
DROP POLICY IF EXISTS mzd_pessoas_select    ON magazord_pessoas;
DROP POLICY IF EXISTS mzd_pessoas_admin     ON magazord_pessoas;
DROP POLICY IF EXISTS mzd_produtos_select   ON magazord_produtos;
DROP POLICY IF EXISTS mzd_produtos_admin    ON magazord_produtos;
DROP POLICY IF EXISTS mzd_categorias_select ON magazord_categorias;
DROP POLICY IF EXISTS mzd_categorias_admin  ON magazord_categorias;
DROP POLICY IF EXISTS mzd_marcas_select     ON magazord_marcas;
DROP POLICY IF EXISTS mzd_marcas_admin      ON magazord_marcas;
DROP POLICY IF EXISTS mzd_carrinhos_select  ON magazord_carrinhos;
DROP POLICY IF EXISTS mzd_carrinhos_admin   ON magazord_carrinhos;

CREATE POLICY mzd_pedidos_select ON magazord_pedidos FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
               AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')));
CREATE POLICY mzd_pedidos_admin ON magazord_pedidos FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

CREATE POLICY mzd_pessoas_select ON magazord_pessoas FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
               AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')));
CREATE POLICY mzd_pessoas_admin ON magazord_pessoas FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

CREATE POLICY mzd_produtos_select ON magazord_produtos FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
               AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')));
CREATE POLICY mzd_produtos_admin ON magazord_produtos FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

CREATE POLICY mzd_categorias_select ON magazord_categorias FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
               AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')));
CREATE POLICY mzd_categorias_admin ON magazord_categorias FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

CREATE POLICY mzd_marcas_select ON magazord_marcas FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
               AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')));
CREATE POLICY mzd_marcas_admin ON magazord_marcas FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

CREATE POLICY mzd_carrinhos_select ON magazord_carrinhos FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
               AND cargo IN ('admin','gerente_marketing','gerente_comercial','trafego_pago','producao_conteudo','vendedora')));
CREATE POLICY mzd_carrinhos_admin ON magazord_carrinhos FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND cargo = 'admin'));

-- ═══════════════════════════════════════════════════════════════════════════
-- Validação
-- ═══════════════════════════════════════════════════════════════════════════
SELECT 'pedidos'    AS tabela, COUNT(*) FROM magazord_pedidos
UNION ALL
SELECT 'pessoas',              COUNT(*) FROM magazord_pessoas
UNION ALL
SELECT 'produtos',             COUNT(*) FROM magazord_produtos
UNION ALL
SELECT 'categorias',           COUNT(*) FROM magazord_categorias
UNION ALL
SELECT 'marcas',               COUNT(*) FROM magazord_marcas
UNION ALL
SELECT 'carrinhos',            COUNT(*) FROM magazord_carrinhos;

-- Reverter (perde tudo):
--   DROP TABLE IF EXISTS magazord_pedidos, magazord_pessoas, magazord_produtos,
--                        magazord_categorias, magazord_marcas CASCADE;
--   DROP FUNCTION IF EXISTS magazord_resumo_periodo(INT),
--                           magazord_top_clientes(INT, INT),
--                           magazord_dist_forma_pagamento(INT),
--                           magazord_serie_diaria(INT);
-- ═══════════════════════════════════════════════════════════════════════════
