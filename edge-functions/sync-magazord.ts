// ════════════════════════════════════════════════════════════════════════════
// sync-magazord — espelha API Magazord (site danajalecos.com.br) → Supabase
// ════════════════════════════════════════════════════════════════════════════
// Cron diário (06:35 BRT) + invocação manual.
// Body: { recurso?: 'pedidos'|'pessoas'|'produtos'|'categorias'|'marcas'|'carrinhos'|'all',
//         dias_atras?: number (default 7 pra incremental, 9999 pra full) }
//
// Auth (descoberto em 08/05/2026 — Section 73 da doc):
//   Basic Auth com TOKEN como username e SENHA como password
//   Caminho: /v2/site/* (não /v1/)
//
// Endpoints validados:
//   /v2/site/pedido       → 5.133 pedidos
//   /v2/site/pessoa       → 5.720 pessoas (cliente do site)
//   /v2/site/produto      → 755 produtos
//   /v2/site/categoria    → 108 categorias
//   /v2/site/marca        → 4 marcas
//   /v2/site/carrinho     → liberado 08/05/2026 noite (precisa dataInicio+dataFim)
//
// Endpoints SEM permissão (continuam 405):
//   /v2/site/cliente, /v2/site/cupom, /v2/erp/*, /v2/site/carrinho/{id}
//
// 🔒 REGRA OPERACIONAL: SOMENTE LEITURA. Nunca POST/PUT/PATCH/DELETE.
// ════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SR = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const MZD_TOKEN = Deno.env.get('MAGAZORD_API_TOKEN')!
const MZD_SENHA = Deno.env.get('MAGAZORD_API_SENHA')!
const MZD_URL = (Deno.env.get('MAGAZORD_API_URL') || 'https://danajalecos.painel.magazord.com.br/api').replace(/\/$/, '')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type',
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

