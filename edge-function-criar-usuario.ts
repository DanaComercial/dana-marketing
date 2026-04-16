// ══════════════════════════════════════════════════════════
// Edge Function: criar-usuario
// Cria usuario no Supabase Auth + profile
// Só admin pode chamar (verifica token JWT)
// Deployar no Supabase como: criar-usuario
// ══════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, apikey, Content-Type' },
    })
  }

  try {
    // Verificar se quem chamou é admin
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ ok: false, error: 'Não autorizado' }, 401)

    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Decodificar o JWT para pegar o user_id
    const token = authHeader.replace('Bearer ', '')
    const { data: { user: caller } } = await createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!).auth.getUser(token)
    if (!caller) return jsonResponse({ ok: false, error: 'Token inválido' }, 401)

    // Verificar se é admin
    const { data: callerProfile } = await supabaseUser.from('profiles').select('cargo').eq('id', caller.id).single()
    if (!callerProfile || callerProfile.cargo !== 'admin') {
      return jsonResponse({ ok: false, error: 'Apenas administradores podem criar usuários' }, 403)
    }

    // Pegar dados do body
    const body = await req.json()
    const { nome, email, senha, cargo } = body
    if (!nome || !email || !senha) return jsonResponse({ ok: false, error: 'Nome, email e senha são obrigatórios' }, 400)
    if (senha.length < 6) return jsonResponse({ ok: false, error: 'Senha deve ter no mínimo 6 caracteres' }, 400)

    // Criar usuario no Supabase Auth
    const { data: newUser, error: authError } = await supabaseUser.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true, // Confirma email automaticamente
      user_metadata: { nome },
    })

    if (authError) return jsonResponse({ ok: false, error: authError.message }, 400)

    // Atualizar profile com nome e cargo corretos
    if (newUser?.user) {
      await supabaseUser.from('profiles').upsert({
        id: newUser.user.id,
        nome,
        cargo: cargo || 'vendedor',
      }, { onConflict: 'id' })
    }

    return jsonResponse({ ok: true, user_id: newUser?.user?.id, email })

  } catch (e: any) {
    console.error('Criar usuario error:', e)
    return jsonResponse({ ok: false, error: e.message }, 500)
  }
})

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}
