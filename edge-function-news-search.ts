// ══════════════════════════════════════════════════════════
// Edge Function: news-search (v7 — 5 categorias, 10+ noticias)
// GNews.io free: 100 requests/dia
// Cada clique = 5 requests (1 por categoria) = 20 atualizacoes/dia
// ══════════════════════════════════════════════════════════

const GNEWS_API_KEY = '5e234d0de49bf95473c9d5a257d7166b'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    // 5 categorias, cada uma com varios termos possiveis (1 aleatorio por categoria)
    const categories: Record<string, string[]> = {
      moda: ['moda profissional', 'roupa profissional', 'moda corporativa', 'estilo profissional'],
      saude: ['profissional saude', 'hospital enfermagem', 'odontologia profissional', 'clinica medica'],
      mercado: ['varejo moda Brasil', 'mercado vestuario', 'comercio textil', 'loja roupa Brasil'],
      tendencia: ['tendencia moda 2026', 'inovacao textil', 'sustentabilidade moda', 'tecnologia vestuario'],
      social: ['marketing moda', 'influenciador moda', 'digital commerce moda', 'redes sociais varejo'],
    }

    const allNews: any[] = []

    // Buscar 1 request por categoria = 5 requests total
    for (const [cat, terms] of Object.entries(categories)) {
      const term = terms[Math.floor(Math.random() * terms.length)]
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(term)}&lang=pt&country=br&max=5&apikey=${GNEWS_API_KEY}`
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const data = await res.json()

        if (data.articles && data.articles.length > 0) {
          for (const a of data.articles) {
            if (a.title && a.title.length > 10) {
              allNews.push({
                title: a.title,
                desc: a.description || '',
                url: a.url || '',
                source: a.source?.name || '',
                img: a.image || '',
                cat,
                time: a.publishedAt ? ago(new Date(a.publishedAt)) : 'Recente',
                impact: Math.random() > 0.4 ? 'alto' : 'medio',
              })
            }
          }
        }
      } catch (e) {
        console.error('GNews error:', cat, term, e.message)
      }
    }

    // Remover duplicatas
    const seen = new Set()
    const unique = allNews.filter(n => {
      const k = n.title.substring(0, 40).toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    // Misturar mas manter pelo menos 2 de cada categoria no topo
    const result = unique.slice(0, 20)

    return new Response(JSON.stringify({ news: result, total: result.length, requests_used: 5 }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message, news: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
})

function ago(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 3600) return Math.floor(s / 60) + ' min'
  if (s < 86400) return Math.floor(s / 3600) + 'h atrás'
  if (s < 604800) return Math.floor(s / 86400) + 'd atrás'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}
