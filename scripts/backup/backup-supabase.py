#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Backup semanal do Supabase DMS (wltmiqbhziefusnzmmkt).

Usa a Management API (Personal Access Token) — NAO precisa da DB URI/password.

Output: backups/YYYY-MM-DD/
  _schema.json        — schema de todas as tabelas (columns, types, RLS policies)
  _tabelas.json       — mapa tabela -> contagem de rows
  <tabela>.json.gz    — dados de cada tabela (comprimido)
  _metadata.json      — timestamp, versao, conta

Roda localmente:
  SUPABASE_PAT=sbp_xxx PROJECT_REF=wltmiqbhziefusnzmmkt python backup-supabase.py

Roda via GitHub Action: secrets SUPABASE_PAT + PROJECT_REF.
"""
import json, os, sys, gzip, urllib.request, urllib.error, datetime, time
from pathlib import Path

try: sys.stdout.reconfigure(encoding="utf-8")
except: pass

PAT = os.environ.get("SUPABASE_PAT")
PROJECT = os.environ.get("PROJECT_REF", "wltmiqbhziefusnzmmkt")
OUTDIR_BASE = Path(os.environ.get("BACKUP_DIR", "backups"))

if not PAT:
    print("ERRO: defina SUPABASE_PAT no ambiente"); sys.exit(1)

HOJE = datetime.date.today().isoformat()
OUTDIR = OUTDIR_BASE / HOJE
OUTDIR.mkdir(parents=True, exist_ok=True)


_LAST_CALL = [0.0]
MIN_INTERVAL_S = 0.6  # max ~100 req/min com folga

def run_sql(sql, retries=5):
    # Rate-limit local (evita 429 no Management API)
    elapsed = time.time() - _LAST_CALL[0]
    if elapsed < MIN_INTERVAL_S:
        time.sleep(MIN_INTERVAL_S - elapsed)

    for i in range(retries):
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
            data=json.dumps({"query": sql}).encode(), method="POST",
            headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json",
                     "User-Agent": "Mozilla/5.0 DMS-Backup/1.0"},
        )
        try:
            resp = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
            _LAST_CALL[0] = time.time()
            return resp
        except urllib.error.HTTPError as e:
            code = e.code
            body = e.read().decode()[:300]
            # 429 = backoff exponencial
            if code == 429:
                wait = 10 * (i + 1)
                print(f"        [429] aguardando {wait}s (tentativa {i+1}/{retries})...")
                time.sleep(wait)
                continue
            if i == retries - 1:
                raise RuntimeError(f"SQL falhou: {code} {body}")
            time.sleep(2 * (i + 1))
    return []


def save_json_gz(obj, filename):
    path = OUTDIR / filename
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, default=str)
    return path.stat().st_size


print("=" * 70)
print(f"BACKUP DMS · {HOJE} · {PROJECT}")
print("=" * 70)

# 1) Lista todas as tabelas do schema public
print("\n[1/5] Lista de tabelas...")
tabelas = [r["table_name"] for r in run_sql("""
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
""")]
print(f"    {len(tabelas)} tabelas encontradas")

# 2) Schema completo (cols + types + nullable + defaults)
print("\n[2/5] Schema...")
schema = {}
for t in tabelas:
    cols = run_sql(f"""
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '{t}'
    ORDER BY ordinal_position;
    """)
    schema[t] = cols

# Policies RLS
policies = run_sql("""
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'public';
""")
schema["_policies"] = policies

# Views
views = run_sql("""
SELECT table_name, view_definition
FROM information_schema.views WHERE table_schema = 'public';
""")
schema["_views"] = views

# Functions (não backup de código, só assinatura — código pode ser enorme)
funcs = run_sql("""
SELECT n.nspname AS schema, p.proname AS name, pg_get_function_result(p.oid) AS returns,
       pg_get_function_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
