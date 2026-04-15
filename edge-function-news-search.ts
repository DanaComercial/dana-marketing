// ══════════════════════════════════════════════════════════
// Edge Function: news-search (v5 — simples, sem cache)
// Busca noticias do Google News RSS e retorna direto
// ══════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    const allTerms = [
      'jaleco profissional', 'scrub médico', 'uniforme hospitalar',
      'confecção vestuário Brasil', 'moda profissional saúde',
      'indústria têxtil', 'e-commerce vestuário Brasil',
      'varejo moda crescimento', 'uniforme corporativo tendência',
      'enfermagem uniforme', 'odontologia jaleco',
      'sustentabilidade têxtil moda', 'mercado uniformes',
      'marketing moda digital', 'tendência uniforme profissional',
    ]

    const terms = allTerms.sort(() => Math.random() - 0.5).slice(0, 4)
    const allNews: any[] = []

    for (const term of terms) {
      try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
        const xml = await res.text()

        // Regex para extrair cada item
        const itemRegex = /<item>([\s\S]*?)<\/item>/g
        let match
        let count = 0
        while ((match = itemRegex.exec(xml)) !== null && count < 4) {
          const block = match[1]

          const title = extract(block, 'title')
          const source = extractSource(block)
          const pubDate = extract(block, 'pubDate')

          // Link: está entre <link/> e <guid
          let link = ''
          const linkM = block.match(/<link\/>\s*(https?:\/\/\S+)/s)
          if (linkM) link = linkM[1].trim()

          if (!title || title.length < 10) continue

          // Pegar imagem do Google News
          let img = ''
          if (link) {
            try {
              const gRes = await fetch(link, {
                signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
              })
              const html = await gRes.text()
              // og:image do Google News = thumbnail real
              const imgM = html.match(/content="(https:\/\/lh3\.googleusercontent\.com\/[^"]+)"/i)
              if (imgM) img = imgM[1].replace(/=s\d+-w\d+/, '=s0-w600')
              // Se nao achou lh3, tentar qualquer og:image
              if (!img) {
                const ogM = html.match(/property="og:image"[^>]*content="(https?:\/\/[^"]+)"/i)
                  || html.match(/content="(https?:\/\/[^"]+)"[^>]*property="og:image"/i)
                if (ogM && ogM[1] && !ogM[1].includes('google.com/images')) img = ogM[1]
              }
            } catch {}
          }

          let cat = 'mercado'
          const text = (term + ' ' + title).toLowerCase()
          if (/moda|feminino|estilo|design|personaliz|bordado/.test(text)) cat = 'moda'
          else if (/saúde|saude|hospital|enferm|odonto|médic|medic|clínic/.test(text)) cat = 'saude'
          else if (/tendên|tendenc|sustentab|inovaç|tecnolog/.test(text)) cat = 'tendencia'
          else if (/marketing|digital|influenc|instagram|tiktok|social|conteúdo/.test(text)) cat = 'social'

          allNews.push({
            title: clean(title),
            url: link,
            source: source || 'Google News',
            cat,
            img,
            time: pubDate ? ago(new Date(pubDate)) : 'Recente',
            impact: Math.random() > 0.4 ? 'alto' : 'medio',
          })
          count++
        }
      } catch (e) {
        console.error('Term error:', term, e.message)
      }
    }

    // Remover duplicatas e embaralhar
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

function extract(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
}

function extractSource(xml: string): string {
  const m = xml.match(/<source[^>]*>([\s\S]*?)<\/source>/)
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
}

function clean(t: string): string {
  return t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim()
}

function ago(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 3600) return Math.floor(s / 60) + ' min'
  if (s < 86400) return Math.floor(s / 3600) + 'h atrás'
  if (s < 604800) return Math.floor(s / 86400) + 'd atrás'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}
