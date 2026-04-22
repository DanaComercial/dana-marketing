// ══════════════════════════════════════════════════════════
// Cliente 360 — Boot script (Fase 2: dados reais do Supabase)
// ══════════════════════════════════════════════════════════

(function() {
  'use strict';

  const SUPABASE_URL = 'https://wltmiqbhziefusnzmmkt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsdG1pcWJoemllZnVzbnptbWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NzUxMzEsImV4cCI6MjA5MjQ1MTEzMX0.GfdryMC-RTnp2h-6RSHf1WBVYCCTfGtqHAXtilYHzTY';
  const PAGE_SIZE = 50;

  // Estado global simples
  const state = {
    sb: null,
    empresa: localStorage.getItem('c360_empresa') || 'matriz',
    clientes: [],                // cliente_scoring rows
    contatosByName: {},          // 'Nome' -> { telefone, celular, uf }
    filtered: [],
    segmentFilter: 'todos',
    ufFilter: 'todos',
    searchQuery: '',
    page: 0,
    loadingList: false,
    clientSelected: null,
  };

  // ─── DDD (2 primeiros digitos do fone) -> UF ───
  const DDD_TO_UF = {
    11:'SP',12:'SP',13:'SP',14:'SP',15:'SP',16:'SP',17:'SP',18:'SP',19:'SP',
    21:'RJ',22:'RJ',24:'RJ',
    27:'ES',28:'ES',
    31:'MG',32:'MG',33:'MG',34:'MG',35:'MG',37:'MG',38:'MG',
    41:'PR',42:'PR',43:'PR',44:'PR',45:'PR',46:'PR',
    47:'SC',48:'SC',49:'SC',
    51:'RS',53:'RS',54:'RS',55:'RS',
    61:'DF', 62:'GO',64:'GO', 63:'TO',
    65:'MT',66:'MT', 67:'MS',
    68:'AC', 69:'RO',
    71:'BA',73:'BA',74:'BA',75:'BA',77:'BA', 79:'SE',
    81:'PE',87:'PE', 82:'AL', 83:'PB', 84:'RN', 85:'CE',88:'CE', 86:'PI',89:'PI',
    91:'PA',93:'PA',94:'PA', 92:'AM',97:'AM', 95:'RR', 96:'AP', 98:'MA',99:'MA'
  };

  function phoneToUF(fone) {
    if (!fone) return null;
    const d = String(fone).replace(/\D/g,'');
    if (d.length < 10) return null;
    // Pula prefixo '55' se vier (codigo do Brasil)
    const digits = d.startsWith('55') && d.length > 11 ? d.slice(2) : d;
    const ddd = parseInt(digits.slice(0,2), 10);
    return DDD_TO_UF[ddd] || null;
  }

  // ─── Helpers ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const fmtBRL = (n) => (Number(n)||0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtNum = (n) => (Number(n)||0).toLocaleString('pt-BR');
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '-';
  const escapeHtml = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Empresa label
  const EMPRESA_LABELS = { matriz: 'Matriz (Piçarras)', bc: 'Balneário Camboriú' };

  // ─── Toggle de empresa (sidebar interno) ───
  function updateEmpresaToggleUI() {
    const btns = document.querySelectorAll('.c360-emp-btn');
    btns.forEach(b => {
      const emp = b.getAttribute('data-emp');
      const ativo = emp === state.empresa;
      if (ativo) {
        b.style.background = 'oklch(88% 0.018 80)';
        b.style.color = 'oklch(9% 0.008 260)';
        b.style.borderColor = 'oklch(88% 0.018 80)';
      } else {
        b.style.background = 'rgba(255,255,255,0.04)';
        b.style.color = 'rgba(255,255,255,0.7)';
        b.style.borderColor = 'rgba(255,255,255,0.1)';
      }
    });
  }

  window.c360SetEmpresa = async function(emp) {
    if (emp !== 'matriz' && emp !== 'bc') return;
    if (emp === state.empresa) return;
    state.empresa = emp;
    localStorage.setItem('c360_empresa', emp);
    updateEmpresaToggleUI();
    await loadClientes();
    state.page = 0;
    // Commit 3 vai atualizar o dashboard também
  };

  // Segmento -> badge style
  const SEGMENT_STYLES = {
    'VIP': { bg: 'bg-amber-500/15', fg: 'text-amber-400', border: 'border-amber-500/30' },
    'Frequente': { bg: 'bg-violet-500/15', fg: 'text-violet-400', border: 'border-violet-500/30' },
    'Ocasional': { bg: 'bg-blue-500/15', fg: 'text-blue-400', border: 'border-blue-500/30' },
    'Em Risco': { bg: 'bg-orange-500/15', fg: 'text-orange-400', border: 'border-orange-500/30' },
    'Inativo': { bg: 'bg-red-500/15', fg: 'text-red-400', border: 'border-red-500/30' },
    'Novo': { bg: 'bg-emerald-500/15', fg: 'text-emerald-400', border: 'border-emerald-500/30' },
    'Sem histórico': { bg: 'bg-zinc-500/15', fg: 'text-zinc-400', border: 'border-zinc-500/30' },
  };

  // Score color (barra horizontal)
  const scoreColor = (score) => {
    if (score >= 80) return 'bg-emerald-500';
    if (score >= 60) return 'bg-amber-500';
    if (score >= 40) return 'bg-orange-500';
    return 'bg-red-500';
  };

  // Risco baseado em dias sem compra + segmento
  const riscoBadge = (cliente) => {
    const dias = cliente.dias_sem_compra || 0;
    const seg = cliente.segmento;
    if (seg === 'Inativo' || dias > 365) return { label: 'Alto', cls: 'bg-red-500/15 text-red-400 border-red-500/30' };
    if (seg === 'Em Risco' || dias > 180) return { label: 'Médio', cls: 'bg-orange-500/15 text-orange-400 border-orange-500/30' };
    if (dias > 90) return { label: 'Baixo', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' };
    return { label: 'Ativo', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
  };

  // ─── Autenticação ───
  async function waitForSupabase() {
    // Espera o script @supabase/supabase-js carregar
    for (let i = 0; i < 50; i++) {
      if (window.supabase && window.supabase.createClient) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }

  async function initSupabase() {
    const ok = await waitForSupabase();
    if (!ok) { console.error('[c360] Supabase SDK não carregou'); return false; }
    state.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // Verifica sessão (compartilhada via localStorage, mesmo dominio)
    const { data: { session } } = await state.sb.auth.getSession();
    if (!session) {
      console.warn('[c360] Sem sessão — redirecionando pra login');
      if (window.parent && window.parent !== window.self) {
        window.parent.location.hash = '';
      }
      return false;
    }
    console.log('[c360] Autenticado como', session.user.email);
    return true;
  }

  // ─── Carrega clientes do Supabase ───
  async function loadClientes() {
    if (state.loadingList) return;
    state.loadingList = true;
    try {
      // Paraleliza: cliente_scoring + contatos
      const [scoringRes, contatosRes] = await Promise.all([
        state.sb.from('cliente_scoring')
          .select('*')
          .eq('empresa', state.empresa)
          .order('score', { ascending: false, nullsFirst: false })
          .limit(5000),
        loadContatosBatched(state.empresa),
      ]);

      if (scoringRes.error) {
        console.error('[c360] erro load clientes:', scoringRes.error);
        return;
      }

      state.clientes = scoringRes.data || [];
      state.contatosByName = contatosRes || {};
      console.log(`[c360] ${state.clientes.length} clientes + ${Object.keys(state.contatosByName).length} contatos (empresa=${state.empresa})`);

      buildUfOptions();
      applyFilters();
    } catch (e) {
      console.error('[c360] exception load:', e);
    } finally {
      state.loadingList = false;
    }
  }

  // Carrega contatos em lotes (evita timeout em 28k+ rows) e indexa por nome
  async function loadContatosBatched(empresa) {
    const map = {};
    const BATCH = 1000;
    let offset = 0;
    let total = 0;
    while (offset < 100000) {
      const { data, error } = await state.sb
        .from('contatos')
        .select('nome, telefone, celular')
        .eq('empresa', empresa)
        .range(offset, offset + BATCH - 1);
      if (error) { console.warn('[c360] erro contatos batch', offset, error); break; }
      if (!data || data.length === 0) break;
      for (const c of data) {
        if (!c.nome) continue;
        const fone = c.celular || c.telefone || '';
        const uf = phoneToUF(fone);
        map[c.nome] = { telefone: c.telefone || '', celular: c.celular || '', uf };
      }
      total += data.length;
      if (data.length < BATCH) break;
      offset += BATCH;
    }
    return map;
  }

  // Popula o <select> de UF com os estados realmente presentes
  function buildUfOptions() {
    const sel = document.getElementById('c360-uf-select');
    if (!sel) return;
    const ufs = {};
    for (const c of state.clientes) {
      const ct = state.contatosByName[c.contato_nome];
      if (ct && ct.uf) ufs[ct.uf] = (ufs[ct.uf] || 0) + 1;
    }
    const ordenados = Object.entries(ufs).sort((a,b) => b[1]-a[1]);
    const opts = ['<option value="todos">Todos os estados</option>']
      .concat(ordenados.map(([uf,c]) => `<option value="${uf}">${uf} (${c})</option>`))
      .concat(['<option value="null">Sem telefone</option>']);
    sel.innerHTML = opts.join('');
    sel.value = state.ufFilter;
  }

  function applyFilters() {
    const q = (state.searchQuery || '').trim().toLowerCase();
    const qDigits = q.replace(/\D/g, ''); // pra match em telefone
    state.filtered = state.clientes.filter(c => {
      // Segmento
      if (state.segmentFilter !== 'todos' && c.segmento !== state.segmentFilter) return false;
      // UF (inferida do fone via contatos)
      const ct = state.contatosByName[c.contato_nome];
      if (state.ufFilter !== 'todos') {
        if (state.ufFilter === 'null') {
          if (ct && ct.uf) return false; // quer os sem fone
        } else {
          if (!ct || ct.uf !== state.ufFilter) return false;
        }
      }
      // Busca: nome OU telefone OU celular
      if (q) {
        const nome = String(c.contato_nome || '').toLowerCase();
        const tel = (ct?.telefone || '').toLowerCase();
        const cel = (ct?.celular || '').toLowerCase();
        const telDigits = (ct?.telefone || '').replace(/\D/g,'');
        const celDigits = (ct?.celular || '').replace(/\D/g,'');
        const achou = nome.includes(q)
          || tel.includes(q) || cel.includes(q)
          || (qDigits.length >= 3 && (telDigits.includes(qDigits) || celDigits.includes(qDigits)));
        if (!achou) return false;
      }
      return true;
    });
    state.page = 0;
    renderList();
  }

  // ─── Renderiza lista de clientes ───
  function renderList() {
    // Acha a tabela de clientes na aba "clientes"
    const tbody = document.querySelector('#page-clientes table tbody');
    if (!tbody) { console.warn('[c360] tbody de clientes não encontrado'); return; }

    const total = state.filtered.length;
    const start = state.page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, total);
    const slice = state.filtered.slice(start, end);

    if (slice.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-12 text-center text-muted-foreground">Nenhum cliente encontrado.</td></tr>';
      renderPager(total, start, end);
      return;
    }

    const rows = slice.map(c => {
      const seg = c.segmento || 'Sem histórico';
      const segStyle = SEGMENT_STYLES[seg] || SEGMENT_STYLES['Sem histórico'];
      const risco = riscoBadge(c);
      const score = Number(c.score) || 0;
      const bar = scoreColor(score);
      const nome = escapeHtml(c.contato_nome || '—');
      const encoded = encodeURIComponent(c.contato_nome || '');

      return `
        <tr class="border-b border-border/50 hover:bg-white/3 cursor-pointer transition-colors group" onclick="showClientDetail('${encoded}')" style="cursor:pointer">
          <td class="px-4 py-3.5">
            <div>
              <p class="font-medium text-foreground text-sm group-hover:text-primary transition-colors">${nome}</p>
              <p class="text-xs text-muted-foreground/60">${EMPRESA_LABELS[c.empresa] || c.empresa}</p>
            </div>
          </td>
          <td class="px-4 py-3.5"><span class="inline-flex items-center rounded-full font-medium text-xs px-2.5 py-1 ${segStyle.bg} ${segStyle.fg} border ${segStyle.border}">${seg}</span></td>
          <td class="px-4 py-3.5 text-right"><span class="text-sm font-semibold text-foreground">${fmtNum(c.total_pedidos)}</span></td>
          <td class="px-4 py-3.5 text-right"><span class="text-sm font-semibold text-foreground">${fmtBRL(c.total_gasto)}</span></td>
          <td class="px-4 py-3.5 text-right"><span class="text-sm text-muted-foreground">${fmtBRL(c.ticket_medio)}</span></td>
          <td class="px-4 py-3.5">
            <div class="text-sm text-foreground">${fmtDate(c.ultima_compra)}</div>
            <div class="text-xs text-muted-foreground">Há ${fmtNum(c.dias_sem_compra)} dias</div>
          </td>
          <td class="px-4 py-3.5">
            <div class="flex items-center gap-2">
              <div class="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden min-w-[60px]">
                <div class="h-full ${bar} rounded-full" style="width:${score}%"></div>
              </div>
              <span class="text-xs font-semibold text-foreground w-7 text-right">${score}</span>
            </div>
          </td>
          <td class="px-4 py-3.5"><span class="inline-flex items-center rounded-full font-medium text-xs px-2.5 py-1 ${risco.cls} border">${risco.label}</span></td>
        </tr>`;
    }).join('');

    tbody.innerHTML = rows;
    renderPager(total, start, end);
  }

  function renderPager(total, start, end) {
    // Inserir um pager abaixo da tabela se ainda não existir
    let pager = document.getElementById('c360-pager');
    const tbl = document.querySelector('#page-clientes table');
    if (!pager && tbl && tbl.parentElement) {
      pager = document.createElement('div');
      pager.id = 'c360-pager';
      pager.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:rgb(161,161,170)';
      tbl.parentElement.appendChild(pager);
    }
    if (pager) {
      const totalPages = Math.ceil(total / PAGE_SIZE);
      pager.innerHTML = `
        <div>${total > 0 ? `Mostrando ${start+1}-${end} de ${fmtNum(total)}` : 'Sem resultados'}</div>
        <div style="display:flex;gap:8px">
          <button ${state.page<=0?'disabled':''} onclick="window.c360PagePrev()" class="px-3 py-1 rounded border border-white/10 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed">← Anterior</button>
          <span style="padding:4px 8px">Pág ${state.page+1}/${Math.max(1,totalPages)}</span>
          <button ${state.page>=totalPages-1?'disabled':''} onclick="window.c360PageNext()" class="px-3 py-1 rounded border border-white/10 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed">Próxima →</button>
        </div>
      `;
    }
  }

  window.c360PagePrev = () => { if (state.page > 0) { state.page--; renderList(); window.scrollTo(0,0); } };
  window.c360PageNext = () => {
    const total = state.filtered.length;
    if ((state.page+1) * PAGE_SIZE < total) { state.page++; renderList(); window.scrollTo(0,0); }
  };

  // ─── Filtros: busca + segmento + UF ───
  function wireSearchAndFilters() {
    // 1) Input de busca
    const searchInput = document.querySelector('#page-clientes input[placeholder*="Buscar"]');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value || '';
        applyFilters();
      });
    }

    // 2) Substituir os botoes Radix Select por <select> nativos
    // Estilo compartilhado pros dois
    const selectStyle = 'height:36px;padding:0 32px 0 12px;font-size:14px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.9);cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(161,161,170)" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>\');background-repeat:no-repeat;background-position:right 10px center;';

    // Estagios/segmento
    const btnSeg = Array.from(document.querySelectorAll('#page-clientes button[role="combobox"]')).find(b => (b.textContent || '').includes('estágios') || (b.textContent || '').includes('estagios'));
    if (btnSeg) {
      const sel = document.createElement('select');
      sel.id = 'c360-seg-select';
      sel.setAttribute('style', selectStyle + 'width:' + Math.max(180, btnSeg.offsetWidth) + 'px;');
      sel.innerHTML = [
        '<option value="todos">Todos os estágios</option>',
        '<option value="VIP">VIP</option>',
        '<option value="Frequente">Frequente</option>',
        '<option value="Ocasional">Ocasional</option>',
        '<option value="Em Risco">Em Risco</option>',
        '<option value="Inativo">Inativo</option>',
        '<option value="Novo">Novo</option>',
        '<option value="Sem histórico">Sem histórico</option>',
      ].join('');
      sel.value = state.segmentFilter;
      sel.addEventListener('change', (e) => {
        state.segmentFilter = e.target.value;
        applyFilters();
      });
      btnSeg.parentElement.replaceChild(sel, btnSeg);
    }

    // Estados/UF
    const btnUf = Array.from(document.querySelectorAll('#page-clientes button[role="combobox"]')).find(b => (b.textContent || '').includes('estados'));
    if (btnUf) {
      const sel = document.createElement('select');
      sel.id = 'c360-uf-select';
      sel.setAttribute('style', selectStyle + 'width:' + Math.max(160, btnUf.offsetWidth) + 'px;');
      sel.innerHTML = '<option value="todos">Todos os estados</option>';
      sel.value = state.ufFilter;
      sel.addEventListener('change', (e) => {
        state.ufFilter = e.target.value;
        applyFilters();
      });
      btnUf.parentElement.replaceChild(sel, btnUf);
    }
  }

  // (Filtro agora é gerenciado dentro do Cliente 360 via toggle sidebar - ver c360SetEmpresa)

  // ─── Detalhe de cliente (placeholder — sobrescreve a demo) ───
  // Será completado no Commit 2
  window.showClientDetail = function(clienteId) {
    console.log('[c360] showClientDetail (encoded):', clienteId);
    const nome = decodeURIComponent(clienteId);
    alert('Detalhe do cliente "' + nome + '" será implementado no próximo commit.\n\n(Fase 2 — Commit 1: lista dinâmica já funcionando!)');
  };

  // ─── Boot ───
  async function boot() {
    console.log('[c360] Boot iniciado · empresa=' + state.empresa);
    updateEmpresaToggleUI();
    const authOK = await initSupabase();
    if (!authOK) return;
    wireSearchAndFilters();
    await loadClientes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
