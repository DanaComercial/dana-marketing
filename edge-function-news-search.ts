// ══════════════════════════════════════════════════════════
// Edge Function: news-search (v3 — simplificada e confiável)
// Nome: news-search
// ══════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    // Todos os termos de busca — pegar 5 aleatórios
    const allTerms = [
      'jaleco profissional', 'scrub médico', 'uniforme hospitalar',
      'moda profissional saúde', 'confecção uniformes Brasil',
      'vestuário profissional tendência', 'jaleco personalizado bordado',
      'mercado têxtil Brasil', 'e-commerce moda Brasil',
      'varejo vestuário crescimento', 'indústria confecção',
      'uniforme corporativo sustentável', 'tecido hospitalar inovação',
      'enfermagem uniforme', 'odontologia jaleco',
      'marketing moda profissional', 'influenciador saúde',
      'tendência uniforme 2026', 'scrub feminino colorido',
      'jaleco feminino acinturado',
    ]

    // Embaralhar e pegar 5 termos aleatórios
    const shuffled = allTerms.sort(() => Math.random() - 0.5)
    const selectedTerms = shuffled.slice(0, 5)

    const allNews: any[] = []

    // Categorias baseadas no termo
    function categorizeTerm(term: string): string {
      if (/moda|feminino|estilo|colorido|acinturado|personalizado|bordado/.test(term)) return 'moda'
      if (/saúde|hospitalar|enfermagem|odontologia|médico/.test(term)) return 'saude'
      if (/mercado|varejo|e-commerce|indústria|confecção|têxtil|crescimento/.test(term)) return 'mercado'
      if (/tendência|sustentável|inovação|tecnologia|2026/.test(term)) return 'tendencia'
      if (/marketing|influenciador|digital|TikTok|Instagram/.test(term)) return 'social'
      return 'mercado'
    }

    for (const term of selectedTerms) {
      try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`
        const rssRes = await fetch(rssUrl, { signal: AbortSignal.timeout(8000) })
        const rssText = await rssRes.text()

        const items = rssText.split('<item>').slice(1, 5)
        for (const item of items) {
          const title = clean(between(item, '<title>', '</title>'))
          const link = between(item, '<link/>', '<guid') || between(item, '<link>', '</link>')
          const pubDate = between(item, '<pubDate>', '</pubDate>')
          const source = clean(between(item, '<source', '</source>').replace(/^[^>]*>/, ''))

          if (title && title.length > 10) {
            let domain = ''
            try { domain = new URL(link.trim()).hostname.replace('www.', '') } catch {}

            allNews.push({
              cat: categorizeTerm(term),
              title,
              url: link.trim(),
              source: source || domain,
              domain,
              time: pubDate ? timeAgo(new Date(pubDate)) : 'Recente',
              impact: Math.random() > 0.5 ? 'alto' : 'medio',
            })
          }
        }
      } catch (e) {
        console.error('Erro buscando:', term, e.message)
      }
    }

    // Remover duplicatas por título
    const seen = new Set()
    const unique = allNews.filter(n => {
      const key = n.title.toLowerCase().substring(0, 50)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Embaralhar resultado final
    const result = unique.sort(() => Math.random() - 0.5).slice(0, 15)

    return new Response(JSON.stringify({ news: result, total: result.length }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message, news: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
})

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start)
  if (i === -1) return ''
  const s = i + start.length
  const e = text.indexOf(end, s)
  return e === -1 ? '' : text.substring(s, e).trim()
}

function clean(text: string): string {
  return text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim()
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 3600) return Math.floor(s / 60) + ' min'
  if (s < 86400) return Math.floor(s / 3600) + 'h atrás'
  if (s < 604800) return Math.floor(s / 86400) + 'd atrás'
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}
