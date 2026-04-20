// ══════════════════════════════════════════════════════════
// Edge Function: ai-chat
// Agente IA do DMS com tool-calling
// Motor primário: Groq (Llama 3.3 70B)
// Fallback automático: Gemini 2.5 Flash
//
// Uso:
//   POST /functions/v1/ai-chat
//   Body: { messages: [{role:'user',content:'...'}, ...] }
//   Headers: Authorization: Bearer <jwt_do_usuario>
// ══════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!

const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GEMINI_MODEL = 'gemini-2.5-flash'
const MAX_TOOL_ROUNDS = 5

// ═════════ FERRAMENTAS (tool-calling) ═════════
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'consultar_faturamento',
      description: 'Retorna faturamento total, pedidos e ticket médio de um período. Use pra perguntas como "quanto faturamos em março?", "qual a receita do ano?", "resumo financeiro de abril".',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', description: 'Período: "hoje", "mes_atual", "mes_passado", "ano_atual", "ano_passado", ou data formato YYYY-MM (ex: 2026-03)' }
        },
        required: ['periodo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'consultar_contas_financeiras',
      description: 'Retorna status de contas a pagar/receber: abertas, atrasadas, valores totais. Use pra "quanto tenho a receber?", "contas atrasadas", "fluxo de caixa".',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'top_clientes',
      description: 'Lista os melhores clientes por volume de pedidos ou receita num período. Use pra "meus melhores clientes", "top 5 clientes desse ano".',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', description: 'Período: "mes_atual", "ano_atual", "ano_passado", ou YYYY-MM' },
          limite: { type: 'number', description: 'Quantos retornar (padrão 5, máx 20)' },
          ordenar_por: { type: 'string', enum: ['receita', 'pedidos'], description: 'Padrão receita' }
        },
        required: ['periodo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'top_produtos',
      description: 'Produtos mais vendidos (quantidade) num período. Use pra "produto mais vendido", "top 10 produtos", "qual scrub vende mais".',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', description: '"mes_atual", "ano_atual", "ano_passado", ou YYYY-MM' },
          limite: { type: 'number', description: 'Padrão 10, máx 30' }
        },
        required: ['periodo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vendas_por_canal',
      description: 'Split de vendas por canal (Site, Loja+WhatsApp, Mercado Livre, Shopee, TikTok, Magalu) num período. Use pra "qual canal vende mais?", "comparar canais".',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', description: '"mes_atual", "ano_atual", "ano_passado", ou YYYY-MM' }
        },
        required: ['periodo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buscar_tarefas',
      description: 'Lista tarefas do Kanban por status ou responsável. Use pra "minhas tarefas", "tarefas pendentes", "tarefas da Dana".',
      parameters: {
        type: 'object',
        properties: {
          coluna: { type: 'string', description: 'Opcional: "afazer", "em_andamento", "revisao", "concluido"' },
          responsavel: { type: 'string', description: 'Opcional: nome do responsável' },
          limite: { type: 'number', description: 'Padrão 10' }
        },
        required: []
      }
    }
  }
]

