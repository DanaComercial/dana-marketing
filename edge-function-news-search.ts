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
    // 1 unico request com termo do nicho — economiza requests
    const terms = ['uniforme', 'moda saude', 'varejo moda', 'confeccao', 'enfermagem', 'vestuario', 'roupa profissional']
    const term = terms[Math.floor(Math.random() * terms.length)]

    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(term)}&lang=pt&country=br&max=6&apikey=${GNEWS_API_KEY}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()

    const unique = (data.articles || [])
      .filter((a: any) => a.title && a.title.length > 15)
      .slice(0, 5)
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
