// ══════════════════════════════════════════════════════════
// Edge Function: google-suggest
// Proxy CORS para Google Suggest — deployar no Supabase
// Nome: google-suggest
// ══════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  // CORS headers
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type',
      },
    })
  }

  try {
    const url = new URL(req.url)
    const q = url.searchParams.get('q') || ''
    const hl = url.searchParams.get('hl') || 'pt-BR'

    if (!q) {
      return new Response(JSON.stringify({ error: 'Parâmetro q obrigatório' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const googleUrl = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(hl)}&q=${encodeURIComponent(q)}`
    const res = await fetch(googleUrl)

    // Ler como bytes e decodificar como UTF-8 explicitamente
    const bytes = await res.arrayBuffer()
    const text = new TextDecoder('utf-8').decode(bytes)
    const data = JSON.parse(text)

    // data[0] = query original, data[1] = array de sugestões
    const suggestions = Array.isArray(data) && data[1] ? data[1] : []

    return new Response(JSON.stringify(suggestions), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
})