// ═════════ IMPLEMENTAÇÃO DAS FERRAMENTAS ═════════
function resolverPeriodo(periodo: string): { inicio: string, fim: string, label: string } {
  const hoje = new Date()
  const ano = hoje.getFullYear()
  const mes = hoje.getMonth()
  const pad = (n: number) => String(n).padStart(2, '0')

  if (periodo === 'hoje') {
    const d = `${ano}-${pad(mes + 1)}-${pad(hoje.getDate())}`
    return { inicio: d, fim: d, label: 'hoje' }
  }
  if (periodo === 'mes_atual') {
    return {
      inicio: `${ano}-${pad(mes + 1)}-01`,
      fim: `${ano}-${pad(mes + 2)}-01`,
      label: `${pad(mes + 1)}/${ano}`
    }
  }
  if (periodo === 'mes_passado') {
    const m = mes === 0 ? 12 : mes
    const a = mes === 0 ? ano - 1 : ano
    const mNext = mes === 0 ? 1 : mes + 1
    const aNext = mes === 0 ? ano : ano
    return {
      inicio: `${a}-${pad(m)}-01`,
      fim: `${aNext}-${pad(mNext)}-01`,
      label: `${pad(m)}/${a}`
    }
  }
  if (periodo === 'ano_atual') return { inicio: `${ano}-01-01`, fim: `${ano + 1}-01-01`, label: String(ano) }
  if (periodo === 'ano_passado') return { inicio: `${ano - 1}-01-01`, fim: `${ano}-01-01`, label: String(ano - 1) }

  // Formato YYYY-MM
  if (/^\d{4}-\d{2}$/.test(periodo)) {
    const [a, m] = periodo.split('-').map(Number)
    const mNext = m === 12 ? 1 : m + 1
    const aNext = m === 12 ? a + 1 : a
    return { inicio: `${a}-${pad(m)}-01`, fim: `${aNext}-${pad(mNext)}-01`, label: `${pad(m)}/${a}` }
  }
  // Formato YYYY
  if (/^\d{4}$/.test(periodo)) return { inicio: `${periodo}-01-01`, fim: `${+periodo + 1}-01-01`, label: periodo }

  // Default: mês atual
  return resolverPeriodo('mes_atual')
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async function executarFerramenta(nome: string, args: any): Promise<any> {
  try {
    if (nome === 'consultar_faturamento') {
      const { inicio, fim, label } = resolverPeriodo(args.periodo || 'mes_atual')
      const { data, error } = await supabaseAdmin.from('pedidos')
        .select('total, total_produtos')
        .gte('data', inicio).lt('data', fim)
      if (error) return { erro: error.message }
      const pedidos = data?.length || 0
      const receita = (data || []).reduce((s, p) => s + (+p.total || +p.total_produtos || 0), 0)
      const ticket = pedidos > 0 ? receita / pedidos : 0
      return {
        periodo: label,
        receita_total: Math.round(receita),
        pedidos_total: pedidos,
        ticket_medio: Math.round(ticket),
      }
    }

    if (nome === 'consultar_contas_financeiras') {
      const { data: r } = await supabaseAdmin.from('dashboard_contas').select('*').single()
      return r || {}
    }

    if (nome === 'top_clientes') {
      const { inicio, fim, label } = resolverPeriodo(args.periodo || 'mes_atual')
      const limite = Math.min(+args.limite || 5, 20)
      const { data } = await supabaseAdmin.from('pedidos')
        .select('contato_nome, total, total_produtos')
        .gte('data', inicio).lt('data', fim)
        .not('contato_nome', 'is', null)
        .limit(10000)
      const agg: Record<string, { receita: number, pedidos: number }> = {}
      ;(data || []).forEach((p: any) => {
        const n = p.contato_nome || 'Sem nome'
        if (!agg[n]) agg[n] = { receita: 0, pedidos: 0 }
        agg[n].receita += (+p.total || +p.total_produtos || 0)
        agg[n].pedidos += 1
      })
      const ordem = (args.ordenar_por === 'pedidos') ? 'pedidos' : 'receita'
      const lista = Object.entries(agg)
        .sort((a, b) => (b[1] as any)[ordem] - (a[1] as any)[ordem])
        .slice(0, limite)
        .map(([nome, v]) => ({ nome, receita: Math.round(v.receita), pedidos: v.pedidos }))
      return { periodo: label, total_clientes: Object.keys(agg).length, top: lista }
    }

    if (nome === 'top_produtos') {
      const { inicio, fim, label } = resolverPeriodo(args.periodo || 'mes_atual')
      const limite = Math.min(+args.limite || 10, 30)
      const { data: peds } = await supabaseAdmin.from('pedidos')
        .select('id').gte('data', inicio).lt('data', fim).limit(10000)
      const ids = (peds || []).map((p: any) => p.id)
      if (ids.length === 0) return { periodo: label, top: [] }
      // Chunks de 200 pra IN clause
      const agg: Record<string, { qtd: number, descricao: string }> = {}
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200)
        const { data } = await supabaseAdmin.from('pedidos_itens')
          .select('codigo, descricao, quantidade').in('pedido_id', chunk)
        ;(data || []).forEach((it: any) => {
          const k = it.codigo || it.descricao
          if (!agg[k]) agg[k] = { qtd: 0, descricao: it.descricao }
          agg[k].qtd += +it.quantidade || 0
        })
      }
      const lista = Object.entries(agg)
        .sort((a, b) => b[1].qtd - a[1].qtd)
        .slice(0, limite)
        .map(([cod, v]) => ({ codigo: cod, descricao: v.descricao, quantidade: v.qtd }))
      return { periodo: label, top: lista }
    }

    if (nome === 'vendas_por_canal') {
      const { inicio, fim, label } = resolverPeriodo(args.periodo || 'mes_atual')
      const { data } = await supabaseAdmin.from('pedidos')
        .select('loja_id, total, total_produtos')
        .gte('data', inicio).lt('data', fim).limit(10000)
      const canais: Record<string, { nome: string, pedidos: number, receita: number }> = {}
      const mapCanal = (id: any) => {
        if (id == null || id === 0) return 'Site/B2B'
        if (id === 203536978) return 'Loja + WhatsApp'
        if (id === 205337834) return 'Mercado Livre'
        if (id === 205430008) return 'TikTok'
        if (id === 205522474) return 'Shopee'
        return 'Magalu/Outros'
      }
      ;(data || []).forEach((p: any) => {
        const c = mapCanal(p.loja_id)
        if (!canais[c]) canais[c] = { nome: c, pedidos: 0, receita: 0 }
        canais[c].pedidos += 1
        canais[c].receita += (+p.total || +p.total_produtos || 0)
      })
      const lista = Object.values(canais)
        .map(c => ({ ...c, receita: Math.round(c.receita) }))
        .sort((a, b) => b.receita - a.receita)
      return { periodo: label, canais: lista }
    }

    if (nome === 'buscar_tarefas') {
      let q = supabaseAdmin.from('tarefas').select('titulo, coluna, prioridade, responsavel, prazo, concluido').limit(+args.limite || 10)
      if (args.coluna) q = q.eq('coluna', args.coluna)
      if (args.responsavel) q = q.ilike('responsavel', `%${args.responsavel}%`)
      q = q.order('prazo', { ascending: true, nullsLast: true })
      const { data } = await q
      return { tarefas: data || [] }
    }

    return { erro: 'Ferramenta desconhecida: ' + nome }
  } catch (e: any) {
    return { erro: e.message }
  }
}

