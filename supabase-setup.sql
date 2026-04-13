-- ============================================
-- DMS - Dana Marketing System
-- Executar no SQL Editor do Supabase
-- ============================================

-- PASSO 1: Criar tabelas
CREATE TABLE IF NOT EXISTS bling_tokens (
  id int PRIMARY KEY DEFAULT 1,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id bigint PRIMARY KEY,
  numero int,
  numero_loja text,
  data date,
  data_saida date,
  total_produtos numeric(12,2),
  total numeric(12,2),
  contato_nome text,
  contato_tipo text,
  situacao_id int,
  loja_id bigint,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS produtos (
  id bigint PRIMARY KEY,
  nome text,
  codigo text,
  preco numeric(12,2),
  preco_custo numeric(12,2),
  estoque_virtual numeric(12,2) DEFAULT 0,
  tipo text,
  situacao text,
  formato text,
  imagem_url text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contatos (
  id bigint PRIMARY KEY,
  nome text,
  codigo text,
  situacao text,
  tipo_pessoa text,
  numero_documento text,
  telefone text,
  celular text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contas_receber (
  id bigint PRIMARY KEY,
  situacao int,
  vencimento date,
  valor numeric(12,2),
  data_emissao date,
  contato_nome text,
  contato_tipo text,
  origem_tipo text,
  origem_numero text,
  conta_contabil text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contas_pagar (
  id bigint PRIMARY KEY,
  situacao int,
  vencimento date,
  valor numeric(12,2),
  contato_id bigint,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendedores (
  id bigint PRIMARY KEY,
  nome text,
  situacao text,
  desconto_limite numeric(5,2) DEFAULT 0,
  loja_id bigint DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS depositos (
  id bigint PRIMARY KEY,
  descricao text,
  situacao int,
  padrao boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resumo_mensal (
  id serial PRIMARY KEY,
  ano int NOT NULL,
  mes int NOT NULL,
  receita numeric(12,2) DEFAULT 0,
  pedidos int DEFAULT 0,
  ticket_medio numeric(12,2) DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(ano, mes)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id serial PRIMARY KEY,
  tabela text,
  registros int,
  status text,
  erro text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome text,
  email text,
  role text DEFAULT 'viewer',
  created_at timestamptz DEFAULT now()
);

-- PASSO 2: RLS + Policies
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE contas_receber ENABLE ROW LEVEL SECURITY;
ALTER TABLE contas_pagar ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE depositos ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumo_mensal ENABLE ROW LEVEL SECURITY;
ALTER TABLE bling_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_pedidos" ON pedidos FOR SELECT TO anon USING (true);
CREATE POLICY "read_produtos" ON produtos FOR SELECT TO anon USING (true);
CREATE POLICY "read_contatos" ON contatos FOR SELECT TO anon USING (true);
CREATE POLICY "read_contas_receber" ON contas_receber FOR SELECT TO anon USING (true);
CREATE POLICY "read_contas_pagar" ON contas_pagar FOR SELECT TO anon USING (true);
CREATE POLICY "read_vendedores" ON vendedores FOR SELECT TO anon USING (true);
CREATE POLICY "read_depositos" ON depositos FOR SELECT TO anon USING (true);
CREATE POLICY "read_resumo" ON resumo_mensal FOR SELECT TO anon USING (true);

CREATE POLICY "read_pedidos_auth" ON pedidos FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_produtos_auth" ON produtos FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_contatos_auth" ON contatos FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_contas_receber_auth" ON contas_receber FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_contas_pagar_auth" ON contas_pagar FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_vendedores_auth" ON vendedores FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_depositos_auth" ON depositos FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_resumo_auth" ON resumo_mensal FOR SELECT TO authenticated USING (true);

CREATE POLICY "tokens_service_only" ON bling_tokens FOR ALL TO service_role USING (true);
CREATE POLICY "sync_service_only" ON sync_log FOR ALL TO service_role USING (true);

CREATE POLICY "service_pedidos" ON pedidos FOR ALL TO service_role USING (true);
CREATE POLICY "service_produtos" ON produtos FOR ALL TO service_role USING (true);
CREATE POLICY "service_contatos" ON contatos FOR ALL TO service_role USING (true);
CREATE POLICY "service_contas_r" ON contas_receber FOR ALL TO service_role USING (true);
CREATE POLICY "service_contas_p" ON contas_pagar FOR ALL TO service_role USING (true);
CREATE POLICY "service_vendedores" ON vendedores FOR ALL TO service_role USING (true);
CREATE POLICY "service_depositos" ON depositos FOR ALL TO service_role USING (true);
CREATE POLICY "service_resumo" ON resumo_mensal FOR ALL TO service_role USING (true);

CREATE POLICY "read_profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "update_own_profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "insert_own_profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "service_profiles" ON profiles FOR ALL TO service_role USING (true);

-- PASSO 3: Views e Functions
CREATE OR REPLACE VIEW dashboard_resumo AS
SELECT
  (SELECT COALESCE(SUM(total), 0) FROM pedidos WHERE data >= '2026-01-01' AND data <= '2026-12-31') as receita_2026,
  (SELECT COUNT(*) FROM pedidos WHERE data >= '2026-01-01' AND data <= '2026-12-31') as pedidos_2026,
  (SELECT COALESCE(SUM(total), 0) FROM pedidos WHERE data >= '2025-01-01' AND data <= '2025-12-31') as receita_2025,
  (SELECT COUNT(*) FROM pedidos WHERE data >= '2025-01-01' AND data <= '2025-12-31') as pedidos_2025,
  (SELECT COALESCE(SUM(valor), 0) FROM contas_receber WHERE situacao = 1) as total_receber,
  (SELECT COALESCE(SUM(valor), 0) FROM contas_pagar WHERE situacao = 1) as total_pagar,
  (SELECT COUNT(*) FROM contatos) as total_contatos;

CREATE OR REPLACE VIEW dashboard_mensal AS
SELECT
  EXTRACT(YEAR FROM data)::int as ano,
  EXTRACT(MONTH FROM data)::int as mes,
  situacao_id,
  COUNT(*)::int as pedidos,
  COALESCE(SUM(total), 0) as receita,
  CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(total), 0) / COUNT(*) ELSE 0 END as ticket_medio,
  COUNT(*) FILTER (WHERE loja_id = 203536978)::int as pedidos_loja,
  COALESCE(SUM(total) FILTER (WHERE loja_id = 203536978), 0) as receita_loja,
  COUNT(*) FILTER (WHERE loja_id = 205337834)::int as pedidos_ml,
  COALESCE(SUM(total) FILTER (WHERE loja_id = 205337834), 0) as receita_ml,
  COUNT(*) FILTER (WHERE loja_id = 205430008)::int as pedidos_tiktok,
  COALESCE(SUM(total) FILTER (WHERE loja_id = 205430008), 0) as receita_tiktok,
  COUNT(*) FILTER (WHERE loja_id = 205522474)::int as pedidos_shopee,
  COALESCE(SUM(total) FILTER (WHERE loja_id = 205522474), 0) as receita_shopee,
  COUNT(*) FILTER (WHERE loja_id = 0 OR loja_id IS NULL)::int as pedidos_site,
  COALESCE(SUM(total) FILTER (WHERE loja_id = 0 OR loja_id IS NULL), 0) as receita_site
FROM pedidos
GROUP BY ano, mes, situacao_id
ORDER BY ano, mes;

CREATE OR REPLACE VIEW dashboard_contas AS
SELECT
  (SELECT COUNT(*) FROM contas_pagar WHERE situacao = 1 AND vencimento >= '2026-01-01') as cp_aberto_qtd,
  (SELECT COALESCE(SUM(valor), 0) FROM contas_pagar WHERE situacao = 1 AND vencimento >= '2026-01-01') as cp_aberto_valor,
  (SELECT COUNT(*) FROM contas_pagar WHERE situacao = 3 AND vencimento >= '2026-01-01') as cp_atrasado_qtd,
  (SELECT COALESCE(SUM(valor), 0) FROM contas_pagar WHERE situacao = 3 AND vencimento >= '2026-01-01') as cp_atrasado_valor,
  (SELECT COUNT(*) FROM contas_receber WHERE situacao = 1 AND vencimento >= '2026-01-01') as cr_aberto_qtd,
  (SELECT COALESCE(SUM(valor), 0) FROM contas_receber WHERE situacao = 1 AND vencimento >= '2026-01-01') as cr_aberto_valor,
  (SELECT COUNT(*) FROM contas_receber WHERE situacao = 3 AND vencimento >= '2026-01-01') as cr_atrasado_qtd,
  (SELECT COALESCE(SUM(valor), 0) FROM contas_receber WHERE situacao = 3 AND vencimento >= '2026-01-01') as cr_atrasado_valor;

GRANT SELECT ON dashboard_resumo TO anon;
GRANT SELECT ON dashboard_resumo TO authenticated;
GRANT SELECT ON dashboard_mensal TO anon;
GRANT SELECT ON dashboard_mensal TO authenticated;
GRANT SELECT ON dashboard_contas TO anon;
GRANT SELECT ON dashboard_contas TO authenticated;

-- PASSO 4: Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE pedidos;
ALTER PUBLICATION supabase_realtime ADD TABLE produtos;
ALTER PUBLICATION supabase_realtime ADD TABLE contatos;
ALTER PUBLICATION supabase_realtime ADD TABLE contas_receber;
ALTER PUBLICATION supabase_realtime ADD TABLE contas_pagar;
ALTER PUBLICATION supabase_realtime ADD TABLE vendedores;
ALTER PUBLICATION supabase_realtime ADD TABLE depositos;
ALTER PUBLICATION supabase_realtime ADD TABLE resumo_mensal;