// ── Supabase REST helpers ──────────────────────────────────────────────────
async function supaUpsert(table: string, rows: any[], onConflict: string) {
  if (!rows.length) return 0
  let total = 0
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: {
        apikey: SR,
        Authorization: `Bearer ${SR}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(slice),
    })
    if (!res.ok)
      throw new Error(`upsert ${table} ${res.status}: ${(await res.text()).slice(0, 400)}`)
    total += slice.length
  }
  return total
}

// ── Magazord auth header ───────────────────────────────────────────────────
const MZD_AUTH = 'Basic ' + btoa(`${MZD_TOKEN}:${MZD_SENHA}`)

async function mzdGet(path: string): Promise<any> {
  const url = `${MZD_URL}${path}`
  const res = await fetch(url, {
    headers: { Authorization: MZD_AUTH, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Magazord ${res.status} ${path}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

// ── SHA256 hex (pra email_hash em pessoas) ────────────────────────────────
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.toLowerCase().trim()))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Paginação genérica Magazord ────────────────────────────────────────────
// Magazord retorna estrutura: { status: 'success', data: {items: [...], total?, ... } }
// ou { status, data: [...] }. Tratamos os dois formatos.
async function* paginate(basePath: string, limit = 100, queryExtra = ''): AsyncGenerator<any> {
  let page = 1
  const sep = basePath.includes('?') ? '&' : '?'
  while (true) {
    const path = `${basePath}${sep}page=${page}&limit=${limit}${queryExtra ? '&' + queryExtra : ''}`
    const j = await mzdGet(path)
    const data = j.data
    let items: any[] = []
    let total = 0
    if (Array.isArray(data)) {
      items = data
      total = data.length
    } else if (data && Array.isArray(data.items)) {
      items = data.items
      total = data.total || items.length
    } else {
      // pode vir vazio/diferente — tratamos como fim
      break
    }
    for (const it of items) yield it
    if (items.length < limit) break // última página
    if (page * limit >= total && total > 0) break
    page++
    if (page > 200) break // safety: 200 pages * 100 = 20k items max
  }
}

// ── ISO date (YYYY-MM-DD) ──────────────────────────────────────────────────
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

async function syncPedidos(diasAtras: number) {
  const desde = new Date()
  desde.setDate(desde.getDate() - diasAtras)
  const desdeIso = desde.toISOString()

  const rows: any[] = []
  let lidos = 0
  // Magazord aceita dataInicio (no payload de pedido o campo é dataHora)
  // Filtragem simples: pedimos a página completa e filtramos cliente-side por dataHora.
  for await (const p of paginate('/v2/site/pedido')) {
    lidos++
    const dh = p.dataHora ? new Date(p.dataHora) : null
    if (dh && diasAtras < 9000 && dh < desde) continue
    rows.push({
      id: p.id,
      codigo: p.codigo ?? null,
      codigo_marketplace: p.codigoMarketplace ?? null,
      data_hora: p.dataHora ?? null,
      valor_produto: p.valorProduto ?? 0,
      valor_frete: p.valorFrete ?? 0,
      valor_desconto: p.valorDesconto ?? 0,
      valor_acrescimo: p.valorAcrescimo ?? 0,
      valor_total: p.valorTotal ?? 0,
      cupom_id: p.cupomId ?? null,
      pessoa_id: p.pessoaId ?? null,
      pessoa_nome: p.pessoaNome ?? null,
      pessoa_cpf_cnpj: p.pessoaCpfCnpj ?? null,
      pessoa_contato: p.pessoaContato ?? null,
      forma_pagamento_id: p.formaPagamentoId ?? null,
      forma_pagamento_nome: p.formaPagamentoNome ?? null,
      forma_recebimento_id: p.formaRecebimentoId ?? null,
      forma_recebimento_nome: p.formaRecebimentoNome ?? null,
      condicao_pagamento_id: p.condicaoPagamentoId ?? null,
      condicao_pagamento_nome: p.condicaoPagamentoNome ?? null,
      pedido_situacao: p.pedidoSituacao ?? null,
      pedido_situacao_descricao: p.pedidoSituacaoDescricao ?? null,
      pedido_situacao_tipo: p.pedidoSituacaoTipo ?? null,
      loja_id: p.lojaId ?? null,
      loja_marketplace_id: p.lojaDoMarketplaceId ?? null,
      loja_marketplace_nome: p.lojaDoMarketplaceNome ?? null,
      raw: p,
      synced_at: new Date().toISOString(),
    })
    // safety: se já chegou em 6000+ com filtro nenhum, stop
    if (rows.length > 8000) break
  }
  const upserted = await supaUpsert('magazord_pedidos', rows, 'id')
  return { lidos, filtrados: rows.length, upserted, desde: desdeIso }
}

async function syncPessoas() {
  const rows: any[] = []
  let lidas = 0
  for await (const p of paginate('/v2/site/pessoa')) {
    lidas++
    const email = p.email ?? null
    rows.push({
      id: p.id,
      nome: p.nome ?? null,
      cpf_cnpj: p.cpfCnpj ?? null,
      email,
      email_hash: email ? await sha256Hex(email) : null,
      telefone: p.telefone ?? null,
      celular: p.celular ?? null,
      tipo: p.tipo ?? null,
      data_nascimento: p.dataNascimento ?? null,
      cidade: p.cidade ?? p.endereco?.cidade ?? null,
      uf: p.uf ?? p.endereco?.uf ?? null,
      cep: p.cep ?? p.endereco?.cep ?? null,
      ativo: p.ativo ?? null,
      data_cadastro: p.dataCadastro ?? null,
      raw: p,
      synced_at: new Date().toISOString(),
    })
    if (rows.length > 10000) break
  }
  const upserted = await supaUpsert('magazord_pessoas', rows, 'id')
  return { lidas, upserted }
}

async function syncProdutos() {
  const rows: any[] = []
  let lidos = 0
  for await (const p of paginate('/v2/site/produto')) {
    lidos++
    rows.push({
      id: p.id,
      nome: p.nome ?? null,
      modelo: p.modelo ?? null,
      palavra_chave: p.palavraChave ?? null,
      categoria_id: p.categoriaId ?? p.categoria?.id ?? null,
      marca_id: p.marcaId ?? p.marca?.id ?? null,
      preco: p.preco ?? null,
      preco_promo: p.precoPromocional ?? p.precoPromo ?? null,
      ativo: p.ativo ?? null,
      estoque: p.estoque ?? null,
      raw: p,
      synced_at: new Date().toISOString(),
    })
  }
  const upserted = await supaUpsert('magazord_produtos', rows, 'id')
  return { lidos, upserted }
}

async function syncCategorias() {
  const rows: any[] = []
  for await (const c of paginate('/v2/site/categoria')) {
    rows.push({
      id: c.id,
      nome: c.nome ?? null,
      pai_id: c.paiId ?? c.pai?.id ?? null,
      caminho: c.caminho ?? null,
      ativo: c.ativo ?? null,
      raw: c,
      synced_at: new Date().toISOString(),
    })
  }
  const upserted = await supaUpsert('magazord_categorias', rows, 'id')
  return { upserted }
}

async function syncMarcas() {
  const rows: any[] = []
  for await (const m of paginate('/v2/site/marca')) {
    rows.push({
      id: m.id,
      nome: m.nome ?? null,
      ativo: m.ativo ?? null,
      raw: m,
      synced_at: new Date().toISOString(),
    })
  }
  const upserted = await supaUpsert('magazord_marcas', rows, 'id')
  return { upserted }
}

async function syncCarrinhos(diasAtras: number) {
  // Carrinho exige dataAtualizacaoInicio + dataAtualizacaoFim (intervalo máx ~30 dias)
  const fim = new Date()
  const inicio = new Date()
  inicio.setDate(inicio.getDate() - Math.min(diasAtras, 30))
  const q = `dataAtualizacaoInicio=${isoDate(inicio)}&dataAtualizacaoFim=${isoDate(fim)}`

  const rows: any[] = []
  for await (const c of paginate(`/v2/site/carrinho?${q}`, 100)) {
    rows.push({
      id: c.id,
      status: c.status ?? null,
      hash: c.hash ?? null,
      data_inicio: c.dataInicio ?? null,
      data_atualizacao: c.dataAtualizacao ?? null,
      pedido_id: c.pedido?.id ?? null,
      pedido_codigo: c.pedido?.codigo ?? null,
      raw: c,
      synced_at: new Date().toISOString(),
    })
  }
  const upserted = await supaUpsert('magazord_carrinhos', rows, 'id')
  return { upserted, intervalo: `${isoDate(inicio)} → ${isoDate(fim)}` }
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const recurso = (body.recurso || 'all') as string
    const diasAtras = Math.max(1, parseInt(body.dias_atras ?? '7', 10) || 7)

    const t0 = Date.now()
    const result: Record<string, any> = { recurso, dias_atras: diasAtras }

    if (recurso === 'pedidos' || recurso === 'all') {
      result.pedidos = await syncPedidos(diasAtras)
    }
    if (recurso === 'pessoas' || recurso === 'all') {
      result.pessoas = await syncPessoas()
    }
    if (recurso === 'produtos' || recurso === 'all') {
      result.produtos = await syncProdutos()
    }
    if (recurso === 'categorias' || recurso === 'all') {
      result.categorias = await syncCategorias()
    }
    if (recurso === 'marcas' || recurso === 'all') {
      result.marcas = await syncMarcas()
    }
    if (recurso === 'carrinhos' || recurso === 'all') {
      result.carrinhos = await syncCarrinhos(diasAtras)
    }

    result.elapsed_ms = Date.now() - t0
    return json(result)
  } catch (e) {
    console.error('[sync-magazord] erro:', e)
    return json({ error: String(e?.message ?? e) }, 500)
  }
})