ORDER BY p.proname;
""")
schema["_functions"] = funcs

save_json_gz(schema, "_schema.json.gz")
print(f"    schema: {len(tabelas)} tabelas, {len(policies)} policies, {len(views)} views, {len(funcs)} functions")

# 3) Tabelas pesadas são tratadas diferente (backup só de sample recente)
TABELAS_LEVES_FULL = set(tabelas)
# Tabelas com muitos rows — backup só dos últimos 90 dias (pra não estourar)
TABELAS_HEAVY = {
    "pedidos":              ("data", "90 days"),
    "contatos":             None,   # sempre completo — snapshot de clientes
    "produtos":             None,
    "ai_chat_log":          ("created_at", "60 days"),
    "activity_log":         ("created_at", "30 days"),
    "sync_log":             ("created_at", "60 days"),
    "cliente_insights":     ("created_at", "180 days"),
    "top_produtos_mes":     None,
    "avatares_ia_log":      ("created_at", "90 days"),
}

# 4) Dump dados
print("\n[3/5] Dumpando dados...")
contagens = {}
tamanhos = {}
erros = []

for t in tabelas:
    try:
        # Conta rows
        count_row = run_sql(f"SELECT COUNT(*) AS c FROM public.\"{t}\";")
        total = int(count_row[0]["c"]) if count_row else 0
        contagens[t] = total

        if total == 0:
            print(f"    [vazia] {t}")
            continue

        # Decide filtro
        heavy = TABELAS_HEAVY.get(t)
        where = ""
        if heavy:
            col, periodo = heavy
            where = f"WHERE {col} >= NOW() - INTERVAL '{periodo}'"

        # Busca em chunks de 5000 rows pra não estourar
        CHUNK = 5000
        all_rows = []
        offset = 0
        while True:
            rows = run_sql(f"""SELECT * FROM public."{t}" {where}
                                ORDER BY 1 LIMIT {CHUNK} OFFSET {offset};""")
            if not rows: break
            all_rows.extend(rows)
            if len(rows) < CHUNK: break
            offset += CHUNK
            if offset > 100000:  # sanity: max 100k rows por tabela
                print(f"    [aviso] {t}: truncado em 100k rows")
                break

        size = save_json_gz(all_rows, f"{t}.json.gz")
        tamanhos[t] = size
        print(f"    [ok] {t:35s} {total:>8d} rows → {size//1024:>5d} KB" + (" (recente)" if heavy else ""))
    except Exception as e:
        erros.append(f"{t}: {e}")
        print(f"    [x]  {t:35s} ERRO: {str(e)[:80]}")

# 5) Manifest / metadata
print("\n[4/5] Metadata...")
manifest = {
    "gerado_em": datetime.datetime.now().isoformat(),
    "data_backup": HOJE,
    "projeto": PROJECT,
    "total_tabelas": len(tabelas),
    "tabelas_com_dados": len([t for t in tabelas if contagens.get(t, 0) > 0]),
    "total_rows": sum(contagens.values()),
    "contagens": contagens,
    "tamanhos_kb": {k: v // 1024 for k, v in tamanhos.items()},
    "erros": erros,
    "versao_script": "1.0",
}
save_json_gz(manifest, "_metadata.json.gz")

# 6) README
print("\n[5/5] README...")
total_size = sum((OUTDIR / f).stat().st_size for f in os.listdir(OUTDIR))
readme = f"""BACKUP SUPABASE DMS
===================

Data: {HOJE}
Projeto: {PROJECT}
Total: {len(tabelas)} tabelas, {sum(contagens.values()):,} rows, {total_size // 1024:,} KB

Este diretório contém snapshot completo do banco DMS em formato JSON comprimido.

ARQUIVOS:
  _schema.json.gz     — schema de todas tabelas + RLS policies + views + functions
  _metadata.json.gz   — manifest do backup (contagens, tamanhos, erros)
  <tabela>.json.gz    — dados de cada tabela (UTF-8, JSON array)

PRA RESTAURAR PARCIAL (extrair 1 tabela):
  gunzip -c tabela.json.gz | jq '.[0]'

PRA RESTAURAR GERAL:
  Ler schema → recriar tabelas → inserir JSON via Supabase REST (upsert).

TABELAS COM FILTRO (só dados recentes):
  pedidos            → últimos 90 dias (pra não estourar)
  ai_chat_log        → últimos 60 dias
  activity_log       → últimos 30 dias
  sync_log           → últimos 60 dias
  cliente_insights   → últimos 180 dias
  avatares_ia_log    → últimos 90 dias

Tabelas críticas (clientes/contatos/produtos/briefings/etc) vão completas.
"""
(OUTDIR / "README.txt").write_text(readme, encoding="utf-8")

print("\n" + "=" * 70)
print(f"CONCLUIDO em {OUTDIR}")
print(f"Total: {len(tabelas)} tabelas · {sum(contagens.values()):,} rows · {total_size // 1024:,} KB")
if erros: print(f"Erros: {len(erros)}")
print("=" * 70)
