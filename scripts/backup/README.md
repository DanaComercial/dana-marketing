# 💾 Backup Supabase DMS

Backup semanal automatizado via **GitHub Actions**.

## Como funciona

- **Quando:** todo domingo 03:07 UTC (00:07 BRT) — off-peak, evita picos de load
- **Onde:** `backups/YYYY-MM-DD/` no próprio repositório (versionado via git)
- **Rotação:** mantém últimos **12 domingos** (3 meses de histórico)
- **Escopo:** 48 tabelas, ~120k rows, ~4-5 MB comprimidos
- **Como:** script Python via Management API (sem precisar da DB password)

## Setup inicial (fazer 1x)

### 1. Adicionar 2 secrets no GitHub

Vai em https://github.com/DanaComercial/dana-marketing/settings/secrets/actions → **New repository secret**.

| Nome do secret | Valor |
|---|---|
| `SUPABASE_PAT` | `sbp_4057fd5bf659bd93fa24ff356559e245bb8ba83e` |
| `PROJECT_REF` | `wltmiqbhziefusnzmmkt` |

### 2. Ativar Actions

Em https://github.com/DanaComercial/dana-marketing/settings/actions:
- **Actions permissions** → "Allow all actions and reusable workflows"
- **Workflow permissions** → "Read and write permissions" (pro workflow conseguir commitar)

### 3. Rodar a primeira vez manualmente (opcional, mas recomendado)

1. Vai em https://github.com/DanaComercial/dana-marketing/actions
2. Clica em **"Backup Supabase DMS (semanal)"** na barra lateral
3. Clica em **"Run workflow"** (botão verde à direita)
4. Em ~3-5 min, vai aparecer uma pasta `backups/2026-MM-DD/` no repositório

Depois disso é automático. Todo domingo.

## Executar localmente

```bash
SUPABASE_PAT=sbp_xxx \
PROJECT_REF=wltmiqbhziefusnzmmkt \
BACKUP_DIR=./backups \
python scripts/backup/backup-supabase.py
```

## Tabelas com filtro de data

Pra evitar estourar o repositório, algumas tabelas grandes backupam só dados recentes:

| Tabela | Janela |
|---|---|
| `pedidos` | últimos 90 dias |
| `ai_chat_log` | últimos 60 dias |
| `activity_log` | últimos 30 dias |
| `sync_log` | últimos 60 dias |
| `cliente_insights` | últimos 180 dias |
| `avatares_ia_log` | últimos 90 dias |

Tabelas críticas (contatos, produtos, profiles, briefings, criativos, etc) vão **completas**.

## Estrutura do backup

```
backups/2026-04-24/
├── README.txt               manifest legível
├── _metadata.json.gz        contagens, tamanhos, erros
├── _schema.json.gz          schema + RLS policies + views + functions
├── contatos.json.gz         40.990 rows
├── pedidos.json.gz          13.237 rows (90d)
├── produtos.json.gz         4.752 rows
├── pedidos_itens.json.gz    30.876 rows
└── ... (mais 40+ tabelas)
```

## Como restaurar

### Ver conteúdo sem extrair
```bash
gunzip -c backups/2026-04-24/contatos.json.gz | jq '.[0:3]'
```

### Restaurar tabela específica
```bash
gunzip -c backups/2026-04-24/contatos.json.gz | \
  jq -c '.[]' | while read row; do
    curl -X POST "https://wltmiqbhziefusnzmmkt.supabase.co/rest/v1/contatos" \
      -H "apikey: $SERVICE_KEY" \
      -H "Authorization: Bearer $SERVICE_KEY" \
      -H "Content-Type: application/json" \
      -H "Prefer: resolution=merge-duplicates" \
      -d "$row"
  done
```

### Restaurar o DMS inteiro (disaster recovery)
1. Criar novo projeto Supabase
2. Rodar `_schema.json.gz` pra recriar tabelas (extrair DDL dos schemas)
3. Rodar script de restore que itera cada `<tabela>.json.gz` e faz upsert

## Custo

**Zero.** GitHub Actions free tier = 2.000min/mês, cada backup leva ~3-5min, então cabe ~400 execuções/mês.

## Monitoramento

- Email automático do GitHub se a action falhar
- Aba Actions mostra histórico completo + logs
- Cada backup tem um `GITHUB_STEP_SUMMARY` com tamanho e pastas preservadas

## Limitações conhecidas

1. Tabelas com > 100.000 rows são truncadas (sanity check). Nenhuma tabela do DMS bate isso hoje.
2. Rate limit: Management API throttle em ~60 req/min — o script usa 0.6s entre queries
3. Storage do Supabase (buckets) **NÃO** é backup automaticamente. Imagens ficam no ImgBB (que não é nosso).
4. Edge functions não são backupadas via este script (ficam no `edge-functions/` do repo já).
