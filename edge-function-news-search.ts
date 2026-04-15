// ══════════════════════════════════════════════════════════
// Edge Function: news-search (v8 — termos simples, muitos resultados)
// ══════════════════════════════════════════════════════════

const GNEWS_API_KEY = '5e234d0de49bf95473c9d5a257d7166b'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    // Termos SIMPLES que retornam milhares de resultados
    const categories: Record<string, string[]> = {
      moda: ['moda', 'roupa', 'vestuario', 'confeccao', 'estilo'],
      saude: ['saude', 'hospital', 'enfermagem', 'clinica', 'medicina'],
      mercado: ['varejo', 'comercio', 'loja', 'consumo', 'economia'],
      tendencia: ['tendencia', 'inovacao', 'tecnologia', 'sustentabilidade', 'futuro'],
      social: ['instagram', 'influenciador', 'marketing digital', 'redes sociais', 'tiktok'],
    }

    const allNews: any[] = []

    for (const [cat, terms] of Object.entries(categories)) {
      const term = terms[Math.floor(Math.random() * terms.length)]
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(term)}&lang=pt&country=br&max=4&apikey=${GNEWS_API_KEY}`
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const data = await res.json()

        if (data.articles) {
          for (const a of data.articles) {
            if (a.title && a.title.length > 15) {
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
        console.error('Error:', cat, e.message)
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

    return new Response(JSON.stringify({ news: unique, total: unique.length }), {
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
