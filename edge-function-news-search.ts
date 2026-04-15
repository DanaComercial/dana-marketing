// ══════════════════════════════════════════════════════════
// Edge Function: news-search (v9 — 1 request, 5+ noticias com imagem)
// ══════════════════════════════════════════════════════════

const GNEWS_API_KEY = '5e234d0de49bf95473c9d5a257d7166b'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    // Queries que retornam noticias do nicho de sites grandes
    // Cada uma usa OR para combinar termos e pegar mais resultados relevantes
    const queries = [
      'jaleco OR vestuario OR textil OR varejo moda',
      'confeccao OR enfermagem OR uniforme OR moda profissional',
      'varejo roupa OR industria textil OR vestuario OR moda saude',
      'jaleco OR uniforme OR textil OR moda varejo Brasil',
      'enfermagem OR confeccao OR vestuario OR roupa profissional',
    ]

    const query = queries[Math.floor(Math.random() * queries.length)]

    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=pt&country=br&max=10&apikey=${GNEWS_API_KEY}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const data = await res.json()

    const articles = (data.articles || [])
      .filter((a: any) => a.title && a.title.length > 15 && a.image)
      .slice(0, 6)
      .map((a: any) => ({
        title: a.title,
        desc: a.description || '',
        url: a.url || '',
        source: a.source?.name || '',
        img: a.image || '',
        cat: 'mercado',
        time: a.publishedAt ? ago(new Date(a.publishedAt)) : 'Recente',
        impact: Math.random() > 0.4 ? 'alto' : 'medio',
      }))

    return new Response(JSON.stringify({ news: articles, total: articles.length }), {
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
