#!/bin/bash
# ══════════════════════════════════════════════════════
# DMS — Verificação completa do pipeline Bling → Supabase
# Rodar: bash verificar-sync.sh
# ══════════════════════════════════════════════════════

SUPABASE_URL="https://comlppiwzniskjbeneos.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvbWxwcGl3em5pc2tqYmVuZW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwODg2MjYsImV4cCI6MjA5MTY2NDYyNn0.jQOYaPklzSxQxTUd7rzktljHpW7ivbxbtilsUUi-TBE"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvbWxwcGl3em5pc2tqYmVuZW9zIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjA4ODYyNiwiZXhwIjoyMDkxNjY0NjI2fQ.BnraJv6ta__8bMKoq8mldhb_1D8cJ-IAEFqIl3ovCWI"

echo "══════════════════════════════════════════════════"
echo "  DMS — Verificação do Pipeline Bling → Supabase"
echo "══════════════════════════════════════════════════"
echo ""

# ── 1. VERIFICAR TABELAS ──
echo "▶ 1. Verificando tabelas..."
echo ""

for TABLE in pedidos produtos contatos contas_receber contas_pagar vendedores depositos resumo_mensal sync_log bling_tokens tarefas alertas calendario; do
  COUNT=$(curl -s "${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1" \
    -H "apikey: ${ANON_KEY}" \
    -H "Authorization: Bearer ${ANON_KEY}" \
    -H "Prefer: count=exact" \
    -I 2>/dev/null | grep -i "content-range" | grep -oP '\d+$' || echo "?")

  # Fallback: tentar com select count
  if [ "$COUNT" = "?" ]; then
    RESULT=$(curl -s "${SUPABASE_URL}/rest/v1/${TABLE}?select=id" \
      -H "apikey: ${ANON_KEY}" \
      -H "Authorization: Bearer ${ANON_KEY}" \
      -H "Prefer: count=exact" \
      -H "Range: 0-0" \
      -w "\n%{http_code}" 2>/dev/null)
    HTTP_CODE=$(echo "$RESULT" | tail -1)
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "206" ]; then
      echo "  ✓ ${TABLE} — existe (HTTP ${HTTP_CODE})"
    elif [ "$HTTP_CODE" = "404" ]; then
      echo "  ✗ ${TABLE} — NÃO EXISTE! Rodar SQL no Supabase"
    else
      echo "  ? ${TABLE} — HTTP ${HTTP_CODE}"
    fi
  else
    echo "  ✓ ${TABLE} — ${COUNT} registros"
  fi
done

echo ""

# ── 2. VERIFICAR VIEWS ──
echo "▶ 2. Verificando views SQL..."
echo ""

# dashboard_resumo
RESUMO=$(curl -s "${SUPABASE_URL}/rest/v1/dashboard_resumo?select=*&limit=1" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)

if echo "$RESUMO" | grep -q "receita_2026"; then
  REC26=$(echo "$RESUMO" | grep -oP '"receita_2026":\s*\K[0-9.]+' | head -1)
  PED26=$(echo "$RESUMO" | grep -oP '"pedidos_2026":\s*\K[0-9]+' | head -1)
  echo "  ✓ dashboard_resumo — Receita 2026: R$${REC26}, Pedidos: ${PED26}"
else
  echo "  ✗ dashboard_resumo — NÃO EXISTE ou sem dados"
  echo "    Resposta: ${RESUMO:0:200}"
fi

# dashboard_mensal
MENSAL=$(curl -s "${SUPABASE_URL}/rest/v1/dashboard_mensal?select=ano,mes,receita,pedidos&limit=3&order=ano.desc,mes.desc" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)

if echo "$MENSAL" | grep -q "receita"; then
  echo "  ✓ dashboard_mensal — OK (últimos meses com dados)"
else
  echo "  ✗ dashboard_mensal — NÃO EXISTE ou sem dados"
fi

# dashboard_contas
CONTAS=$(curl -s "${SUPABASE_URL}/rest/v1/dashboard_contas?select=*&limit=1" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)

if echo "$CONTAS" | grep -q "cp_aberto"; then
  echo "  ✓ dashboard_contas — OK"
else
  echo "  ✗ dashboard_contas — NÃO EXISTE ou sem dados"
fi

# Novas views
for VIEW in cliente_scoring funil_vendas receita_historica; do
  VDATA=$(curl -s "${SUPABASE_URL}/rest/v1/${VIEW}?select=*&limit=1" \
    -H "apikey: ${ANON_KEY}" \
    -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)

  if echo "$VDATA" | grep -q "code"; then
    echo "  ✗ ${VIEW} — NÃO EXISTE! Rodar SQL de upgrade"
  else
    echo "  ✓ ${VIEW} — OK"
  fi
done

echo ""

# ── 3. VERIFICAR TOKEN DO BLING ──
echo "▶ 3. Verificando token do Bling..."
echo ""