// ═════════ SYSTEM PROMPT ═════════
const SYSTEM_PROMPT = `Você é o assistente de IA do DMS (Dana Marketing System), o sistema interno de gestão da Dana Jalecos Exclusivos.

SOBRE A EMPRESA:
- Dana Jalecos Exclusivos · fundadora Daniela Binhotti Santos (2016)
- Fábrica + loja em Piçarras SC · 2ª loja em Balneário Camboriú SC
- Produtos: jalecos, scrubs e uniformes profissionais de saúde
- Canais: site danajalecos.com.br (Magazord), Mercado Livre, Shopee, TikTok Shop, Magalu, loja física, WhatsApp comercial
- ERP: Bling v3 (read-only). Sincronização Bling → Supabase rodando 24/7.

SEU PAPEL:
- Responder perguntas sobre vendas, financeiro, produtos, clientes, tarefas
- SEMPRE usar as ferramentas disponíveis pra buscar dados reais. Nunca invente números.
- Ser direto, conciso, em português BR informal (tom empresarial amigável)
- Usar formatação markdown leve (bold, listas) quando ajudar clareza
- Se a pergunta não for sobre dados da empresa, responda educadamente que é especializado em dados do DMS

IMPORTANTE:
- Dados monetários em Real brasileiro (R$)
- Considere o ano atual 2026
- Se o usuário não especificar período, assuma "mês atual"
- E-commerce do site (danajalecos.com.br) está aguardando integração com Magazord — não afirme números "do site" isoladamente sem ressalvas
- Se a ferramenta retornar erro, avise o usuário e sugira reformular`

// ═════════ CHAMADA PRO GROQ ═════════
async function chamarGroq(messages: any[]): Promise<any> {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 1024,
    })
  })
  if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`)
  return await r.json()
}

// ═════════ CHAMADA PRO GEMINI (formato próprio) ═════════
async function chamarGemini(messages: any[]): Promise<any> {
  // Converter formato OpenAI → Gemini
  const contents = []
  let sys = ''
  for (const m of messages) {
    if (m.role === 'system') { sys = m.content; continue }
    if (m.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: { content: m.content } } }] })
      continue
    }
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts: any[] = []
    if (m.content) parts.push({ text: m.content })
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        parts.push({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) } })
      }
    }
    contents.push({ role, parts })
  }
  const geminiTools = [{
    functionDeclarations: TOOLS.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))
  }]
  const body: any = {
    contents,
    tools: geminiTools,
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
  }
  if (sys) body.systemInstruction = { parts: [{ text: sys }] }

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`)
  const data = await r.json()

  // Normalizar pro formato OpenAI
  const cand = data.candidates?.[0]
  if (!cand) throw new Error('Gemini: sem resposta')
  const parts = cand.content?.parts || []
  const toolCalls: any[] = []
  let text = ''
  for (const p of parts) {
    if (p.text) text += p.text
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }
      })
    }
  }
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined
      }
    }],
    usage: { total_tokens: data.usageMetadata?.totalTokenCount || 0 }
  }
}

