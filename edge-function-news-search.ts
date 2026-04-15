// ══════════════════════════════════════════════════════════
// Edge Function: news-search (v6 — GNews.io API com imagens)
// Gratis: 100 requests/dia
// TROCAR A API_KEY pela sua: https://gnews.io/register
// ══════════════════════════════════════════════════════════

const GNEWS_API_KEY = '5e234d0de49bf95473c9d5a257d7166b'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    const searchTerms = [
      'jaleco',
      'scrub saúde',
      'uniforme hospitalar',
      'vestuário profissional saúde',
      'confecção têxtil Brasil',
      'indústria têxtil moda',
      'varejo vestuário Brasil',
      'e-commerce moda',
      'mercado moda Brasil',
      'odontologia uniforme',
      'enfermagem profissional',
      'saúde profissional moda',
    ]

    // Pegar 2 termos aleatorios (economiza requests — 100/dia no plano free)
    const terms = searchTerms.sort(() => Math.random() - 0.5).slice(0, 2)
    const allNews: any[] = []

    for (const term of terms) {
      try {
        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(term)}&lang=pt&country=br&max=8&apikey=${GNEWS_API_KEY}`
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const data = await res.json()

        if (data.articles) {
          for (const a of data.articles) {
            let cat = 'mercado'
            const text = (term + ' ' + a.title).toLowerCase()
            if (/moda|feminino|estilo|design|personaliz|bordado/.test(text)) cat = 'moda'
            else if (/saúde|saude|hospital|enferm|odonto|médic|medic|clínic/.test(text)) cat = 'saude'
            else if (/tendên|tendenc|sustentab|inovaç|tecnolog/.test(text)) cat = 'tendencia'
            else if (/marketing|digital|influenc|instagram|tiktok|social/.test(text)) cat = 'social'

            allNews.push({
              title: a.title || '',
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
      } catch (e) {
        console.error('GNews error:', term, e.message)
      }
    }

    // Remover duplicatas
    const seen = new Set()
    const unique = allNews.filter(n => {
      const k = n.title.substring(0, 40).toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }).sort(() => Math.random() - 0.5).slice(0, 15)

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