TOKEN_DATA=$(curl -s "${SUPABASE_URL}/rest/v1/bling_tokens?id=eq.1&select=updated_at" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" 2>/dev/null)

if echo "$TOKEN_DATA" | grep -q "updated_at"; then
  UPDATED=$(echo "$TOKEN_DATA" | grep -oP '"updated_at":\s*"\K[^"]+')
  echo "  ✓ Token encontrado — última atualização: ${UPDATED}"
else
  echo "  ✗ Token NÃO encontrado na tabela bling_tokens!"
  echo "    Precisa inserir token manualmente"
fi

echo ""

# ── 4. VERIFICAR EDGE FUNCTION ──
echo "▶ 4. Verificando Edge Function sync-bling..."
echo ""

SYNC_RESULT=$(curl -s -w "\n%{http_code}" "${SUPABASE_URL}/functions/v1/sync-bling" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -X POST 2>/dev/null)

HTTP_CODE=$(echo "$SYNC_RESULT" | tail -1)
BODY=$(echo "$SYNC_RESULT" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "  ✓ Edge Function respondeu OK!"
  echo "    Resposta: ${BODY:0:200}"
elif [ "$HTTP_CODE" = "404" ]; then
  echo "  ✗ Edge Function NÃO ENCONTRADA (404)"
  echo "    → Precisa deployar a Edge Function no Supabase"
elif [ "$HTTP_CODE" = "500" ]; then
  echo "  ⚠ Edge Function retornou ERRO (500)"
  echo "    Resposta: ${BODY:0:300}"
  echo "    → Verificar logs no painel: Supabase > Edge Functions > sync-bling > Logs"
else
  echo "  ? Edge Function retornou HTTP ${HTTP_CODE}"
  echo "    Resposta: ${BODY:0:200}"
fi

echo ""

# ── 5. VERIFICAR ÚLTIMO SYNC ──
echo "▶ 5. Verificando último sync..."
echo ""

LAST_SYNC=$(curl -s "${SUPABASE_URL}/rest/v1/sync_log?select=tabela,status,created_at&order=created_at.desc&limit=5" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)

if echo "$LAST_SYNC" | grep -q "created_at"; then
  echo "  Últimos syncs:"
  echo "$LAST_SYNC" | grep -oP '"created_at":\s*"\K[^"]+' | while read -r DT; do
    echo "    · ${DT}"
  done

  # Verificar se é recente (menos de 1 hora)
  LAST_DT=$(echo "$LAST_SYNC" | grep -oP '"created_at":\s*"\K[^"]+' | head -1)
  echo ""
  echo "  Último sync: ${LAST_DT}"
else
  echo "  ✗ Nenhum sync registrado no sync_log"
  echo "    → Edge Function nunca rodou com sucesso, ou tabela vazia"
fi

echo ""

# ── 6. VERIFICAR ÚLTIMO PEDIDO ──
echo "▶ 6. Verificando pedido mais recente..."
echo ""

LAST_PED=$(curl -s "${SUPABASE_URL}/rest/v1/pedidos?select=numero,data,total,contato_nome&order=data.desc&limit=3" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)

if echo "$LAST_PED" | grep -q "numero"; then
  echo "  Últimos pedidos:"
  echo "$LAST_PED" | grep -oP '"numero":\s*\K[0-9]+' | head -3 | while read -r NUM; do
    echo "    · Pedido #${NUM}"
  done
  LAST_DATA=$(echo "$LAST_PED" | grep -oP '"data":\s*"\K[^"]+' | head -1)
  echo "  Data mais recente: ${LAST_DATA}"
else
  echo "  ✗ Nenhum pedido encontrado!"
fi

echo ""

# ── 7. CONTAGEM DE REGISTROS POR TABELA ──
echo "▶ 7. Contagem de registros..."
echo ""

for TABLE in pedidos produtos contatos contas_receber contas_pagar vendedores; do
  RESP=$(curl -s "${SUPABASE_URL}/rest/v1/${TABLE}?select=id" \
    -H "apikey: ${ANON_KEY}" \
    -H "Authorization: Bearer ${ANON_KEY}" \
    -H "Prefer: count=exact" \
    -H "Range: 0-0" \
    -D - 2>/dev/null)

  COUNT=$(echo "$RESP" | grep -i "content-range" | grep -oP '/\K\d+' | head -1)
  echo "  ${TABLE}: ${COUNT:-?} registros"
done

echo ""
echo "══════════════════════════════════════════════════"
echo "  Verificação concluída!"
echo ""
echo "  Se algo falhou:"
echo "  1. Views/tabelas faltando → rodar supabase-setup.sql no SQL Editor"
echo "  2. Edge Function 404 → deployar sync-bling no Supabase"
echo "  3. Token inválido → gerar novo token OAuth do Bling"
echo "  4. Cron não roda → verificar pg_cron + pg_net no Supabase"
echo "══════════════════════════════════════════════════"