// ═════════ LOOP PRINCIPAL (chat completion com tool-calling) ═════════
async function rodarAgente(messages: any[]): Promise<{ resposta: string, modelo: string, tools: string[], tokens: number }> {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
  const toolsUsadas: string[] = []
  let usouFallback = false
  let tokensTotal = 0

  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    let resp: any
    try {
      resp = usouFallback ? await chamarGemini(msgs) : await chamarGroq(msgs)
    } catch (e: any) {
      if (!usouFallback) {
        console.warn('Groq falhou, tentando Gemini:', e.message)
        usouFallback = true
        resp = await chamarGemini(msgs)
      } else {
        throw e
      }
    }
    tokensTotal += resp.usage?.total_tokens || 0
    const msg = resp.choices[0].message
    msgs.push(msg)

    // Se chamou ferramentas, executar e loop
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        const nome = tc.function.name
        const args = JSON.parse(tc.function.arguments || '{}')
        toolsUsadas.push(nome)
        const resultado = await executarFerramenta(nome, args)
        msgs.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: nome,
          content: JSON.stringify(resultado)
        })
      }
      continue
    }

    // Resposta final
    return {
      resposta: msg.content || 'Sem resposta',
      modelo: usouFallback ? 'gemini-2.5-flash' : 'llama-3.3-70b',
      tools: toolsUsadas,
      tokens: tokensTotal
    }
  }
  return { resposta: 'Loop de ferramentas atingiu limite. Reformule.', modelo: 'timeout', tools: toolsUsadas, tokens: tokensTotal }
}

// ═════════ HANDLER HTTP ═════════
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const t0 = Date.now()
  let userId: string | null = null
  let userNome: string | null = null

  try {
    // Validar JWT do usuário
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer /, '')
    if (!jwt) return json({ error: 'Autenticação obrigatória' }, 401)

    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    })
    const { data: userData, error: userErr } = await supabaseUser.auth.getUser(jwt)
    if (userErr || !userData.user) return json({ error: 'JWT inválido' }, 401)
    userId = userData.user.id

    const { data: profile } = await supabaseAdmin.from('profiles').select('nome').eq('id', userId).single()
    userNome = profile?.nome || userData.user.email

    // Rate limit: 50/hora
    const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString()
    const { count } = await supabaseAdmin.from('ai_chat_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gte('created_at', umaHoraAtras)
    if ((count || 0) >= 50) {
      return json({ error: 'Limite de 50 perguntas/hora atingido. Aguarde uns minutos.' }, 429)
    }

    // Body
    const body = await req.json()
    const messages = body.messages || []
    if (!Array.isArray(messages) || messages.length === 0) return json({ error: 'messages[] obrigatório' }, 400)

    const ultimaPergunta = [...messages].reverse().find(m => m.role === 'user')?.content || ''

    // Rodar agente
    const { resposta, modelo, tools, tokens } = await rodarAgente(messages)
    const duracao = Date.now() - t0

    // Log
    await supabaseAdmin.from('ai_chat_log').insert({
      user_id: userId,
      user_nome: userNome,
      pergunta: ultimaPergunta,
      resposta,
      modelo,
      tools_usadas: tools,
      tokens_total: tokens,
      duracao_ms: duracao,
    })

    return json({ resposta, modelo, tools_usadas: tools, tokens, duracao_ms: duracao })
  } catch (e: any) {
    const duracao = Date.now() - t0
    console.error('ai-chat error:', e)
    if (userId) {
      try {
        await supabaseAdmin.from('ai_chat_log').insert({
          user_id: userId, user_nome: userNome, pergunta: '',
          erro: e.message, duracao_ms: duracao
        })
      } catch {}
    }
    return json({ error: e.message }, 500)
  }
})

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
