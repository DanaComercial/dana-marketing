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
    clientes: [],
    filtered: [],
    segmentFilter: 'todos',
    ufFilter: 'todos',
    searchQuery: '',
    page: 0,
    loadingList: false,
    clientSelected: null,
  };
  // Cache por empresa (TTL 5min) - evita reload ao trocar matriz<->bc
  const cache = { matriz: null, bc: null };
  const CACHE_TTL = 5 * 60 * 1000;

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
    state.page = 0;
    await Promise.all([loadClientes(), loadDashboardResumo()]);
    // Re-renderiza segmentos se for a aba ativa (a funcao é definida adiante)
    if (typeof window.c360ReRenderSegmentosIfActive === 'function') {
      await window.c360ReRenderSegmentosIfActive();
    }
    // Re-renderiza campanhas se for a aba ativa
    if (typeof window.c360ReRenderCampanhasIfActive === 'function') {
      await window.c360ReRenderCampanhasIfActive();
    }
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
  function setLoadingIndicator(on) {
    const tbody = document.querySelector('#page-clientes table tbody');
    if (on && tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-12 text-center text-muted-foreground">⏳ Carregando clientes...</td></tr>';
    }
  }

  async function loadClientes() {
    if (state.loadingList) return;
    state.loadingList = true;
    try {
      // Cache hit?
      const c = cache[state.empresa];
      if (c && Date.now() - c.ts < CACHE_TTL) {
        state.clientes = c.rows;
        console.log(`[c360] cache hit (${state.empresa}): ${state.clientes.length}`);
        buildUfOptions();
        applyFilters();
        return;
      }

      setLoadingIndicator(true);

      // 1 query só — view server-side ja traz telefone/celular
      const { data, error } = await state.sb
        .from('cliente_scoring_full')
        .select('*')
        .eq('empresa', state.empresa)
        .order('score', { ascending: false, nullsFirst: false })
        .limit(5000);

      if (error) {
        console.error('[c360] erro load clientes:', error);
        return;
      }

      // Enriquece cada row com uf calculada (cliente-side)
      const rows = (data || []).map(r => ({
        ...r,
        uf: phoneToUF(r.celular || r.telefone)
      }));

      state.clientes = rows;
      cache[state.empresa] = { rows, ts: Date.now() };
      console.log(`[c360] ${rows.length} clientes (empresa=${state.empresa}) em 1 query`);

      buildUfOptions();
      applyFilters();
    } catch (e) {
      console.error('[c360] exception load:', e);
    } finally {
      state.loadingList = false;
    }
  }

  // Popula o <select> de UF com os estados realmente presentes
  function buildUfOptions() {
    const sel = document.getElementById('c360-uf-select');
    if (!sel) return;
    const ufs = {};
    for (const c of state.clientes) {
      if (c.uf) ufs[c.uf] = (ufs[c.uf] || 0) + 1;
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
    const qDigits = q.replace(/\D/g, '');
    state.filtered = state.clientes.filter(c => {
      if (state.segmentFilter !== 'todos' && c.segmento !== state.segmentFilter) return false;
      if (state.ufFilter !== 'todos') {
        if (state.ufFilter === 'null') { if (c.uf) return false; }
        else { if (c.uf !== state.ufFilter) return false; }
      }
      if (q) {
        const nome = String(c.contato_nome || '').toLowerCase();
        const tel = String(c.telefone || '').toLowerCase();
        const cel = String(c.celular || '').toLowerCase();
        const telDigits = String(c.telefone || '').replace(/\D/g,'');
        const celDigits = String(c.celular || '').replace(/\D/g,'');
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
    // color-scheme:dark faz o popup do <select> herdar tema dark do OS
    const selectStyle = 'height:36px;padding:0 32px 0 12px;font-size:14px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(20,20,25,1);color:rgba(255,255,255,0.9);cursor:pointer;appearance:none;-webkit-appearance:none;color-scheme:dark;background-image:url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(161,161,170)" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>\');background-repeat:no-repeat;background-position:right 10px center;';

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

  // ─── Mapeamentos Bling ───
  const LOJA_NOMES = {
    0: 'Site (e-commerce)', null: 'Site (e-commerce)',
    203536978: 'Loja/WhatsApp (Piçarras)',
    203550865: 'Loja Física BC',
    205337834: 'Mercado Livre',
    205430008: 'TikTok Shop',
    205522474: 'Shopee',
  };
  function lojaNome(lojaId) {
    if (lojaId === null || lojaId === 0 || lojaId === undefined) return 'Site (e-commerce)';
    return LOJA_NOMES[lojaId] || 'Magalu';
  }

  // Situacoes Bling
  const SITUACAO_LABELS = {
    1: 'Em aberto', 2: 'Atendido', 3: 'Cancelado', 6: 'Em aberto',
    9: 'Atendido', 12: 'Cancelado', 15: 'Em andamento',
  };
  const SITUACAO_COLORS = {
    Atendido: { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' },
    'Em aberto': { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24' },
    Cancelado: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
    'Em andamento': { bg: 'rgba(96,165,250,0.15)', fg: '#60a5fa' },
  };

  // RFM 0-5 baseado nos dados
  function computeRFM(c) {
    const dias = c.dias_sem_compra || 9999;
    const pedidos = c.total_pedidos || 0;
    const gasto = Number(c.total_gasto) || 0;
    const r = dias < 30 ? 5 : dias < 60 ? 4 : dias < 120 ? 3 : dias < 240 ? 2 : dias < 365 ? 1 : 0;
    const f = pedidos >= 15 ? 5 : pedidos >= 8 ? 4 : pedidos >= 4 ? 3 : pedidos >= 2 ? 2 : pedidos >= 1 ? 1 : 0;
    const m = gasto >= 20000 ? 5 : gasto >= 10000 ? 4 : gasto >= 5000 ? 3 : gasto >= 2000 ? 2 : gasto >= 500 ? 1 : 0;
    return { r, f, m };
  }

  // Probabilidade de recompra 0-100 (heuristica)
  function probRecompra(c) {
    let p = c.score || 0;
    const dias = c.dias_sem_compra || 9999;
    if (dias < 60) p = Math.min(100, p + 10);
    else if (dias > 365) p = Math.max(0, p - 25);
    else if (dias > 180) p = Math.max(0, p - 10);
    return Math.round(p);
  }

  // ─── Busca pedidos + itens do cliente ───
  async function fetchPedidosCliente(contatoNome, empresa) {
    const { data: pedidos, error } = await state.sb
      .from('pedidos')
      .select('id, numero, data, data_saida, total, total_produtos, situacao_id, loja_id, vendedor_nome, numero_loja')
      .eq('empresa', empresa)
      .eq('contato_nome', contatoNome)
      .order('data', { ascending: false })
      .limit(100);
    if (error) { console.error('[c360] erro pedidos:', error); return []; }
    if (!pedidos || pedidos.length === 0) return [];

    // Busca itens dos pedidos em 1 query
    const pedidoIds = pedidos.map(p => p.id);
    const { data: itens } = await state.sb
      .from('pedidos_itens')
      .select('pedido_id, descricao, codigo, quantidade, valor_unitario, valor_total')
      .in('pedido_id', pedidoIds);

    const itensByPedido = {};
    (itens || []).forEach(i => {
      if (!itensByPedido[i.pedido_id]) itensByPedido[i.pedido_id] = [];
      itensByPedido[i.pedido_id].push(i);
    });

    return pedidos.map(p => ({ ...p, itens: itensByPedido[p.id] || [] }));
  }

  // Categoria e canal preferidos
  function computeFavoritos(pedidos) {
    const lojaCount = {};
    const catCount = {};
    for (const p of pedidos) {
      const lnome = lojaNome(p.loja_id);
      lojaCount[lnome] = (lojaCount[lnome] || 0) + 1;
      for (const it of p.itens || []) {
        // Categoria heuristica por palavras-chave na descricao
        const desc = String(it.descricao || '').toLowerCase();
        let cat = 'Outros';
        if (desc.includes('jaleco')) cat = 'Jalecos';
        else if (desc.includes('scrub')) cat = 'Scrubs';
        else if (desc.includes('kit')) cat = 'Kits';
        else if (desc.includes('conjunto')) cat = 'Conjuntos';
        else if (desc.includes('camisa') || desc.includes('blusa')) cat = 'Camisas';
        else if (desc.includes('calca') || desc.includes('calça')) cat = 'Calças';
        else if (desc.includes('avental')) cat = 'Aventais';
        else if (desc.includes('gorro') || desc.includes('touca')) cat = 'Acessórios';
        catCount[cat] = (catCount[cat] || 0) + (Number(it.quantidade) || 1);
      }
    }
    const topLoja = Object.entries(lojaCount).sort((a,b) => b[1]-a[1])[0]?.[0] || '—';
    const topCat  = Object.entries(catCount).sort((a,b) => b[1]-a[1])[0]?.[0] || '—';
    return { canalPreferido: topLoja, categoriaPreferida: topCat };
  }

  // ─── Detalhe do cliente (Fase 2 · Commit 2) ───
  window.showClientDetail = async function(clienteId) {
    const nome = decodeURIComponent(clienteId);
    const page = document.getElementById('page-cliente-1');
    if (!page) { console.error('[c360] page-cliente-1 nao encontrada'); return; }

    // Loading state
    page.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.5)">⏳ Carregando dados de ' + escapeHtml(nome) + '...</div>';
    document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active'));
    page.classList.add('active');
    window.scrollTo(0,0);

    try {
      // Cliente completo + pedidos
      const c = state.clientes.find(x => x.contato_nome === nome);
      const [pedidos] = await Promise.all([ fetchPedidosCliente(nome, state.empresa) ]);
      const fav = computeFavoritos(pedidos);
      renderClientDetail(c, nome, pedidos, fav);
    } catch (e) {
      console.error('[c360] erro detalhe:', e);
      page.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444">Erro ao carregar: ' + escapeHtml(String(e.message||e)) + '</div>';
    }
  };

  function renderClientDetail(c, nome, pedidos, fav) {
    const page = document.getElementById('page-cliente-1');
    if (!page) return;
    if (!c) {
      page.innerHTML = '<div style="padding:40px;text-align:center"><button onclick="showPage(\'clientes\')" style="color:#94a3b8;background:none;border:none;cursor:pointer;margin-bottom:20px">← Voltar</button><div style="color:rgba(255,255,255,0.5)">Cliente "'+escapeHtml(nome)+'" nao encontrado na empresa atual.</div></div>';
      return;
    }

    const seg = c.segmento || 'Sem histórico';
    const segStyle = SEGMENT_STYLES[seg] || SEGMENT_STYLES['Sem histórico'];
    const risco = riscoBadge(c);
    const score = Number(c.score) || 0;
    const rfm = computeRFM(c);
    const pRec = probRecompra(c);
    const initial = (nome.trim()[0] || '?').toUpperCase();
    const tipo = c.tipo_pessoa === 'J' ? 'Pessoa Jurídica' : c.tipo_pessoa === 'F' ? 'Pessoa Física' : (c.tipo_pessoa || '');
    const doc = c.numero_documento ? (tipo === 'Pessoa Jurídica' ? 'CNPJ: ' : tipo === 'Pessoa Física' ? 'CPF: ' : 'Doc: ') + c.numero_documento : '';
    const fone = c.celular || c.telefone || '';

    // Ciclo medio: dias entre pedidos consecutivos
    let cicloMedio = '—';
    if (pedidos.length >= 2) {
      const datas = pedidos.map(p => new Date(p.data)).sort((a,b) => a-b);
      let soma = 0, n = 0;
      for (let i = 1; i < datas.length; i++) { soma += (datas[i] - datas[i-1]) / 86400000; n++; }
      cicloMedio = n > 0 ? Math.round(soma/n) + ' dias' : '—';
    }
    // Proxima estimada: ultima_compra + ciclo
    let proximaEstimada = '—';
    let diasProxima = '';
    if (c.ultima_compra && pedidos.length >= 2) {
      const cmDias = parseInt(cicloMedio, 10);
      if (!isNaN(cmDias)) {
        const dt = new Date(c.ultima_compra + 'T00:00:00');
        dt.setDate(dt.getDate() + cmDias);
        proximaEstimada = dt.toLocaleDateString('pt-BR');
        const hoje = new Date();
        const dif = Math.round((dt - hoje) / 86400000);
        diasProxima = dif > 0 ? 'Em ' + dif + ' dias' : dif < 0 ? 'Atrasado ' + (-dif) + ' dias' : 'Hoje';
      }
    }

    const barColor = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : score >= 40 ? '#f97316' : '#ef4444';
    const barRecColor = pRec >= 70 ? '#22c55e' : pRec >= 40 ? '#eab308' : '#ef4444';
    const recLabel = pRec >= 70 ? 'Alta chance de recompra' : pRec >= 40 ? 'Média chance de recompra' : 'Baixa chance — reativar';

    const fmtStatus = (sitId) => {
      const lbl = SITUACAO_LABELS[sitId] || 'Situação ' + sitId;
      const col = SITUACAO_COLORS[lbl] || SITUACAO_COLORS['Em aberto'];
      return { lbl, bg: col.bg, fg: col.fg };
    };

    const pedidosHtml = pedidos.length === 0
      ? '<div style="padding:24px;text-align:center;color:#64748b;font-size:13px">Sem pedidos cadastrados.</div>'
      : pedidos.map(p => {
          const st = fmtStatus(p.situacao_id);
          const valor = Number(p.total) || Number(p.total_produtos) || 0;
          const itensHtml = (p.itens || []).slice(0, 8).map(it => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#94a3b8;border-top:1px solid rgba(255,255,255,0.05)">
              <span>${fmtNum(it.quantidade)}x ${escapeHtml(it.descricao||'(sem descricao)')}</span>
              <span>${fmtBRL(it.valor_total || (Number(it.quantidade)||0)*(Number(it.valor_unitario)||0))}</span>
            </div>
          `).join('');
          const mais = (p.itens || []).length > 8 ? `<div style="padding:6px 0;font-size:12px;color:#64748b">+ ${(p.itens||[]).length-8} item(s)...</div>` : '';
          return `
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <div>
                  <span style="font-weight:600;font-size:14px;color:#e2e8f0">Pedido #${escapeHtml(String(p.numero||p.id))}</span>
                  <span style="font-size:12px;color:#64748b;margin-left:10px">${fmtDate(p.data)} · ${escapeHtml(lojaNome(p.loja_id))}${p.vendedor_nome?' · Vend: '+escapeHtml(p.vendedor_nome):''}</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="font-weight:700;font-size:15px;color:#22c55e">${fmtBRL(valor)}</span>
                  <span style="background:${st.bg};color:${st.fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">${st.lbl}</span>
                </div>
              </div>
              ${itensHtml}${mais}
            </div>`;
        }).join('');

    page.innerHTML = `
<div style="padding:24px;max-width:1200px;margin:0 auto">
  <button onclick="showPage('clientes')" style="display:flex;align-items:center;gap:8px;background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;margin-bottom:20px;padding:0;font-family:Inter,sans-serif">
    <svg fill="none" height="16" stroke="currentColor" stroke-width="2" viewbox="0 0 24 24" width="16"><polyline points="15 18 9 12 15 6"></polyline></svg>
    Voltar para Clientes
  </button>

  <!-- Header -->
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:20px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px">
      <div style="display:flex;align-items:center;gap:16px">
        <div style="width:56px;height:56px;border-radius:50%;background:rgba(167,139,250,0.2);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#a78bfa;flex-shrink:0">${escapeHtml(initial)}</div>
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <h2 style="margin:0;font-size:22px;font-weight:700;color:#f1f5f9">${escapeHtml(nome)}</h2>
            <span class="inline-flex items-center rounded-full font-medium text-xs px-2.5 py-1 ${segStyle.bg} ${segStyle.fg} border ${segStyle.border}">${seg}</span>
            <span class="inline-flex items-center rounded-full font-medium text-xs px-2.5 py-1 ${risco.cls} border">Risco: ${risco.label}</span>
          </div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">${fone ? escapeHtml(fone) : '<span style="color:#475569">sem telefone</span>'}${c.uf ? ' · '+c.uf : ''}${doc ? ' · '+escapeHtml(doc) : ''}</div>
          <div style="font-size:12px;color:#64748b">${EMPRESA_LABELS[c.empresa] || c.empresa}${tipo ? ' · '+tipo : ''}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-shrink:0">
        <button onclick="c360Recalcular()" style="padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#e2e8f0;cursor:pointer;font-size:13px;font-weight:500">Recalcular</button>
        <button onclick="c360InsightIA()" style="padding:8px 16px;border-radius:8px;border:1px solid rgba(251,191,36,0.4);background:rgba(251,191,36,0.1);color:#fbbf24;cursor:pointer;font-size:13px;font-weight:500">◆ Insight IA</button>
      </div>
    </div>
  </div>

  <!-- KPI cards -->
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px">
    ${kpiCard('🛒 Total de Pedidos', fmtNum(c.total_pedidos), '')}
    ${kpiCard('$ Total Gasto', fmtBRL(c.total_gasto), '', 18)}
    ${kpiCard('↗ Ticket Médio', fmtBRL(c.ticket_medio), '', 18)}
    ${kpiCard('⏰ Ciclo Médio', cicloMedio, '', 18)}
    ${kpiCard('⏰ Última Compra', fmtDate(c.ultima_compra), 'Há '+fmtNum(c.dias_sem_compra)+' dias', 16)}
    ${kpiCard('↗ Próxima Estimada', proximaEstimada, diasProxima, 16)}
  </div>

  <!-- Scores -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px">
      <h3 style="margin:0 0 16px;font-size:15px;font-weight:600;color:#f1f5f9">Score RFM</h3>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:13px;color:#94a3b8">Score Geral</span>
        <span style="font-size:14px;font-weight:700;color:#f1f5f9">${score}</span>
      </div>
      <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;margin-bottom:20px">
        <div style="height:100%;width:${score}%;background:${barColor};border-radius:3px;transition:width 0.5s"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center">
        <div><div style="font-size:28px;font-weight:700;color:#f1f5f9">${rfm.r}</div><div style="font-size:12px;color:#64748b">Recência</div></div>
        <div><div style="font-size:28px;font-weight:700;color:#f1f5f9">${rfm.f}</div><div style="font-size:12px;color:#64748b">Frequência</div></div>
        <div><div style="font-size:28px;font-weight:700;color:#f1f5f9">${rfm.m}</div><div style="font-size:12px;color:#64748b">Monetário</div></div>
      </div>
    </div>
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px">
      <h3 style="margin:0 0 16px;font-size:15px;font-weight:600;color:#f1f5f9">Score de Recompra</h3>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:13px;color:#94a3b8">Probabilidade de Recompra</span>
        <span style="font-size:14px;font-weight:700;color:#f1f5f9">${pRec}</span>
      </div>
      <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;margin-bottom:20px">
        <div style="height:100%;width:${pRec}%;background:${barRecColor};border-radius:3px;transition:width 0.5s"></div>
      </div>
      <div style="margin-bottom:12px"><span style="color:${barRecColor};font-size:14px;font-weight:600">◆ ${recLabel}</span></div>
      <div style="font-size:13px;color:#94a3b8">
        Categoria preferida: <strong style="color:#e2e8f0">${escapeHtml(fav.categoriaPreferida)}</strong><br/>
        Canal preferido: <strong style="color:#e2e8f0">${escapeHtml(fav.canalPreferido)}</strong>
      </div>
    </div>
  </div>

  <!-- Tabs -->
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden">
    <div style="display:flex;border-bottom:1px solid rgba(255,255,255,0.08)">
      <button id="c360-tab-pedidos" onclick="c360SwitchTab('pedidos')" style="padding:14px 20px;background:transparent;border:none;color:oklch(88% 0.018 80);cursor:pointer;font-size:14px;font-weight:600;border-bottom:2px solid oklch(88% 0.018 80);display:flex;align-items:center;gap:6px">
        🛒 Pedidos <span style="background:rgba(255,255,255,0.1);color:oklch(88% 0.018 80);padding:2px 8px;border-radius:20px;font-size:11px">${fmtNum(pedidos.length)}</span>
      </button>
      <button id="c360-tab-insights" onclick="c360SwitchTab('insights')" style="padding:14px 20px;background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;font-weight:500;border-bottom:2px solid transparent;display:flex;align-items:center;gap:6px">◆ Insights IA</button>
      <button id="c360-tab-notas" onclick="c360SwitchTab('notas')" style="padding:14px 20px;background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;font-weight:500;border-bottom:2px solid transparent;display:flex;align-items:center;gap:6px">💬 Notas</button>
    </div>
    <div id="c360-tabpanel-pedidos" style="padding:16px">${pedidosHtml}</div>
    <div id="c360-tabpanel-insights" style="padding:40px;display:none;text-align:center;color:#64748b">
      <div style="font-size:32px;margin-bottom:8px">◆</div>
      <div style="font-size:14px;margin-bottom:4px;color:#e2e8f0">Insights IA — em breve</div>
      <div style="font-size:12px">Esta aba vai gerar análises automáticas via IA sobre comportamento, oportunidades e recomendações específicas deste cliente. Disponível na Fase 3.</div>
    </div>
    <div id="c360-tabpanel-notas" style="padding:20px;display:none;color:#64748b">
      <div style="text-align:center;padding:20px;color:rgba(255,255,255,0.4)">⏳ Carregando notas...</div>
    </div>
  </div>
</div>`;
  }

  function kpiCard(label, valor, sub, fontSize) {
    const fs = fontSize || 24;
    return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px">
      <div style="font-size:11px;color:#64748b;margin-bottom:8px">${escapeHtml(label)}</div>
      <div style="font-size:${fs}px;font-weight:700;color:#f1f5f9">${escapeHtml(valor)}</div>
      ${sub ? `<div style="font-size:11px;color:#64748b;margin-top:4px">${escapeHtml(sub)}</div>` : ''}
    </div>`;
  }

  // Tabs internos
  window.c360SwitchTab = function(tab) {
    const tabs = ['pedidos','insights','notas'];
    for (const t of tabs) {
      const btn = document.getElementById('c360-tab-'+t);
      const panel = document.getElementById('c360-tabpanel-'+t);
      const ativo = t === tab;
      if (btn) {
        btn.style.color = ativo ? 'oklch(88% 0.018 80)' : '#94a3b8';
        btn.style.fontWeight = ativo ? '600' : '500';
        btn.style.borderBottomColor = ativo ? 'oklch(88% 0.018 80)' : 'transparent';
      }
      if (panel) panel.style.display = ativo ? '' : 'none';
    }
  };

  window.c360Recalcular = function() {
    if (typeof showToast === 'function') showToast('Os scores serão recalculados na próxima sincronização com o Bling', 'info');
  };

  // ─── Insight IA (Fase 3) ───
  // Parser das 3 secoes fixas (ANALISE DO COMPORTAMENTO ATUAL / RISCO / ACAO)
  // Retorna objeto { analise, risco, acao }
  function parseInsightSecoes(md) {
    if (!md) return { analise: '', risco: '', acao: '' };
    const secs = { analise: '', risco: '', acao: '' };
    // Aceita varicoes dos labels (caps ou nao, com/sem dois pontos)
    const re = /(an[aá]lise[^:\n]*comportamento[^:\n]*|risco[^:\n]*oportunidade[^:\n]*|a[cç][aã]o[^:\n]*comercial[^:\n]*)\s*:\s*\n?([\s\S]*?)(?=\n\s*(?:an[aá]lise[^:\n]*comportamento|risco[^:\n]*oportunidade|a[cç][aã]o[^:\n]*comercial)[^:\n]*:|$)/gi;
    let m;
    while ((m = re.exec(md))) {
      const label = m[1].toLowerCase();
      const texto = m[2].trim();
      if (label.includes('compor')) secs.analise = texto;
      else if (label.includes('risc')) secs.risco = texto;
      else if (label.includes('a') && label.includes('o')) secs.acao = texto;
    }
    // Se nao parsear nada, coloca tudo em analise
    if (!secs.analise && !secs.risco && !secs.acao) secs.analise = md;
    return secs;
  }

  function formatTextoInsight(t) {
    if (!t) return '';
    let h = escapeHtml(t);
    // Negrito **texto** → realce em cor champanhe
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:oklch(88% 0.018 80)">$1</strong>');
    // Remove headers markdown (# / ## / ###)
    h = h.replace(/^#{1,6}\s*/gm, '');
    // Topicos com emoji no inicio de linha (ex: "📋 Perfil", "📊 Padrão de Compra", "⚠️ Riscos")
    // Viram sub-headers destacados
    h = h.replace(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0F]?\s+[A-ZÁÉÍÓÚÂÊÎÔÛÀÃÕÇ][\wÀ-ÿ\s]{2,60})\s*$/gmu,
      '<div style="margin:12px 0 4px;font-size:13px;font-weight:700;color:oklch(88% 0.018 80)">$1</div>');
    // Linhas que sao so um rotulo tipo "Perfil:" ou "Risco:" viram sub-headers
    h = h.replace(/^([A-ZÁÉÍÓÚÂÊÎÔÛÀÃÕÇ][\wÀ-ÿ\s]{2,40}):\s*$/gm,
      '<div style="margin:12px 0 4px;font-size:13px;font-weight:700;color:oklch(88% 0.018 80)">$1:</div>');
    // Listas com hifen → bullets estilizados
    h = h.replace(/(?:^|\n)((?:- [^\n]+\n?)+)/g, (m) => {
      const items = m.trim().split(/\n/).map(l => l.replace(/^-\s+/, '').trim()).filter(Boolean);
      return '\n<ul style="margin:6px 0 10px 18px;padding:0;list-style:disc;color:#cbd5e1;font-size:13.5px">' + items.map(i => `<li style="margin-bottom:4px;line-height:1.55">${i}</li>`).join('') + '</ul>\n';
    });
    // Quebras duplas viram paragrafos
    const blocks = h.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    return blocks.map(p => {
      // Se ja é bloco HTML (div/ul), nao embrulha em <p>
      if (p.startsWith('<div') || p.startsWith('<ul') || p.startsWith('<p')) return p;
      return `<p style="margin:0 0 8px;line-height:1.65;color:#cbd5e1;font-size:13.5px">${p.replace(/\n/g,' ')}</p>`;
    }).join('');
  }

  async function c360GenerateInsight(contatoNome) {
    const { data: { session } } = await state.sb.auth.getSession();
    if (!session) throw new Error('Sessão expirada. Relogue.');
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/cliente360-insight`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contato_nome: contatoNome, empresa: state.empresa }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || ('Erro ' + resp.status));
    return j;
  }

  async function c360LoadInsightsHistory(contatoNome) {
    const { data } = await state.sb
      .from('cliente_insights')
      .select('*')
      .eq('empresa', state.empresa)
      .eq('contato_nome', contatoNome)
      .order('created_at', { ascending: false })
      .limit(10);
    return data || [];
  }

  function insightCard(ins, isNewest) {
    const s = parseInsightSecoes(ins.insight || '');
    const data = new Date(ins.created_at);
    const dataStr = data.toLocaleDateString('pt-BR');
    const dataFull = data.toLocaleString('pt-BR');
    const secBlock = (label, conteudo) => conteudo ? `
      <div style="margin-top:16px">
        <div style="font-size:10.5px;font-weight:700;color:oklch(88% 0.018 80);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px">${label}:</div>
        ${formatTextoInsight(conteudo)}
      </div>` : '';
    return `
      <div style="background:rgba(255,255,255,0.02);border:1px solid oklch(88% 0.018 80 / 0.3);border-radius:12px;padding:20px;margin-bottom:14px;position:relative">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            <div style="width:32px;height:32px;border-radius:8px;background:oklch(88% 0.018 80 / 0.15);display:flex;align-items:center;justify-content:center;color:oklch(88% 0.018 80);font-size:16px;flex-shrink:0">◉</div>
            <div style="min-width:0">
              <div style="font-size:15px;font-weight:700;color:oklch(88% 0.018 80);text-align:left">Análise de Comportamento</div>
              <div style="font-size:11px;color:#64748b;margin-top:2px;text-align:left">${ins.modelo || 'IA'} · por ${escapeHtml(ins.user_nome || '—')}${isNewest ? ' · <span style="color:#22c55e;font-weight:600">◉ mais recente</span>' : ''}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span style="font-size:11px;color:#64748b" title="${dataFull}">${dataStr}</span>
            <button onclick="c360DeleteInsight(${ins.id}, this)" title="Apagar insight" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:transparent;color:#ef4444;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center" onmouseover="this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.background='transparent'">🗑</button>
          </div>
        </div>
        ${secBlock('Análise do Comportamento Atual', s.analise)}
        ${secBlock('Risco ou Oportunidade Principal', s.risco)}
        ${secBlock('Ação Comercial Recomendada', s.acao)}
      </div>`;
  }

  function renderInsightsTab(contatoNome, insights, gerando) {
    const panel = document.getElementById('c360-tabpanel-insights');
    if (!panel) return;
    const cards = (insights || []).map((ins, idx) => insightCard(ins, idx === 0)).join('');
    panel.innerHTML = `
      <div style="padding:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:10px">
          <div style="font-size:13px;color:#94a3b8">Análises geradas por IA (Groq Llama 3.3 · fallback Gemini 2.5)</div>
          <button onclick="c360InsightIA()" ${gerando?'disabled':''} style="padding:8px 16px;border-radius:8px;border:1px solid oklch(88% 0.018 80 / 0.5);background:oklch(88% 0.018 80 / 0.12);color:oklch(88% 0.018 80);cursor:${gerando?'not-allowed':'pointer'};font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;opacity:${gerando?0.6:1}">
            ${gerando ? '⏳ Gerando...' : '◆ Gerar novo Insight'}
          </button>
        </div>
        ${insights.length === 0
          ? '<div style="padding:40px;text-align:center;color:#64748b"><div style="font-size:32px;margin-bottom:8px;color:oklch(88% 0.018 80)">◉</div><div style="font-size:14px;margin-bottom:4px;color:#e2e8f0">Nenhum insight gerado ainda</div><div style="font-size:12px">Clique em "Gerar novo Insight" pra criar o primeiro.</div></div>'
          : cards}
      </div>`;
  }

  // ─── Notas por cliente (Fase 4) ───
  // Cache de users mencionáveis (carregado on-demand)
  state.mencionaveis = null; // array de { id, nome, cargo }

  async function loadMencionaveis() {
    if (state.mencionaveis) return state.mencionaveis;
    // Busca cargos que têm permissão cliente360=true
    const { data: perms } = await state.sb
      .from('cargo_permissoes')
      .select('cargo')
      .eq('secao', 'cliente360')
      .eq('permitido', true);
    const cargosAutorizados = new Set((perms || []).map(p => p.cargo));
    cargosAutorizados.add('admin'); // admin sempre pode
    // Busca profiles com esses cargos
    const { data: profiles } = await state.sb
      .from('profiles')
      .select('id, nome, cargo')
      .order('nome');
    state.mencionaveis = (profiles || []).filter(p => cargosAutorizados.has(p.cargo));
    return state.mencionaveis;
  }

  async function loadNotasCliente(contatoNome) {
    const { data, error } = await state.sb
      .from('cliente_notas')
      .select('*')
      .eq('empresa', state.empresa)
      .eq('contato_nome', contatoNome)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) { console.warn('[c360] notas erro:', error); return []; }
    return data || [];
  }

  // Parse texto da nota: marca @Nome substituindo por link estilizado
  function renderTextoNota(texto, mentionsIds) {
    if (!texto) return '';
    let h = escapeHtml(texto);
    // Destaca @Nome (qualquer combinacao de palavras nos mencionaveis)
    const lista = (state.mencionaveis || []);
    for (const m of lista) {
      const nomeEsc = escapeHtml(m.nome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('@' + nomeEsc, 'g');
      h = h.replace(re, `<span style="color:oklch(88% 0.018 80);font-weight:600;background:oklch(88% 0.018 80 / 0.1);padding:1px 4px;border-radius:4px">@${escapeHtml(m.nome)}</span>`);
    }
    // Quebras de linha simples
    return h.replace(/\n/g, '<br>');
  }

  function notaCard(n, currentUserId) {
    const autor = n.user_nome || '—';
    const inicial = (autor.trim()[0] || '?').toUpperCase();
    const quando = new Date(n.created_at);
    const diff = Date.now() - quando.getTime();
    let quandoStr;
    if (diff < 60_000) quandoStr = 'agora';
    else if (diff < 3600_000) quandoStr = Math.floor(diff/60000) + 'min atrás';
    else if (diff < 86400_000) quandoStr = Math.floor(diff/3600000) + 'h atrás';
    else quandoStr = quando.toLocaleString('pt-BR');
    const isOwn = String(n.user_id) === String(currentUserId);
    const isAdmin = state.currentCargo === 'admin';
    const canDelete = isOwn || isAdmin;
    return `
      <div id="nota-${n.id}" style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(167,139,250,0.2);color:#a78bfa;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${escapeHtml(inicial)}</div>
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:600;color:#e2e8f0">${escapeHtml(autor)}</div>
              <div style="font-size:11px;color:#64748b">${quandoStr}${n.updated_at ? ' · editada' : ''}</div>
            </div>
          </div>
          ${(isOwn || isAdmin) ? `
          <div style="display:flex;gap:4px">
            ${isOwn ? `<button onclick="c360EditNota(${n.id})" title="Editar" style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#94a3b8;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center">✏</button>` : ''}
            <button onclick="c360DeleteNota(${n.id})" title="Apagar" style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:transparent;color:#ef4444;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center">🗑</button>
          </div>` : ''}
        </div>
        <div id="nota-texto-${n.id}" style="font-size:13.5px;line-height:1.6;color:#cbd5e1;white-space:pre-wrap;word-break:break-word">${renderTextoNota(n.texto, n.mentions_ids)}</div>
      </div>`;
  }

  // Editar nota
  window.c360EditNota = function(id) {
    const card = document.getElementById('nota-' + id);
    if (!card) return;
    const textoEl = document.getElementById('nota-texto-' + id);
    if (!textoEl) return;
    // Busca o texto original na lista em memória (armazenamos via data-attr)
    // Como não temos cache local, buscamos do DB
    state.sb.from('cliente_notas').select('texto').eq('id', id).single().then(({ data }) => {
      if (!data) return;
      const textoOrig = data.texto || '';
      textoEl.innerHTML = `
        <textarea id="nota-edit-${id}" rows="3" style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:13.5px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box">${escapeHtml(textoOrig)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button onclick="c360SaveEditNota(${id})" style="padding:6px 14px;border-radius:6px;border:1px solid oklch(88% 0.018 80 / 0.5);background:oklch(88% 0.018 80 / 0.12);color:oklch(88% 0.018 80);cursor:pointer;font-size:12.5px;font-weight:600">Salvar</button>
          <button onclick="c360CancelEditNota(${id})" style="padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#94a3b8;cursor:pointer;font-size:12.5px">Cancelar</button>
        </div>`;
      const ta = document.getElementById('nota-edit-' + id);
      if (ta) ta.focus();
    });
  };

  window.c360CancelEditNota = async function(id) {
    // Re-renderiza a aba toda — simples e seguro
    const page = document.getElementById('page-cliente-1');
    const nome = page?.querySelector('h2')?.textContent?.trim();
    if (nome) await renderNotasTab(nome);
  };

  window.c360SaveEditNota = async function(id) {
    const ta = document.getElementById('nota-edit-' + id);
    if (!ta) return;
    const novoTexto = (ta.value || '').trim();
    if (!novoTexto) return;
    const mentions = extractMentions(novoTexto);
    const { error } = await state.sb.from('cliente_notas').update({
      texto: novoTexto,
      mentions_ids: mentions,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) {
      if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error');
      return;
    }
    if (typeof showToast === 'function') showToast('Nota atualizada', 'success');
    // Realtime vai atualizar, mas forçamos aqui também (sem delay)
    const page = document.getElementById('page-cliente-1');
    const nome = page?.querySelector('h2')?.textContent?.trim();
    if (nome) await renderNotasTab(nome);
  };

  async function renderNotasTab(contatoNome) {
    const panel = document.getElementById('c360-tabpanel-notas');
    if (!panel) return;
    const [{ data: { user } }, notas, mencionaveis] = await Promise.all([
      state.sb.auth.getUser(),
      loadNotasCliente(contatoNome),
      loadMencionaveis(),
    ]);
    // Guarda cargo do usuario atual pra controle de delete
    if (user) {
      const { data: p } = await state.sb.from('profiles').select('cargo').eq('id', user.id).maybeSingle();
      state.currentCargo = p?.cargo;
    }
    const currentUserId = user?.id;

    const cards = notas.length === 0
      ? '<div style="padding:30px;text-align:center;color:#64748b"><div style="font-size:28px;margin-bottom:6px">💬</div><div style="font-size:13px;color:#e2e8f0">Nenhuma nota ainda</div><div style="font-size:11.5px;margin-top:2px">Adicione observações, lembretes ou histórico de contato deste cliente.</div></div>'
      : notas.map(n => notaCard(n, currentUserId)).join('');

    panel.innerHTML = `
      <div style="padding:20px">
        <!-- Form de nova nota -->
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;margin-bottom:18px;position:relative">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:rgba(255,255,255,0.5);margin-bottom:8px">Nova nota</div>
          <textarea id="c360-nota-input" placeholder="Escreva uma nota sobre ${escapeHtml(contatoNome)}... Use @nome pra mencionar um colega" rows="3"
            style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:13.5px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box"></textarea>
          <!-- Dropdown de menção (absoluto, aparece ao digitar @) -->
          <div id="c360-mention-dropdown" style="display:none;position:absolute;background:rgb(20,20,25);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px;z-index:100;max-height:180px;overflow-y:auto;min-width:220px;box-shadow:0 8px 24px rgba(0,0,0,0.3)"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:10px">
            <div style="font-size:11px;color:#64748b">Mencionáveis: ${mencionaveis.length} pessoa(s) com acesso ao Cliente 360</div>
            <button onclick="c360SaveNota()" id="c360-btn-nota" style="padding:8px 16px;border-radius:8px;border:1px solid oklch(88% 0.018 80 / 0.5);background:oklch(88% 0.018 80 / 0.12);color:oklch(88% 0.018 80);cursor:pointer;font-size:13px;font-weight:600">💬 Adicionar nota</button>
          </div>
        </div>
        <!-- Lista de notas -->
        <div id="c360-notas-lista">${cards}</div>
      </div>`;

    // Autocomplete @
    wireMentionAutocomplete();
  }

  function wireMentionAutocomplete() {
    const input = document.getElementById('c360-nota-input');
    const drop = document.getElementById('c360-mention-dropdown');
    if (!input || !drop) return;
    let aIdx = -1; // posicao do @ atual

    const close = () => { drop.style.display = 'none'; aIdx = -1; };

    input.addEventListener('input', (e) => {
      const val = input.value;
      const caret = input.selectionStart;
      const before = val.slice(0, caret);
      const atMatch = /(?:^|\s)@([^\s]{0,30})$/.exec(before);
      if (!atMatch) { close(); return; }
      aIdx = caret - atMatch[1].length - 1; // posicao do @
      const query = atMatch[1].toLowerCase();
      const matches = (state.mencionaveis || [])
        .filter(m => m.nome && m.nome.toLowerCase().includes(query))
        .slice(0, 6);
      if (matches.length === 0) { close(); return; }
      drop.innerHTML = matches.map((m, i) => `
        <div class="c360-mention-opt" data-id="${m.id}" data-nome="${escapeHtml(m.nome)}" data-idx="${i}"
          style="padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#e2e8f0;display:flex;align-items:center;gap:8px"
          onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background=''">
          <div style="width:20px;height:20px;border-radius:50%;background:rgba(167,139,250,0.2);color:#a78bfa;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${escapeHtml((m.nome.trim()[0]||'?').toUpperCase())}</div>
          <div><div>${escapeHtml(m.nome)}</div><div style="font-size:10.5px;color:#64748b">${escapeHtml(m.cargo || '')}</div></div>
        </div>
      `).join('');
      drop.style.display = 'block';
      drop.style.left = '14px';
      drop.style.top = (input.offsetTop + input.offsetHeight + 4) + 'px';
    });

    drop.addEventListener('click', (e) => {
      const opt = e.target.closest('.c360-mention-opt');
      if (!opt) return;
      const nome = opt.getAttribute('data-nome');
      const id = opt.getAttribute('data-id');
      if (aIdx < 0) return;
      // Insere @Nome no lugar
      const val = input.value;
      const caret = input.selectionStart;
      const novo = val.slice(0, aIdx) + '@' + nome + ' ' + val.slice(caret);
      input.value = novo;
      input.focus();
      const newCaret = aIdx + nome.length + 2;
      input.setSelectionRange(newCaret, newCaret);
      close();
    });

    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  // Detecta @mencoes no texto e retorna array de user ids
  function extractMentions(texto) {
    const ids = [];
    const lista = state.mencionaveis || [];
    for (const m of lista) {
      const nomeEsc = m.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('@' + nomeEsc + '(?:\\s|$|[^\\w])');
      if (re.test(texto)) ids.push(m.id);
    }
    return ids;
  }

  window.c360SaveNota = async function() {
    const page = document.getElementById('page-cliente-1');
    const nomeEl = page?.querySelector('h2');
    const contatoNome = nomeEl?.textContent?.trim();
    if (!contatoNome) return;
    const input = document.getElementById('c360-nota-input');
    const btn = document.getElementById('c360-btn-nota');
    const texto = (input?.value || '').trim();
    if (!texto) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
    try {
      const { data: { user } } = await state.sb.auth.getUser();
      const { data: profile } = await state.sb.from('profiles').select('nome, cargo').eq('id', user.id).single();
      const mentions = extractMentions(texto);
      const { data: novaNota, error } = await state.sb.from('cliente_notas').insert({
        empresa: state.empresa,
        contato_nome: contatoNome,
        texto,
        mentions_ids: mentions,
        user_id: user.id,
        user_nome: profile?.nome || user.email,
        user_cargo: profile?.cargo,
      }).select().single();
      if (error) throw error;

      // Cria alertas pra cada menção
      if (mentions.length > 0) {
        const alertas = mentions.map(uid => {
          const mUser = (state.mencionaveis || []).find(m => m.id === uid);
          return {
            tipo: 'mencao_nota_cliente',
            nivel: 'info',
            titulo: `${profile?.nome || 'Alguém'} mencionou você`,
            mensagem: `Em nota sobre ${contatoNome}: "${texto.slice(0, 120)}${texto.length > 120 ? '...' : ''}"`,
            destinatario_id: uid,
            destinatario_nome: mUser?.nome || null,
            link_ref: 'cliente360',
            link_label: 'Ver nota',
            audiencia: 'pessoal',
            dados: {
              empresa: state.empresa,
              contato_nome: contatoNome,
              tab: 'notas',
              nota_id: novaNota?.id,
            },
          };
        });
        const { error: alErr } = await state.sb.from('alertas').insert(alertas);
        if (alErr) console.warn('[c360] erro criar alertas:', alErr);
      }

      if (input) input.value = '';
      await renderNotasTab(contatoNome);
      if (typeof showToast === 'function') showToast('Nota adicionada' + (mentions.length ? ` · ${mentions.length} notificação(ões)` : ''), 'success');
    } catch (e) {
      console.error('[c360] erro salvar nota:', e);
      if (typeof showToast === 'function') showToast('Erro: ' + (e.message || e), 'error');
      if (btn) { btn.disabled = false; btn.textContent = '💬 Adicionar nota'; }
    }
  };

  window.c360DeleteNota = async function(id) {
    if (!confirm('Apagar esta nota?')) return;
    const { error } = await state.sb.from('cliente_notas').delete().eq('id', id);
    if (error) {
      if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error');
      return;
    }
    const el = document.getElementById('nota-' + id);
    if (el) el.remove();
    if (typeof showToast === 'function') showToast('Nota apagada', 'success');
  };

  // Abre cliente especifico + aba baseado num spec {empresa, contato_nome, tab, nota_id}
  async function openClienteFromSpec(spec) {
    try {
      if (!spec || !spec.contato_nome) return;
      if (spec.empresa && spec.empresa !== state.empresa && (spec.empresa === 'matriz' || spec.empresa === 'bc')) {
        await window.c360SetEmpresa(spec.empresa);
      }
      await window.showClientDetail(encodeURIComponent(spec.contato_nome));
      if (spec.tab) {
        setTimeout(() => window.c360SwitchTab(spec.tab), 300);
        if (spec.nota_id) {
          setTimeout(() => {
            const el = document.getElementById('nota-' + spec.nota_id);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.style.transition = 'background .3s';
              el.style.background = 'oklch(88% 0.018 80 / 0.12)';
              setTimeout(() => { el.style.background = ''; }, 2000);
            }
          }, 900);
        }
      }
    } catch(e) { console.warn('[c360] openClienteFromSpec:', e); }
  }

  // Deep-link vindo do DMS: sessionStorage (fallback) + postMessage (online)
  async function checkDeepLink() {
    try {
      const raw = sessionStorage.getItem('c360_open_cliente');
      if (!raw) return;
      sessionStorage.removeItem('c360_open_cliente');
      await openClienteFromSpec(JSON.parse(raw));
    } catch(e) { console.warn('[c360] deep-link session:', e); }
  }

  // postMessage do DMS pai - funciona mesmo com iframe ja montado
  window.addEventListener('message', async (e) => {
    if (!e || !e.data || e.data.type !== 'c360_open_cliente') return;
    console.log('[c360] postMessage deep-link:', e.data.spec);
    await openClienteFromSpec(e.data.spec);
  });

  // ─── Realtime: sincroniza notas entre usuarios ───
  function subscribeRealtimeNotas() {
    if (state.notasChannel) return; // ja subscribed
    state.notasChannel = state.sb
      .channel('realtime-cliente-notas')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cliente_notas' }, async (payload) => {
        console.log('[c360] realtime notas:', payload.eventType, payload);
        // Se o cliente atual está aberto e a mudanca eh dele, refresca a aba
        const page = document.getElementById('page-cliente-1');
        const nomeEl = page?.querySelector('h2');
        const nomeAtual = nomeEl?.textContent?.trim();
        if (!nomeAtual) return;
        const row = payload.new || payload.old;
        if (!row) return;
        if (row.empresa !== state.empresa || row.contato_nome !== nomeAtual) return;
        // Reset data-loaded-for pra forcar re-render
        const panel = document.getElementById('c360-tabpanel-notas');
        if (panel) panel.removeAttribute('data-loaded-for');
        // Se a aba Notas esta visivel, re-renderiza na hora
        const tabBtn = document.getElementById('c360-tab-notas');
        const ativa = tabBtn?.style.borderBottomColor && tabBtn.style.borderBottomColor !== 'transparent';
        if (ativa || (panel && panel.style.display !== 'none')) {
          await renderNotasTab(nomeAtual);
        }
      })
      .subscribe();
  }

  // Apagar insight
  window.c360DeleteInsight = async function(id, btn) {
    if (!confirm('Apagar esta análise?')) return;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    const { error } = await state.sb.from('cliente_insights').delete().eq('id', id);
    if (error) {
      if (typeof showToast === 'function') showToast('Erro ao apagar: ' + error.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🗑'; }
      return;
    }
    // Remove o card do DOM
    const card = btn?.closest('div[style*="border-radius:12px"]');
    if (card) card.remove();
    if (typeof showToast === 'function') showToast('Análise apagada', 'success');
  };

  // Botão do header (◆ Insight IA) + aba Insights IA compartilham lógica
  window.c360InsightIA = async function() {
    const page = document.getElementById('page-cliente-1');
    const nomeEl = page?.querySelector('h2');
    const nome = nomeEl?.textContent?.trim();
    if (!nome) return;

    // Muda pra aba insights
    c360SwitchTab('insights');
    const history = await c360LoadInsightsHistory(nome);
    renderInsightsTab(nome, history, true);

    try {
      const result = await c360GenerateInsight(nome);
      if (typeof showToast === 'function') showToast('Insight gerado!', 'success');
      // Reload com o novo insight no topo
      const newHistory = await c360LoadInsightsHistory(nome);
      renderInsightsTab(nome, newHistory, false);
    } catch (e) {
      console.error('[c360] erro insight:', e);
      if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
      renderInsightsTab(nome, history, false);
    }
  };

  // Ao trocar pra aba insights/notas, carrega conteúdo on-demand
  const origSwitchTab = window.c360SwitchTab;
  window.c360SwitchTab = async function(tab) {
    origSwitchTab(tab);
    const page = document.getElementById('page-cliente-1');
    const nomeEl = page?.querySelector('h2');
    const nome = nomeEl?.textContent?.trim();
    if (!nome) return;

    if (tab === 'insights') {
      const panel = document.getElementById('c360-tabpanel-insights');
      if (panel && panel.getAttribute('data-loaded-for') !== nome) {
        panel.setAttribute('data-loaded-for', nome);
        const history = await c360LoadInsightsHistory(nome);
        renderInsightsTab(nome, history, false);
      }
    } else if (tab === 'notas') {
      const panel = document.getElementById('c360-tabpanel-notas');
      if (panel && panel.getAttribute('data-loaded-for') !== nome) {
        panel.setAttribute('data-loaded-for', nome);
        await renderNotasTab(nome);
      }
    }
  };

  // ─── Dashboard principal (Commit 3) ───
  const dashCache = { matriz: null, bc: null };

  async function loadDashboardResumo() {
    try {
      // Cache 5min
      const cached = dashCache[state.empresa];
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        renderDashboard(cached.data);
        return;
      }
      const { data, error } = await state.sb
        .from('cliente_scoring_resumo')
        .select('*')
        .eq('empresa', state.empresa)
        .maybeSingle();
      if (error || !data) {
        console.warn('[c360] dash resumo erro:', error);
        return;
      }
      dashCache[state.empresa] = { data, ts: Date.now() };
      renderDashboard(data);
    } catch (e) { console.error('[c360] dash exception:', e); }
  }

  function renderDashboard(r) {
    const page = document.getElementById('page-dashboard');
    if (!page) return;

    // 4 alertas inteligentes
    const alertCard = (icon, label, sub, n, color, filterFn) => `
      <button type="button" onclick="${filterFn}" style="background:rgba(255,255,255,0.03);border:1px solid ${color};border-radius:12px;padding:16px;text-align:left;cursor:pointer;transition:transform 0.15s;font-family:inherit" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="color:${color.replace('0.4','1').replace('rgba','rgb').replace(/,\d\.?\d*\)/,')')};font-size:16px">${icon}</div>
          <div>
            <div style="font-size:22px;font-weight:700;color:#f1f5f9">${fmtNum(n)}</div>
            <div style="font-size:13px;color:#f1f5f9;font-weight:500">${label}</div>
          </div>
        </div>
        <div style="font-size:11px;color:#64748b">${sub}</div>
      </button>`;

    // 5 métricas principais
    const metricCard = (icon, label, valor, sub, iconColor, fontSize) => {
      const fs = fontSize || 22;
      return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;min-width:0">
        <div style="font-size:13px;color:#94a3b8;display:flex;align-items:center;gap:6px;margin-bottom:10px">
          <span style="color:${iconColor}">${icon}</span> ${label}
        </div>
        <div style="font-size:${fs}px;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums" title="${escapeHtml(String(valor))}">${valor}</div>
        ${sub ? `<div style="font-size:11px;color:#64748b;margin-top:4px">${sub}</div>` : ''}
      </div>`;
    };

    page.innerHTML = `
<div style="padding:24px;max-width:1400px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
    <div>
      <h1 style="margin:0 0 6px;font-size:28px;font-weight:700;color:#f1f5f9;font-family:'Playfair Display',serif">Dashboard</h1>
      <div style="font-size:13px;color:#94a3b8">Visão executiva do relacionamento com clientes — ${EMPRESA_LABELS[state.empresa] || state.empresa}</div>
    </div>
    <button onclick="window.c360ReloadDashboard()" class="c360-reload-btn" style="padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#e2e8f0;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px">🔄 Atualizar</button>
  </div>

  <!-- ALERTAS INTELIGENTES -->
  <div style="margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.5);margin-bottom:12px">◉ Alertas Inteligentes</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
      ${alertCard('↗', 'prontos para recompra', 'Score acima de 80 e sem comprar há 30+ dias', r.prontos_recompra, 'rgba(251,191,36,0.4)', "window.c360FilterAndGo('prontos_recompra')")}
      ${alertCard('◆', 'VIPs sem comprar', 'Clientes VIP há mais de 120 dias', r.vips_sem_comprar, 'rgba(167,139,250,0.4)', "window.c360FilterAndGo('vips_sem_comprar')")}
      ${alertCard('👥', 'novos sem 2ª compra', 'Primeira compra há mais de 30 dias', r.novos_sem_2a, 'rgba(96,165,250,0.4)', "window.c360FilterAndGo('novos_sem_2a')")}
      ${alertCard('🎯', 'com alto potencial', '2+ compras e score acima de 70', r.alto_potencial, 'rgba(34,197,94,0.4)', "window.c360FilterAndGo('alto_potencial')")}
    </div>
  </div>

  <!-- MÉTRICAS PRINCIPAIS -->
  <div style="margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.5);margin-bottom:12px">📈 Métricas Principais</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      ${metricCard('👥', 'Total de Clientes', fmtNum(r.total_clientes), '', '#94a3b8')}
      ${metricCard('✓', 'Clientes Ativos', fmtNum(r.clientes_ativos), 'Excluindo perdidos', '#22c55e')}
      ${metricCard('♔', 'Clientes VIP', fmtNum(r.vip_count), 'Alto valor e recorrência', '#fbbf24')}
      ${metricCard('⚠', 'Em Risco', fmtNum(r.em_risco), 'Passaram do ciclo médio', '#f97316')}
      ${metricCard('✕', 'Perdidos', fmtNum(r.perdidos), 'Sem comprar há muito tempo', '#ef4444')}
    </div>
  </div>

  <!-- MÉTRICAS SECUNDÁRIAS -->
  <div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      ${metricCard('$', 'Faturamento Total', fmtBRL(r.faturamento_total), 'Soma geral da base', '#22c55e', 16)}
      ${metricCard('↗', 'Ticket Médio', fmtBRL(r.ticket_medio_global), 'Média por pedido', '#60a5fa', 18)}
      ${metricCard('⏰', 'Ciclo Médio', Math.round(Number(r.ciclo_medio_aprox)) + ' dias', 'Entre compras (recorrentes)', '#a78bfa', 20)}
      ${metricCard('↻', 'Taxa de Recompra', Number(r.taxa_recompra).toFixed(1) + '%', 'Clientes com 2+ pedidos', '#fbbf24', 20)}
      ${metricCard('★', 'Clientes Fiéis', fmtNum(r.fieis), '5+ pedidos', '#f472b6', 22)}
    </div>
  </div>
</div>`;
  }

  // Clicar num alerta → filtra lista e muda de aba
  window.c360FilterAndGo = function(tipo) {
    // Reset filtros
    state.segmentFilter = 'todos';
    state.ufFilter = 'todos';
    state.searchQuery = '';
    const selSeg = document.getElementById('c360-seg-select');
    const selUf = document.getElementById('c360-uf-select');
    if (selSeg) selSeg.value = 'todos';
    if (selUf) selUf.value = 'todos';
    const searchInp = document.querySelector('#page-clientes input[placeholder*="Buscar"]');
    if (searchInp) searchInp.value = '';

    // Filtra client-side baseado no tipo do alerta
    const filters = {
      prontos_recompra: c => (c.score||0) >= 80 && (c.dias_sem_compra||0) >= 30,
      vips_sem_comprar: c => c.segmento === 'VIP' && (c.dias_sem_compra||0) > 120,
      novos_sem_2a: c => (c.total_pedidos||0) === 1 && (c.dias_sem_compra||0) > 30,
      alto_potencial: c => (c.total_pedidos||0) >= 2 && (c.score||0) >= 70 && (c.dias_sem_compra||0) < 90,
    };
    const filtro = filters[tipo];
    if (!filtro) return;
    state.filtered = state.clientes.filter(filtro);
    state.page = 0;
    if (typeof showPage === 'function') showPage('clientes');
    renderList();
  };

  window.c360ReloadDashboard = async function() {
    dashCache[state.empresa] = null;
    await loadDashboardResumo();
    if (typeof showToast === 'function') showToast('Métricas atualizadas', 'success');
  };

  // ═══════════════════════════════════════════════════════════
  // FASE 5 — SEGMENTAÇÃO (predefinidos + customizados)
  // ═══════════════════════════════════════════════════════════

  // Filtros suportados: tipo_pessoa, ufs[], segmentos[], score_min/max,
  // min/max_pedidos, min/max_gasto, dias_sem_compra_min/max
  function aplicarFiltrosSegmento(clientes, filtros) {
    return clientes.filter(c => {
      if (filtros.tipo_pessoa && filtros.tipo_pessoa !== 'todos' && c.tipo_pessoa !== filtros.tipo_pessoa) return false;
      if (filtros.ufs && filtros.ufs.length > 0) {
        if (!c.uf || !filtros.ufs.includes(c.uf)) return false;
      }
      if (filtros.segmentos && filtros.segmentos.length > 0) {
        if (!filtros.segmentos.includes(c.segmento)) return false;
      }
      const p = Number(c.total_pedidos) || 0;
      const g = Number(c.total_gasto) || 0;
      const d = Number(c.dias_sem_compra) || 0;
      const s = Number(c.score) || 0;
      if (filtros.min_pedidos != null && p < filtros.min_pedidos) return false;
      if (filtros.max_pedidos != null && p > filtros.max_pedidos) return false;
      if (filtros.min_gasto != null && g < filtros.min_gasto) return false;
      if (filtros.max_gasto != null && g > filtros.max_gasto) return false;
      if (filtros.dias_sem_compra_min != null && d < filtros.dias_sem_compra_min) return false;
      if (filtros.dias_sem_compra_max != null && d > filtros.dias_sem_compra_max) return false;
      if (filtros.score_min != null && s < filtros.score_min) return false;
      if (filtros.score_max != null && s > filtros.score_max) return false;
      return true;
    });
  }

  function resumoFiltros(filtros) {
    const partes = [];
    if (filtros.tipo_pessoa === 'J') partes.push('PJ');
    if (filtros.tipo_pessoa === 'F') partes.push('PF');
    if (filtros.ufs && filtros.ufs.length) partes.push('UF: ' + filtros.ufs.join(','));
    if (filtros.segmentos && filtros.segmentos.length) partes.push(filtros.segmentos.join('/'));
    if (filtros.min_pedidos != null) partes.push(filtros.min_pedidos + '+ pedidos');
    if (filtros.max_pedidos != null) partes.push('até ' + filtros.max_pedidos + ' pedidos');
    if (filtros.min_gasto != null) partes.push('gasto ≥ ' + fmtBRL(filtros.min_gasto));
    if (filtros.max_gasto != null) partes.push('gasto ≤ ' + fmtBRL(filtros.max_gasto));
    if (filtros.dias_sem_compra_min != null || filtros.dias_sem_compra_max != null) {
      const lo = filtros.dias_sem_compra_min ?? 0;
      const hi = filtros.dias_sem_compra_max ?? '∞';
      partes.push(lo + '-' + hi + 'd sem comprar');
    }
    if (filtros.score_min != null || filtros.score_max != null) {
      const lo = filtros.score_min ?? 0;
      const hi = filtros.score_max ?? 100;
      partes.push('score ' + lo + '-' + hi);
    }
    return partes.join(' · ') || 'Sem filtros';
  }

  async function loadSegmentosCustom() {
    const { data, error } = await state.sb
      .from('cliente_segmentos_custom')
      .select('*')
      .in('empresa', [state.empresa, 'ambas'])
      .order('created_at', { ascending: false });
    if (error) { console.warn('[c360] segmentos:', error); return []; }
    return data || [];
  }

  async function renderSegmentosPage() {
    const page = document.getElementById('page-segmentos');
    if (!page) return;
    page.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.5)">⏳ Carregando segmentos...</div>';

    const segmentosBase = [
      { key: 'VIP', label: 'VIP', cor: '#fbbf24', desc: 'Alto valor e recorrência' },
      { key: 'Frequente', label: 'Frequente', cor: '#a78bfa', desc: 'Compra com regularidade' },
      { key: 'Ocasional', label: 'Ocasional', cor: '#60a5fa', desc: 'Compra esporádica' },
      { key: 'Em Risco', label: 'Em Risco', cor: '#f97316', desc: 'Passou do ciclo médio' },
      { key: 'Inativo', label: 'Inativo', cor: '#ef4444', desc: 'Sem comprar há muito tempo' },
    ];
    // Conta por segmento na empresa atual
    const contagens = {};
    for (const c of state.clientes) {
      contagens[c.segmento] = (contagens[c.segmento] || 0) + 1;
    }
    const customs = await loadSegmentosCustom();

    const cardBase = (s) => `
      <button type="button" onclick="c360FilterAndGo('segmento:${s.key}')" style="background:rgba(255,255,255,0.03);border:1px solid ${s.cor}44;border-radius:12px;padding:18px;text-align:left;cursor:pointer;transition:transform 0.15s;font-family:inherit" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${s.cor}22;color:${s.cor}">${s.label}</span>
          <span style="font-size:24px;font-weight:700;color:#f1f5f9">${fmtNum(contagens[s.key] || 0)}</span>
        </div>
        <div style="font-size:12px;color:#94a3b8">${s.desc}</div>
      </button>`;

    const cardCustom = (s) => {
      const matches = aplicarFiltrosSegmento(state.clientes, s.filtros || {});
      return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid ${s.cor}44;border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="min-width:0;flex:1">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.cor}"></span>
              <span style="font-size:14px;font-weight:700;color:#f1f5f9">${escapeHtml(s.nome)}</span>
            </div>
            ${s.descricao ? `<div style="font-size:11.5px;color:#94a3b8;margin-top:4px">${escapeHtml(s.descricao)}</div>` : ''}
            <div style="font-size:10.5px;color:#64748b;margin-top:4px">${escapeHtml(resumoFiltros(s.filtros || {}))}</div>
          </div>
          <div style="font-size:22px;font-weight:700;color:#f1f5f9;text-align:right">${fmtNum(matches.length)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="c360ApplySegmentoCustom(${s.id})" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:12px">Ver clientes</button>
          <button onclick="c360ExportCsv(${s.id})" title="Exportar CSV" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:12px">⬇ CSV</button>
          <button onclick="c360EditSegmento(${s.id})" title="Editar" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:12px">✏</button>
          <button onclick="c360DeleteSegmento(${s.id})" title="Apagar" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:transparent;color:#ef4444;cursor:pointer;font-size:12px">🗑</button>
        </div>
      </div>`;
    };

    page.innerHTML = `
<div style="padding:24px;max-width:1400px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <div>
      <h1 style="margin:0 0 6px;font-size:28px;font-weight:700;color:#f1f5f9;font-family:'Playfair Display',serif">Segmentação</h1>
      <div style="font-size:13px;color:#94a3b8">Segmentos automáticos + filtros customizados — ${EMPRESA_LABELS[state.empresa] || state.empresa}</div>
    </div>
    <button onclick="c360NewSegmento()" style="padding:10px 18px;border-radius:8px;border:1px solid oklch(88% 0.018 80 / 0.5);background:oklch(88% 0.018 80 / 0.12);color:oklch(88% 0.018 80);cursor:pointer;font-size:13px;font-weight:600">+ Novo Segmento</button>
  </div>

  <div style="margin-bottom:32px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.5);margin-bottom:12px">Segmentos Automáticos (RFM)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
      ${segmentosBase.map(cardBase).join('')}
    </div>
  </div>

  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.5)">Meus Segmentos Customizados (${customs.length})</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">
      ${customs.length === 0
        ? '<div style="grid-column:1/-1;padding:40px;text-align:center;color:#64748b;background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.1);border-radius:12px"><div style="font-size:24px;margin-bottom:8px">🎯</div><div style="font-size:13px;color:#e2e8f0">Nenhum segmento customizado</div><div style="font-size:11.5px;margin-top:4px">Clique em "+ Novo Segmento" pra criar filtros personalizados.</div></div>'
        : customs.map(cardCustom).join('')}
    </div>
  </div>
</div>`;

    // Armazena no state pra acesso por c360ApplySegmentoCustom/Export
    state.segmentosCustom = customs;
  }

  // Filtra a lista por segmento (predefinido ou customizado)
  window.c360ApplySegmentoCustom = function(id) {
    const s = (state.segmentosCustom || []).find(x => x.id === id);
    if (!s) return;
    // Reset filtros da lista
    state.segmentFilter = 'todos';
    state.ufFilter = 'todos';
    state.searchQuery = '';
    const selSeg = document.getElementById('c360-seg-select');
    const selUf = document.getElementById('c360-uf-select');
    if (selSeg) selSeg.value = 'todos';
    if (selUf) selUf.value = 'todos';
    const searchInp = document.querySelector('#page-clientes input[placeholder*="Buscar"]');
    if (searchInp) searchInp.value = '';
    // Aplica filtro manual
    state.filtered = aplicarFiltrosSegmento(state.clientes, s.filtros || {});
    state.page = 0;
    if (typeof showPage === 'function') showPage('clientes');
    renderList();
    if (typeof showToast === 'function') showToast(`Filtro '${s.nome}' aplicado: ${state.filtered.length} cliente(s)`, 'info');
  };

  // Estende o c360FilterAndGo pra aceitar 'segmento:VIP' etc
  const origFilterAndGo = window.c360FilterAndGo;
  window.c360FilterAndGo = function(tipo) {
    if (typeof tipo === 'string' && tipo.startsWith('segmento:')) {
      const seg = tipo.split(':')[1];
      state.segmentFilter = seg;
      state.ufFilter = 'todos';
      state.searchQuery = '';
      const selSeg = document.getElementById('c360-seg-select');
      if (selSeg) selSeg.value = seg;
      const selUf = document.getElementById('c360-uf-select');
      if (selUf) selUf.value = 'todos';
      const searchInp = document.querySelector('#page-clientes input[placeholder*="Buscar"]');
      if (searchInp) searchInp.value = '';
      applyFilters();
      if (typeof showPage === 'function') showPage('clientes');
      return;
    }
    return origFilterAndGo(tipo);
  };

  // Exportar CSV
  window.c360ExportCsv = function(id) {
    let clientes, nomeArq;
    if (id === '_all') { clientes = state.filtered; nomeArq = 'clientes_filtrados.csv'; }
    else {
      const s = (state.segmentosCustom || []).find(x => x.id === id);
      if (!s) return;
      clientes = aplicarFiltrosSegmento(state.clientes, s.filtros || {});
      nomeArq = 'segmento_' + s.nome.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.csv';
    }
    const header = ['Nome','Empresa','Tipo','Documento','Telefone','Celular','UF','Segmento','Score','Pedidos','Total Gasto','Ticket Medio','Ultima Compra','Dias Sem Compra'];
    const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    const linhas = [header.join(';')];
    for (const c of clientes) {
      linhas.push([
        esc(c.contato_nome), esc(c.empresa), esc(c.tipo_pessoa), esc(c.numero_documento),
        esc(c.telefone), esc(c.celular), esc(c.uf), esc(c.segmento), esc(c.score),
        esc(c.total_pedidos), esc(Number(c.total_gasto).toFixed(2).replace('.',',')),
        esc(Number(c.ticket_medio).toFixed(2).replace('.',',')),
        esc(c.ultima_compra), esc(c.dias_sem_compra)
      ].join(';'));
    }
    // BOM pra Excel reconhecer UTF-8
    const blob = new Blob(['\uFEFF' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nomeArq; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (typeof showToast === 'function') showToast(`CSV com ${clientes.length} cliente(s) baixado`, 'success');
  };

  // ─── Modal: criar/editar segmento ───
  window.c360NewSegmento = function() { abrirModalSegmento(null); };
  window.c360EditSegmento = function(id) {
    const s = (state.segmentosCustom || []).find(x => x.id === id);
    if (s) abrirModalSegmento(s);
  };

  function abrirModalSegmento(segExistente) {
    // Remove modal anterior se houver
    const old = document.getElementById('c360-seg-modal'); if (old) old.remove();
    const f = (segExistente?.filtros) || {};
    const ufs = [...new Set(state.clientes.map(c => c.uf).filter(Boolean))].sort();
    const wrap = document.createElement('div');
    wrap.id = 'c360-seg-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;overflow-y:auto';
    wrap.innerHTML = `
      <div style="background:rgb(18,18,23);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;max-width:600px;width:100%;max-height:90vh;overflow-y:auto;color:#e2e8f0;font-family:Inter,sans-serif">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <h2 style="margin:0;font-size:18px;font-weight:700">${segExistente ? 'Editar' : 'Novo'} Segmento</h2>
          <button onclick="document.getElementById('c360-seg-modal').remove()" style="width:30px;height:30px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:16px">×</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Nome *</label>
            <input id="seg-nome" value="${escapeHtml(segExistente?.nome || '')}" placeholder="Ex: PJ de SC com 3+ pedidos"
              style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:13px;margin-top:4px;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Descrição (opcional)</label>
            <input id="seg-desc" value="${escapeHtml(segExistente?.descricao || '')}" placeholder="Ex: Clinicas fieis"
              style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:13px;margin-top:4px;box-sizing:border-box">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Empresa</label>
              <select id="seg-empresa" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgb(20,20,25);color:#e2e8f0;font-size:13px;margin-top:4px;color-scheme:dark;box-sizing:border-box">
                <option value="ambas" ${(segExistente?.empresa||'ambas')==='ambas'?'selected':''}>Matriz + BC</option>
                <option value="matriz" ${segExistente?.empresa==='matriz'?'selected':''}>Apenas Matriz</option>
                <option value="bc" ${segExistente?.empresa==='bc'?'selected':''}>Apenas BC</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Cor</label>
              <input type="color" id="seg-cor" value="${segExistente?.cor || '#60a5fa'}" style="width:100%;height:38px;padding:2px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);margin-top:4px;box-sizing:border-box;cursor:pointer">
            </div>
          </div>

          <div style="padding:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px">
            <div style="font-size:11px;font-weight:700;color:oklch(88% 0.018 80);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">Filtros</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;color:#94a3b8">Tipo de Pessoa</label>
                <select id="f-tipo" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgb(20,20,25);color:#e2e8f0;font-size:12.5px;margin-top:2px;color-scheme:dark;box-sizing:border-box">
                  <option value="todos" ${!f.tipo_pessoa||f.tipo_pessoa==='todos'?'selected':''}>Todos</option>
                  <option value="J" ${f.tipo_pessoa==='J'?'selected':''}>Pessoa Jurídica</option>
                  <option value="F" ${f.tipo_pessoa==='F'?'selected':''}>Pessoa Física</option>
                </select>
              </div>
              <div style="grid-column:1/-1">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                  <label style="font-size:11px;color:#94a3b8">Estados (UF)</label>
                  <div style="display:flex;gap:6px">
                    <button type="button" onclick="c360UfToggleAll(true)" style="padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#94a3b8;cursor:pointer;font-size:10.5px">Todos</button>
                    <button type="button" onclick="c360UfToggleAll(false)" style="padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#94a3b8;cursor:pointer;font-size:10.5px">Limpar</button>
                  </div>
                </div>
                <div id="f-ufs-chips" style="display:flex;flex-wrap:wrap;gap:5px;max-height:120px;overflow-y:auto;padding:6px;border:1px solid rgba(255,255,255,0.1);border-radius:6px;background:rgba(255,255,255,0.02)">
                  ${ufs.map(u => {
                    const count = state.clientes.filter(c => c.uf === u).length;
                    const sel = (f.ufs||[]).includes(u);
                    return `<button type="button" data-uf="${u}" data-sel="${sel?'1':'0'}" onclick="c360UfToggle('${u}', this)" style="padding:4px 9px;border-radius:6px;border:1px solid ${sel?'oklch(88% 0.018 80 / 0.6)':'rgba(255,255,255,0.1)'};background:${sel?'oklch(88% 0.018 80 / 0.15)':'rgba(255,255,255,0.03)'};color:${sel?'oklch(88% 0.018 80)':'#cbd5e1'};cursor:pointer;font-size:11.5px;font-weight:${sel?'600':'500'};transition:all 0.15s">${u} <span style="opacity:0.6;font-size:10px">${count}</span></button>`;
                  }).join('')}
                  ${ufs.length === 0 ? '<div style="padding:10px;color:#64748b;font-size:11.5px">Nenhum UF detectado nesta empresa.</div>' : ''}
                </div>
                <div id="f-ufs-count" style="font-size:10.5px;color:#64748b;margin-top:4px">${(f.ufs||[]).length > 0 ? (f.ufs||[]).length + ' UF(s) selecionado(s)' : 'Todos os estados'}</div>
              </div>
              <div style="grid-column:1/-1">
                <label style="font-size:11px;color:#94a3b8">Segmentos RFM (múltiplo)</label>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px" id="f-segs">
                  ${['VIP','Frequente','Ocasional','Em Risco','Inativo','Novo'].map(s => `
                    <label style="padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px">
                      <input type="checkbox" value="${s}" ${(f.segmentos||[]).includes(s)?'checked':''} style="margin:0;cursor:pointer">${s}
                    </label>`).join('')}
                </div>
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Pedidos mínimo</label>
                <input type="number" id="f-min-ped" value="${f.min_pedidos ?? ''}" placeholder="ex: 3" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Pedidos máximo</label>
                <input type="number" id="f-max-ped" value="${f.max_pedidos ?? ''}" placeholder="sem limite" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Gasto mínimo (R$)</label>
                <input type="number" id="f-min-gasto" value="${f.min_gasto ?? ''}" placeholder="ex: 1000" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Gasto máximo (R$)</label>
                <input type="number" id="f-max-gasto" value="${f.max_gasto ?? ''}" placeholder="sem limite" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Dias sem comprar — mín</label>
                <input type="number" id="f-d-min" value="${f.dias_sem_compra_min ?? ''}" placeholder="ex: 60" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Dias sem comprar — máx</label>
                <input type="number" id="f-d-max" value="${f.dias_sem_compra_max ?? ''}" placeholder="ex: 120" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Score mínimo (0-100)</label>
                <input type="number" id="f-score-min" min="0" max="100" value="${f.score_min ?? ''}" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
              <div>
                <label style="font-size:11px;color:#94a3b8">Score máximo (0-100)</label>
                <input type="number" id="f-score-max" min="0" max="100" value="${f.score_max ?? ''}" style="width:100%;padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.02);color:#e2e8f0;font-size:12.5px;margin-top:2px;box-sizing:border-box">
              </div>
            </div>
            <div style="margin-top:12px;padding:10px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.18);border-radius:6px;font-size:12px;color:#cbd5e1">
              <strong style="color:oklch(88% 0.018 80)">Preview:</strong> <span id="seg-preview-count">-</span> cliente(s) correspondem a esses filtros
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px">
            <button onclick="document.getElementById('c360-seg-modal').remove()" style="padding:9px 18px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#94a3b8;cursor:pointer;font-size:13px">Cancelar</button>
            <button onclick="c360SaveSegmento(${segExistente?.id || 'null'})" style="padding:9px 18px;border-radius:8px;border:1px solid oklch(88% 0.018 80 / 0.5);background:oklch(88% 0.018 80 / 0.12);color:oklch(88% 0.018 80);cursor:pointer;font-size:13px;font-weight:600">${segExistente?'Salvar alterações':'Criar segmento'}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    // Preview de contagem (atualiza ao alterar qualquer campo)
    const fields = ['f-tipo','f-min-ped','f-max-ped','f-min-gasto','f-max-gasto','f-d-min','f-d-max','f-score-min','f-score-max','f-ufs'];
    const updatePreview = () => {
      const filtros = coletarFiltrosModal();
      const n = aplicarFiltrosSegmento(state.clientes, filtros).length;
      const el = document.getElementById('seg-preview-count');
      if (el) el.textContent = fmtNum(n);
    };
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updatePreview);
      if (el) el.addEventListener('input', updatePreview);
    });
    document.querySelectorAll('#f-segs input').forEach(i => i.addEventListener('change', updatePreview));
    setTimeout(updatePreview, 30);
  }

  // Toggle individual de UF via chip
  window.c360UfToggle = function(uf, btn) {
    const selecionado = btn.getAttribute('data-sel') === '1';
    const novoEstado = !selecionado;
    btn.setAttribute('data-sel', novoEstado ? '1' : '0');
    btn.style.border = '1px solid ' + (novoEstado ? 'oklch(88% 0.018 80 / 0.6)' : 'rgba(255,255,255,0.1)');
    btn.style.background = novoEstado ? 'oklch(88% 0.018 80 / 0.15)' : 'rgba(255,255,255,0.03)';
    btn.style.color = novoEstado ? 'oklch(88% 0.018 80)' : '#cbd5e1';
    btn.style.fontWeight = novoEstado ? '600' : '500';
    c360UpdateUfPreview();
  };

  // Toggle todos os UFs
  window.c360UfToggleAll = function(valor) {
    document.querySelectorAll('#f-ufs-chips button[data-uf]').forEach(btn => {
      btn.setAttribute('data-sel', valor ? '1' : '0');
      btn.style.border = '1px solid ' + (valor ? 'oklch(88% 0.018 80 / 0.6)' : 'rgba(255,255,255,0.1)');
      btn.style.background = valor ? 'oklch(88% 0.018 80 / 0.15)' : 'rgba(255,255,255,0.03)';
      btn.style.color = valor ? 'oklch(88% 0.018 80)' : '#cbd5e1';
      btn.style.fontWeight = valor ? '600' : '500';
    });
    c360UpdateUfPreview();
  };

  function c360UpdateUfPreview() {
    const sel = [...document.querySelectorAll('#f-ufs-chips button[data-sel="1"]')].length;
    const total = [...document.querySelectorAll('#f-ufs-chips button[data-uf]')].length;
    const el = document.getElementById('f-ufs-count');
    if (el) el.textContent = sel === 0 ? 'Todos os estados' : `${sel} de ${total} UF(s) selecionado(s)`;
    // Dispara preview de count do segmento
    const modal = document.getElementById('c360-seg-modal');
    if (modal) {
      const filtros = coletarFiltrosModal();
      const n = aplicarFiltrosSegmento(state.clientes, filtros).length;
      const prev = document.getElementById('seg-preview-count');
      if (prev) prev.textContent = fmtNum(n);
    }
  }

  function coletarFiltrosModal() {
    const tp = document.getElementById('f-tipo')?.value;
    // UFs: coleta dos chips selecionados (data-sel="1")
    const ufs = [...document.querySelectorAll('#f-ufs-chips button[data-sel="1"]')]
      .map(b => b.getAttribute('data-uf'));
    const segs = [...document.querySelectorAll('#f-segs input:checked')].map(i => i.value);
    const num = (id) => {
      const v = document.getElementById(id)?.value;
      return v === '' || v == null ? null : Number(v);
    };
    return {
      tipo_pessoa: tp === 'todos' ? null : tp,
      ufs: ufs.length ? ufs : null,
      segmentos: segs.length ? segs : null,
      min_pedidos: num('f-min-ped'),
      max_pedidos: num('f-max-ped'),
      min_gasto: num('f-min-gasto'),
      max_gasto: num('f-max-gasto'),
      dias_sem_compra_min: num('f-d-min'),
      dias_sem_compra_max: num('f-d-max'),
      score_min: num('f-score-min'),
      score_max: num('f-score-max'),
    };
  }

  window.c360SaveSegmento = async function(idStr) {
    const id = idStr === 'null' ? null : Number(idStr);
    const nome = (document.getElementById('seg-nome')?.value || '').trim();
    if (!nome) { if (typeof showToast === 'function') showToast('Nome é obrigatório', 'error'); return; }
    const descricao = (document.getElementById('seg-desc')?.value || '').trim();
    const empresa = document.getElementById('seg-empresa')?.value || 'ambas';
    const cor = document.getElementById('seg-cor')?.value || '#60a5fa';
    const filtros = coletarFiltrosModal();
    try {
      if (id) {
        const { error } = await state.sb.from('cliente_segmentos_custom').update({
          nome, descricao, empresa, cor, filtros, updated_at: new Date().toISOString()
        }).eq('id', id);
        if (error) throw error;
      } else {
        const { data: { user } } = await state.sb.auth.getUser();
        const { data: profile } = await state.sb.from('profiles').select('nome').eq('id', user.id).single();
        const { error } = await state.sb.from('cliente_segmentos_custom').insert({
          nome, descricao, empresa, cor, filtros,
          user_id: user.id, user_nome: profile?.nome || user.email,
        });
        if (error) throw error;
      }
      document.getElementById('c360-seg-modal')?.remove();
      if (typeof showToast === 'function') showToast('Segmento ' + (id ? 'atualizado' : 'criado'), 'success');
      await renderSegmentosPage();
    } catch (e) {
      if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
    }
  };

  window.c360DeleteSegmento = async function(id) {
    if (!confirm('Apagar este segmento?')) return;
    const { error } = await state.sb.from('cliente_segmentos_custom').delete().eq('id', id);
    if (error) {
      if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error');
      return;
    }
    if (typeof showToast === 'function') showToast('Segmento apagado', 'success');
    await renderSegmentosPage();
  };

  // Realtime pra segmentos (sincroniza criacao/edicao entre users)
  function subscribeRealtimeSegmentos() {
    if (state.segmentosChannel) return;
    state.segmentosChannel = state.sb
      .channel('realtime-cliente-segmentos')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cliente_segmentos_custom' }, async () => {
        // So re-renderiza se a aba atual é segmentos
        const active = document.querySelector('.page-section.active');
        if (active?.id === 'page-segmentos') await renderSegmentosPage();
      })
      .subscribe();
  }

  // Hook: quando showPage('segmentos') for chamado, renderiza dados reais
  const origShowPage = window.showPage;
  if (typeof origShowPage === 'function') {
    window.showPage = function(id) {
      origShowPage(id);
      if (id === 'segmentos') renderSegmentosPage();
      if (id === 'campanhas') renderCampanhasPage();
    };
  }

  // Expoe helper pra c360SetEmpresa poder chamar
  window.c360ReRenderSegmentosIfActive = async function() {
    const active = document.querySelector('.page-section.active');
    if (active?.id === 'page-segmentos') await renderSegmentosPage();
  };

  // ══════════════════════════════════════════════════════════
  // CAMPANHAS (Fase 6) · listagem, modal, envios, PDF/CSV
  // ══════════════════════════════════════════════════════════

  // CSS-fix pra options do <select> no Chrome/Windows
  // (sem isso, o dropdown nativo abre com fundo branco)
  function ensureCampanhasCSS() {
    if (document.getElementById('c360-campanhas-css')) return;
    const s = document.createElement('style');
    s.id = 'c360-campanhas-css';
    s.textContent = `
      #c360-camp-modal select option,
      #c360-envios-modal select option,
      #c360-camp-modal select optgroup,
      #c360-envios-modal select optgroup {
        background: #0b0f17 !important;
        color: #f1f5f9 !important;
      }
      #c360-camp-modal select optgroup,
      #c360-envios-modal select optgroup {
        color: #94a3b8 !important;
        font-weight: 700 !important;
        font-style: normal !important;
      }
    `;
    document.head.appendChild(s);
  }

  // Confirm/alert customizado em tema dark (substitui confirm() nativo feio)
  function c360Confirm(message, opts) {
    opts = opts || {};
    const danger = opts.danger === true;
    const btnOk = opts.okLabel || (danger ? 'Apagar' : 'Confirmar');
    const btnCancel = opts.cancelLabel || 'Cancelar';
    return new Promise(resolve => {
      document.getElementById('c360-confirm-modal')?.remove();
      const html = `
      <div id="c360-confirm-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,sans-serif">
        <div style="background:#0b0f17;border:1px solid rgba(255,255,255,0.12);border-radius:12px;max-width:440px;width:100%;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.5)">
          <div style="padding:22px 24px 18px">
            <div style="font-size:14px;color:#e2e8f0;line-height:1.55;white-space:pre-wrap">${escapeHtml(message)}</div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02)">
            <button id="c360-conf-no" style="padding:8px 18px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#e2e8f0;cursor:pointer;font-size:13px;font-family:inherit">${escapeHtml(btnCancel)}</button>
            <button id="c360-conf-yes" style="padding:8px 22px;border-radius:6px;border:none;background:${danger ? '#ef4444' : 'oklch(88% 0.018 80)'};color:${danger ? '#fff' : 'oklch(9% 0.008 260)'};cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">${escapeHtml(btnOk)}</button>
          </div>
        </div>
      </div>`;
      const div = document.createElement('div');
      div.innerHTML = html;
      document.body.appendChild(div.firstElementChild);
      const cleanup = (v) => {
        window.removeEventListener('keydown', escHandler);
        document.getElementById('c360-confirm-modal')?.remove();
        resolve(v);
      };
      const escHandler = (e) => {
        if (e.key === 'Escape') cleanup(false);
        else if (e.key === 'Enter') cleanup(true);
      };
      window.addEventListener('keydown', escHandler);
      document.getElementById('c360-conf-yes').onclick = () => cleanup(true);
      document.getElementById('c360-conf-no').onclick = () => cleanup(false);
      // Foco no botao confirmar pra Enter funcionar
      setTimeout(() => document.getElementById('c360-conf-yes')?.focus(), 50);
    });
  }

  const CANAL_LABELS = { whatsapp:'WhatsApp', email:'Email', sms:'SMS', outro:'Outro' };
  const STATUS_CAMP_LABELS = { rascunho:'Rascunho', agendada:'Agendada', enviada:'Enviada', concluida:'Concluída', cancelada:'Cancelada' };
  const STATUS_CAMP_CORES = { rascunho:'#94a3b8', agendada:'#60a5fa', enviada:'#a78bfa', concluida:'#10b981', cancelada:'#ef4444' };
  const STATUS_ENVIO_LABELS = { pendente:'Pendente', enviado:'Enviado', entregue:'Entregue', lido:'Lido', respondido:'Respondido', falhou:'Falhou' };
  const STATUS_ENVIO_CORES = { pendente:'#94a3b8', enviado:'#60a5fa', entregue:'#a78bfa', lido:'#c084fc', respondido:'#10b981', falhou:'#ef4444' };

  state.campanhas = [];
  state.canaisAquisicao = [];
  state.campanhasChannel = null;

  async function loadCanaisAquisicao() {
    const { data, error } = await state.sb
      .from('canais_aquisicao').select('id,nome,tipo,status')
      .eq('status','ativo').order('nome');
    if (error) { console.warn('[c360 camp] canais:', error); return []; }
    state.canaisAquisicao = data || [];
    return state.canaisAquisicao;
  }

  async function loadCampanhas() {
    const { data, error } = await state.sb
      .from('cliente_campanhas').select('*')
      .in('empresa', [state.empresa, 'ambas'])
      .order('created_at', { ascending: false });
    if (error) { console.warn('[c360 camp] load:', error); return []; }
    state.campanhas = data || [];
    return state.campanhas;
  }

  function renderMensagemComPlaceholders(template, cliente, campanha) {
    const nome = String(cliente?.contato_nome || '').trim();
    const primeiro = nome.split(/\s+/)[0] || nome;
    const cupom = String(campanha?.cupom_codigo || '').trim();
    const link  = String(campanha?.link_cta || '').trim();
    const cidade = String(cliente?.cidade || '').trim();
    const uf = String(cliente?.uf || '').trim();
    return String(template || '')
      .replace(/\{\{\s*nome\s*\}\}/gi, nome)
      .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, primeiro)
      .replace(/\{\{\s*cupom\s*\}\}/gi, cupom)
      .replace(/\{\{\s*link\s*\}\}/gi, link)
      .replace(/\{\{\s*cidade\s*\}\}/gi, cidade)
      .replace(/\{\{\s*uf\s*\}\}/gi, uf);
  }

  function getClientesAlvoCampanha(campanha) {
    if (!campanha) return [];
    if (campanha.segmento_tipo === 'custom' && campanha.segmento_id) {
      const seg = (state.segmentosCustom || []).find(s => String(s.id) === String(campanha.segmento_id));
      if (!seg) return [];
      return aplicarFiltrosSegmento(state.clientes, seg.filtros || {});
    }
    const alvo = String(campanha.segmento_nome_cache || '').trim();
    if (!alvo || alvo === 'todos') return state.clientes.slice();
    return state.clientes.filter(c => c.segmento === alvo);
  }

  async function renderCampanhasPage() {
    const page = document.getElementById('page-campanhas');
    if (!page) return;
    page.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.5)">⏳ Carregando campanhas...</div>';

    await Promise.all([
      loadCampanhas(),
      loadSegmentosCustom().then(r => { state.segmentosCustom = r; }),
      loadCanaisAquisicao(),
    ]);

    const canalEmoji = { whatsapp:'💬', email:'✉️', sms:'📱', outro:'📤' };

    const cardCampanha = (c) => {
      const corStatus = STATUS_CAMP_CORES[c.status] || '#94a3b8';
      const pct = c.total_alvo > 0 ? Math.round((c.total_enviados / c.total_alvo) * 100) : 0;
      const dataStr = c.data_envio ? new Date(c.data_envio).toLocaleDateString('pt-BR') : '—';
      return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid ${corStatus}44;border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;font-family:inherit">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="min-width:0;flex:1">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:14px">${canalEmoji[c.canal] || '📤'}</span>
              <span style="font-size:15px;font-weight:700;color:#f1f5f9">${escapeHtml(c.nome)}</span>
            </div>
            ${c.descricao ? `<div style="font-size:11.5px;color:#94a3b8;margin-top:4px">${escapeHtml(c.descricao)}</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              <span style="font-size:10.5px;padding:2px 8px;border-radius:10px;background:${corStatus}22;color:${corStatus};font-weight:600">${STATUS_CAMP_LABELS[c.status] || c.status}</span>
              <span style="font-size:10.5px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,0.06);color:#cbd5e1">${CANAL_LABELS[c.canal] || c.canal}</span>
              <span style="font-size:10.5px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,0.06);color:#cbd5e1">${escapeHtml(c.segmento_nome_cache || 'Sem segmento')}</span>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:22px;font-weight:700;color:#f1f5f9;line-height:1">${fmtNum(c.total_alvo || 0)}</div>
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">alvo</div>
          </div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#94a3b8;margin-bottom:4px">
            <span>${c.total_enviados || 0} enviados · ${c.total_respondidos || 0} resp · ${c.total_falhados || 0} falhas</span>
            <span>${pct}%</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${corStatus};border-radius:2px;transition:width 0.3s"></div>
          </div>
        </div>
        <div style="font-size:10px;color:#64748b;display:flex;justify-content:space-between;gap:6px">
          <span>${escapeHtml(c.criado_por_nome || '—')}</span>
          <span>${c.data_envio ? 'Envio: ' + dataStr : 'Criada em ' + new Date(c.created_at).toLocaleDateString('pt-BR')}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
          <button onclick="c360VerEnvios('${c.id}')" title="Ver envios" style="flex:1;min-width:100px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:11.5px">👁 Envios</button>
          <button onclick="c360GerarEnvios('${c.id}')" title="Gerar/atualizar lista" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(167,139,250,0.3);background:rgba(167,139,250,0.1);color:#a78bfa;cursor:pointer;font-size:11.5px">📋 Gerar</button>
          <button onclick="c360ExportPdfCampanha('${c.id}')" title="PDF" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:11.5px">📄 PDF</button>
          <button onclick="c360ExportCsvCampanha('${c.id}')" title="CSV" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:11.5px">⬇ CSV</button>
          <button onclick="c360CopiarMensagens('${c.id}')" title="Copiar mensagens" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:11.5px">📋 Copiar</button>
          <button onclick="c360EditCampanha('${c.id}')" title="Editar" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#e2e8f0;cursor:pointer;font-size:11.5px">✏</button>
          <button onclick="c360DeleteCampanha('${c.id}')" title="Apagar" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:transparent;color:#ef4444;cursor:pointer;font-size:11.5px">🗑</button>
        </div>
      </div>`;
    };

    page.innerHTML = `
<div style="padding:24px;max-width:1400px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <div>
      <h1 style="margin:0 0 6px;font-size:28px;font-weight:700;color:#f1f5f9;font-family:'Playfair Display',serif">Campanhas</h1>
      <div style="font-size:13px;color:#94a3b8">Dispare mensagens segmentadas · ${EMPRESA_LABELS[state.empresa] || state.empresa}</div>
    </div>
    <button onclick="c360NovaCampanha()" style="padding:10px 18px;border-radius:8px;border:1px solid oklch(88% 0.018 80 / 0.5);background:oklch(88% 0.018 80 / 0.12);color:oklch(88% 0.018 80);cursor:pointer;font-size:13px;font-weight:600">+ Nova Campanha</button>
  </div>
  <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:10px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:flex-start;gap:10px;font-size:12px;color:#cbd5e1">
    <div style="font-size:18px">ℹ️</div>
    <div><strong style="color:#f1f5f9">Disparo manual.</strong> Esta versão registra campanhas e rastreia envios manualmente. Pra disparo automático via WhatsApp Business ou SendGrid, é necessário contratar API paga e configurar depois. Por enquanto: <strong>gere a lista</strong>, exporte PDF/CSV ou copie as mensagens personalizadas, envie manualmente e marque como enviado aqui.</div>
  </div>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.5)">Campanhas (${state.campanhas.length})</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px">
      ${state.campanhas.length === 0
        ? '<div style="grid-column:1/-1;padding:40px;text-align:center;color:#64748b;background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.1);border-radius:12px"><div style="font-size:24px;margin-bottom:8px">📣</div><div style="font-size:13px;color:#e2e8f0">Nenhuma campanha</div><div style="font-size:11.5px;margin-top:4px">Clique em "+ Nova Campanha" pra começar.</div></div>'
        : state.campanhas.map(cardCampanha).join('')}
    </div>
  </div>
</div>`;
  }

  window.c360ReRenderCampanhasIfActive = async function() {
    const active = document.querySelector('.page-section.active');
    if (active?.id === 'page-campanhas') await renderCampanhasPage();
  };

  // ─── Modal Nova/Editar Campanha ───
  window.c360NovaCampanha = async function() { openCampanhaModal(null); };
  window.c360EditCampanha = async function(id) {
    const c = state.campanhas.find(x => x.id === id);
    if (c) openCampanhaModal(c);
  };

  async function openCampanhaModal(camp) {
    ensureCampanhasCSS();
    if (!state.segmentosCustom) state.segmentosCustom = await loadSegmentosCustom();
    if (!state.canaisAquisicao || state.canaisAquisicao.length === 0) await loadCanaisAquisicao();

    document.getElementById('c360-camp-modal')?.remove();

    const isEdit = !!camp;
    const c = camp || {
      nome: '', descricao: '', empresa: state.empresa,
      segmento_tipo: 'auto', segmento_id: null, segmento_nome_cache: 'VIP',
      canal: 'whatsapp', canal_aquisicao_id: null,
      mensagem: '', cupom_codigo: '', link_cta: '',
      data_envio: null, status: 'rascunho', observacoes: '',
    };

    const segAutos = ['VIP','Frequente','Ocasional','Em Risco','Inativo','todos'];
    const segAutoOpts = segAutos.map(s => `<option value="auto::${s}" ${c.segmento_tipo==='auto' && c.segmento_nome_cache===s ? 'selected':''}>Auto · ${s === 'todos' ? 'Todos os clientes' : s}</option>`).join('');
    const segCustomOpts = (state.segmentosCustom || [])
      .filter(s => s.empresa === state.empresa || s.empresa === 'ambas')
      .map(s => `<option value="custom::${s.id}" ${c.segmento_tipo==='custom' && String(c.segmento_id)===String(s.id) ? 'selected':''}>Custom · ${escapeHtml(s.nome)}</option>`).join('');

    const canalOpts = ['<option value="">— Sem canal vinculado —</option>']
      .concat((state.canaisAquisicao || []).map(ca => `<option value="${ca.id}" ${c.canal_aquisicao_id===ca.id ? 'selected':''}>${escapeHtml(ca.nome)} (${ca.tipo})</option>`)).join('');

    const dataEnvioStr = c.data_envio ? String(c.data_envio).substring(0,16) : '';

    const html = `
    <div id="c360-camp-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,sans-serif">
      <div style="background:#0b0f17;border:1px solid rgba(255,255,255,0.12);border-radius:14px;width:100%;max-width:720px;max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:#0b0f17;z-index:2">
          <h3 style="margin:0;font-size:16px;font-weight:700;color:#f1f5f9">${isEdit ? 'Editar' : 'Nova'} Campanha</h3>
          <button onclick="document.getElementById('c360-camp-modal').remove()" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:22px;line-height:1">&times;</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Nome *</label>
            <input id="camp-nome" type="text" value="${escapeHtml(c.nome)}" placeholder="Ex: Reengajamento VIPs inativos" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
          </div>
          <div>
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Descrição</label>
            <input id="camp-desc" type="text" value="${escapeHtml(c.descricao || '')}" placeholder="Objetivo (opcional)" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Segmento-alvo *</label>
              <select id="camp-segmento" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
                <optgroup label="Automáticos (RFM)">${segAutoOpts}</optgroup>
                ${segCustomOpts ? `<optgroup label="Customizados">${segCustomOpts}</optgroup>` : ''}
              </select>
              <div id="camp-seg-preview" style="font-size:11px;color:#64748b;margin-top:4px"></div>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Canal de Envio</label>
              <select id="camp-canal" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
                <option value="whatsapp" ${c.canal==='whatsapp'?'selected':''}>💬 WhatsApp</option>
                <option value="email" ${c.canal==='email'?'selected':''}>✉️ Email</option>
                <option value="sms" ${c.canal==='sms'?'selected':''}>📱 SMS</option>
                <option value="outro" ${c.canal==='outro'?'selected':''}>📤 Outro</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Canal de Aquisição (opcional)</label>
              <select id="camp-canalaq" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">${canalOpts}</select>
              <div style="font-size:10.5px;color:#64748b;margin-top:4px">Vincula ao canal do DMS pra análise de ROI</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Data prevista</label>
              <input id="camp-data" type="datetime-local" value="${dataEnvioStr}" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Cupom <span style="color:#64748b;font-size:10px;text-transform:none">(substitui {{cupom}})</span></label>
              <input id="camp-cupom" type="text" value="${escapeHtml(c.cupom_codigo || '')}" placeholder="Ex: VIP20" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Link CTA <span style="color:#64748b;font-size:10px;text-transform:none">(substitui {{link}})</span></label>
              <input id="camp-link" type="url" value="${escapeHtml(c.link_cta || '')}" placeholder="https://..." style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
            </div>
          </div>
          <div>
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Mensagem (template)</label>
            <textarea id="camp-msg" rows="5" placeholder="Olá {{primeiro_nome}}! ..." style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit;resize:vertical">${escapeHtml(c.mensagem || '')}</textarea>
            <div style="font-size:10.5px;color:#64748b;margin-top:4px">Placeholders: <code>{{nome}}</code> <code>{{primeiro_nome}}</code> <code>{{cupom}}</code> <code>{{link}}</code> <code>{{cidade}}</code> <code>{{uf}}</code></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Status</label>
              <select id="camp-status" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
                <option value="rascunho" ${c.status==='rascunho'?'selected':''}>Rascunho</option>
                <option value="agendada" ${c.status==='agendada'?'selected':''}>Agendada</option>
                <option value="enviada" ${c.status==='enviada'?'selected':''}>Enviada</option>
                <option value="concluida" ${c.status==='concluida'?'selected':''}>Concluída</option>
                <option value="cancelada" ${c.status==='cancelada'?'selected':''}>Cancelada</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Empresa</label>
              <select id="camp-empresa" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit">
                <option value="matriz" ${c.empresa==='matriz'?'selected':''}>Matriz</option>
                <option value="bc" ${c.empresa==='bc'?'selected':''}>BC</option>
                <option value="ambas" ${c.empresa==='ambas'?'selected':''}>Ambas</option>
              </select>
            </div>
          </div>
          <div>
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Observações</label>
            <textarea id="camp-obs" rows="2" placeholder="Notas internas" style="width:100%;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#f1f5f9;font-size:13px;font-family:inherit;resize:vertical">${escapeHtml(c.observacoes || '')}</textarea>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid rgba(255,255,255,0.08);position:sticky;bottom:0;background:#0b0f17">
          <button onclick="document.getElementById('c360-camp-modal').remove()" style="padding:9px 18px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#e2e8f0;cursor:pointer;font-size:13px;font-family:inherit">Cancelar</button>
          <button onclick="c360SaveCampanha('${isEdit ? c.id : 'null'}')" style="padding:9px 22px;border-radius:6px;border:none;background:oklch(88% 0.018 80);color:oklch(9% 0.008 260);cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">${isEdit ? 'Atualizar' : 'Criar'}</button>
        </div>
      </div>
    </div>`;

    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);

    const updateSegPreview = () => {
      const val = document.getElementById('camp-segmento')?.value || '';
      const [tipo, ident] = val.split('::');
      let count = 0;
      if (tipo === 'auto') {
        if (ident === 'todos') count = state.clientes.length;
        else count = state.clientes.filter(c => c.segmento === ident).length;
      } else if (tipo === 'custom') {
        const seg = (state.segmentosCustom || []).find(s => String(s.id) === ident);
        if (seg) count = aplicarFiltrosSegmento(state.clientes, seg.filtros || {}).length;
      }
      const el = document.getElementById('camp-seg-preview');
      if (el) el.textContent = `≈ ${fmtNum(count)} clientes (empresa atual)`;
    };
    document.getElementById('camp-segmento')?.addEventListener('change', updateSegPreview);
    updateSegPreview();
  }

  window.c360SaveCampanha = async function(idStr) {
    const id = idStr === 'null' ? null : idStr;
    const nome = (document.getElementById('camp-nome')?.value || '').trim();
    if (!nome) { if (typeof showToast === 'function') showToast('Nome é obrigatório', 'error'); return; }
    const segVal = document.getElementById('camp-segmento')?.value || 'auto::VIP';
    const [segTipo, segIdent] = segVal.split('::');
    let segmento_id = null; let segmento_nome_cache = '';
    if (segTipo === 'auto') {
      segmento_nome_cache = segIdent;
    } else if (segTipo === 'custom') {
      const seg = (state.segmentosCustom || []).find(s => String(s.id) === segIdent);
      if (seg) { segmento_id = seg.id; segmento_nome_cache = seg.nome; }
    }
    const canalAqVal = document.getElementById('camp-canalaq')?.value || '';
    const dataVal = document.getElementById('camp-data')?.value || '';
    const payload = {
      empresa: document.getElementById('camp-empresa')?.value || state.empresa,
      nome,
      descricao: (document.getElementById('camp-desc')?.value || '').trim() || null,
      segmento_tipo: segTipo, segmento_id, segmento_nome_cache,
      canal: document.getElementById('camp-canal')?.value || 'whatsapp',
      canal_aquisicao_id: canalAqVal || null,
      mensagem: (document.getElementById('camp-msg')?.value || '').trim() || null,
      cupom_codigo: (document.getElementById('camp-cupom')?.value || '').trim() || null,
      link_cta: (document.getElementById('camp-link')?.value || '').trim() || null,
      data_envio: dataVal ? new Date(dataVal).toISOString() : null,
      status: document.getElementById('camp-status')?.value || 'rascunho',
      observacoes: (document.getElementById('camp-obs')?.value || '').trim() || null,
    };
    try {
      if (id) {
        const { error } = await state.sb.from('cliente_campanhas').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
      } else {
        const { data: { user } } = await state.sb.auth.getUser();
        const { data: profile } = await state.sb.from('profiles').select('nome').eq('id', user.id).single();
        const { error } = await state.sb.from('cliente_campanhas').insert({
          ...payload, criado_por: user.id, criado_por_nome: profile?.nome || user.email,
        });
        if (error) throw error;
      }
      document.getElementById('c360-camp-modal')?.remove();
      if (typeof showToast === 'function') showToast('Campanha ' + (id ? 'atualizada' : 'criada'), 'success');
      await renderCampanhasPage();
    } catch (e) {
      if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
    }
  };

  window.c360DeleteCampanha = async function(id) {
    const c = state.campanhas.find(x => x.id === id);
    if (!c) return;
    const ok = await c360Confirm(`Apagar a campanha "${c.nome}"?\n\nIsso remove também todos os envios vinculados.`, { danger: true, okLabel: 'Apagar campanha' });
    if (!ok) return;
    const { error } = await state.sb.from('cliente_campanhas').delete().eq('id', id);
    if (error) { if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error'); return; }
    if (typeof showToast === 'function') showToast('Campanha apagada', 'success');
    await renderCampanhasPage();
  };

  // ─── Gerar lista de envios a partir do segmento ───
  window.c360GerarEnvios = async function(id) {
    const c = state.campanhas.find(x => x.id === id);
    if (!c) return;
    if (!state.segmentosCustom) state.segmentosCustom = await loadSegmentosCustom();

    const alvos = getClientesAlvoCampanha(c);
    if (alvos.length === 0) {
      if (typeof showToast === 'function') showToast('Segmento vazio — nenhum cliente corresponde', 'warn');
      return;
    }

    const { data: existentes, error: e1 } = await state.sb
      .from('cliente_campanha_envios').select('contato_id')
      .eq('campanha_id', id);
    if (e1) { if (typeof showToast === 'function') showToast('Erro: ' + e1.message, 'error'); return; }

    const jaIn = new Set((existentes || []).filter(r => r.contato_id).map(r => String(r.contato_id)));
    const novos = alvos.filter(a => a.contato_id && !jaIn.has(String(a.contato_id)));
    const semContato = alvos.filter(a => !a.contato_id).length;

    if (novos.length === 0) {
      const msg = `Todos os ${alvos.length - semContato} clientes com contato_id ja estao na lista.${semContato > 0 ? ' (' + semContato + ' sem contato_id ignorados)' : ''}`;
      if (typeof showToast === 'function') showToast(msg, 'warn');
      return;
    }
    const msgConfirm = `Adicionar ${novos.length} novos clientes à lista de envios?${jaIn.size > 0 ? '\n\n(' + jaIn.size + ' já existem e não serão duplicados)' : ''}${semContato > 0 ? '\n\n' + semContato + ' sem contato_id serão ignorados' : ''}`;
    const okGerar = await c360Confirm(msgConfirm, { okLabel: 'Adicionar à lista' });
    if (!okGerar) return;

    const rowsInserir = novos.map(cliente => ({
      campanha_id: id,
      empresa: c.empresa === 'ambas' ? state.empresa : c.empresa,
      contato_id: cliente.contato_id || null,
      contato_nome: cliente.contato_nome || 'Sem nome',
      contato_telefone: cliente.telefone || null,
      contato_celular: cliente.celular || null,
      contato_email: null,
      contato_cidade: null,
      contato_uf: cliente.uf || null,
      status: 'pendente',
      mensagem_renderizada: renderMensagemComPlaceholders(c.mensagem || '', cliente, c),
    }));

    const CHUNK = 500;
    for (let i = 0; i < rowsInserir.length; i += CHUNK) {
      const chunk = rowsInserir.slice(i, i + CHUNK);
      const { error } = await state.sb.from('cliente_campanha_envios').insert(chunk);
      if (error) {
        if (typeof showToast === 'function') showToast('Erro no chunk: ' + error.message, 'error');
        return;
      }
    }

    if (typeof showToast === 'function') showToast(`${rowsInserir.length} envios adicionados`, 'success');
    await renderCampanhasPage();
  };

  // ─── Modal ver envios ───
  window.c360VerEnvios = async function(id) {
    ensureCampanhasCSS();
    const c = state.campanhas.find(x => x.id === id);
    if (!c) return;
    const { data: envios, error } = await state.sb
      .from('cliente_campanha_envios').select('*')
      .eq('campanha_id', id)
      .order('status').order('contato_nome').limit(5000);
    if (error) { if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error'); return; }

    document.getElementById('c360-envios-modal')?.remove();
    const porStatus = {};
    for (const e of (envios || [])) porStatus[e.status] = (porStatus[e.status] || 0) + 1;

    const fmtFone = (f) => {
      if (!f) return '—';
      const d = String(f).replace(/\D/g,'');
      if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
      if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
      return f;
    };

    const row = (e) => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:8px 10px;font-size:12px;color:#e2e8f0">${escapeHtml(e.contato_nome)}</td>
        <td style="padding:8px 10px;font-size:12px;color:#94a3b8;white-space:nowrap">${escapeHtml(fmtFone(e.contato_celular || e.contato_telefone))}</td>
        <td style="padding:8px 10px"><span style="font-size:10.5px;padding:2px 8px;border-radius:10px;background:${STATUS_ENVIO_CORES[e.status]}22;color:${STATUS_ENVIO_CORES[e.status]};font-weight:600">${STATUS_ENVIO_LABELS[e.status] || e.status}</span></td>
        <td style="padding:8px 10px;text-align:right;white-space:nowrap">
          <select onchange="c360MarkEnvio('${e.id}', this.value)" style="padding:4px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#e2e8f0;font-size:11px;cursor:pointer">
            <option value="pendente" ${e.status==='pendente'?'selected':''}>Pendente</option>
            <option value="enviado" ${e.status==='enviado'?'selected':''}>Enviado</option>
            <option value="entregue" ${e.status==='entregue'?'selected':''}>Entregue</option>
            <option value="lido" ${e.status==='lido'?'selected':''}>Lido</option>
            <option value="respondido" ${e.status==='respondido'?'selected':''}>Respondido</option>
            <option value="falhou" ${e.status==='falhou'?'selected':''}>Falhou</option>
          </select>
        </td>
      </tr>`;

    const html = `
    <div id="c360-envios-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,sans-serif">
      <div style="background:#0b0f17;border:1px solid rgba(255,255,255,0.12);border-radius:14px;width:100%;max-width:860px;max-height:90vh;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);gap:12px">
          <div style="min-width:0">
            <h3 style="margin:0 0 4px;font-size:16px;font-weight:700;color:#f1f5f9">Envios · ${escapeHtml(c.nome)}</h3>
            <div style="font-size:11.5px;color:#94a3b8">Total: ${envios.length} · Pendentes: ${porStatus.pendente || 0} · Enviados: ${(porStatus.enviado||0)+(porStatus.entregue||0)+(porStatus.lido||0)+(porStatus.respondido||0)} · Respondidos: ${porStatus.respondido || 0} · Falhas: ${porStatus.falhou || 0}</div>
          </div>
          <button onclick="document.getElementById('c360-envios-modal').remove()" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:22px;line-height:1">&times;</button>
        </div>
        <div style="padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;gap:8px;flex-wrap:wrap">
          <button onclick="c360MarcarTodosEnviados('${id}')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.1);color:#60a5fa;cursor:pointer;font-size:12px">📤 Marcar pendentes como enviados</button>
          <button onclick="c360LimparEnvios('${id}')" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:transparent;color:#ef4444;cursor:pointer;font-size:12px">🗑 Limpar pendentes</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:0 4px">
          ${envios.length === 0
            ? '<div style="padding:40px;text-align:center;color:#64748b"><div style="font-size:24px;margin-bottom:8px">📭</div>Nenhum envio ainda. Clique em "Gerar" na campanha pra popular a lista.</div>'
            : `<table style="width:100%;border-collapse:collapse">
                <thead style="position:sticky;top:0;background:#0b0f17;z-index:1"><tr>
                  <th style="padding:10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.08)">Cliente</th>
                  <th style="padding:10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.08)">Telefone</th>
                  <th style="padding:10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.08)">Status</th>
                  <th style="padding:10px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.08)">Mudar</th>
                </tr></thead>
                <tbody>${envios.map(row).join('')}</tbody>
              </table>`}
        </div>
      </div>
    </div>`;

    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
  };

  window.c360MarkEnvio = async function(envioId, newStatus) {
    const patch = { status: newStatus, updated_at: new Date().toISOString() };
    if (['enviado','entregue','lido'].includes(newStatus)) patch.enviado_em = new Date().toISOString();
    if (newStatus === 'respondido') patch.respondido_em = new Date().toISOString();
    const { error } = await state.sb.from('cliente_campanha_envios').update(patch).eq('id', envioId);
    if (error) { if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error'); return; }
    if (typeof showToast === 'function') showToast('Status atualizado', 'success');
    await renderCampanhasPage();
  };

  window.c360MarcarTodosEnviados = async function(campanhaId) {
    const ok = await c360Confirm('Marcar TODOS os envios pendentes como "enviados"?', { okLabel: 'Marcar enviados' });
    if (!ok) return;
    const { error } = await state.sb.from('cliente_campanha_envios')
      .update({ status: 'enviado', enviado_em: new Date().toISOString() })
      .eq('campanha_id', campanhaId).eq('status', 'pendente');
    if (error) { if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error'); return; }
    if (typeof showToast === 'function') showToast('Marcados como enviados', 'success');
    document.getElementById('c360-envios-modal')?.remove();
    await renderCampanhasPage();
  };

  window.c360LimparEnvios = async function(campanhaId) {
    const ok = await c360Confirm('Remover todos os envios PENDENTES?\n\n(Os já enviados permanecem.)', { danger: true, okLabel: 'Remover pendentes' });
    if (!ok) return;
    const { error } = await state.sb.from('cliente_campanha_envios')
      .delete().eq('campanha_id', campanhaId).eq('status', 'pendente');
    if (error) { if (typeof showToast === 'function') showToast('Erro: ' + error.message, 'error'); return; }
    if (typeof showToast === 'function') showToast('Pendentes removidos', 'success');
    document.getElementById('c360-envios-modal')?.remove();
    await renderCampanhasPage();
  };

  // ─── Copiar mensagens personalizadas pro clipboard ───
  window.c360CopiarMensagens = async function(campanhaId) {
    const c = state.campanhas.find(x => x.id === campanhaId);
    if (!c) return;
    if (!c.mensagem) { if (typeof showToast === 'function') showToast('Campanha sem mensagem', 'warn'); return; }

    const { data: envios } = await state.sb
      .from('cliente_campanha_envios')
      .select('contato_nome,contato_telefone,contato_celular,contato_uf')
      .eq('campanha_id', campanhaId).order('contato_nome').limit(2000);

    let lista = envios || [];
    if (lista.length === 0) {
      if (!state.segmentosCustom) state.segmentosCustom = await loadSegmentosCustom();
      const alvos = getClientesAlvoCampanha(c);
      lista = alvos.map(a => ({ contato_nome: a.contato_nome, contato_celular: a.celular, contato_telefone: a.telefone, contato_uf: a.uf }));
    }
    if (lista.length === 0) { if (typeof showToast === 'function') showToast('Nenhum cliente', 'warn'); return; }

    const linhas = lista.map(cli => renderMensagemComPlaceholders(c.mensagem, { contato_nome: cli.contato_nome, uf: cli.contato_uf }, c));
    const texto = linhas.join('\n\n═══════════════════\n\n');
    try {
      await navigator.clipboard.writeText(texto);
      if (typeof showToast === 'function') showToast(`${linhas.length} mensagens copiadas`, 'success');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = texto;
      ta.style.cssText = 'position:fixed;top:10%;left:50%;transform:translateX(-50%);width:80vw;height:70vh;z-index:9999';
      document.body.appendChild(ta); ta.select();
      if (typeof showToast === 'function') showToast('Selecione e copie manualmente (Ctrl+C)', 'warn');
      setTimeout(() => ta.remove(), 20000);
    }
  };

  // ─── Export CSV ───
  window.c360ExportCsvCampanha = async function(campanhaId) {
    const c = state.campanhas.find(x => x.id === campanhaId);
    if (!c) return;
    const { data: envios } = await state.sb
      .from('cliente_campanha_envios').select('*')
      .eq('campanha_id', campanhaId).order('contato_nome').limit(5000);

    let lista = envios || [];
    if (lista.length === 0) {
      if (!state.segmentosCustom) state.segmentosCustom = await loadSegmentosCustom();
      const alvos = getClientesAlvoCampanha(c);
      lista = alvos.map(a => ({
        contato_nome: a.contato_nome, contato_telefone: a.telefone, contato_celular: a.celular,
        contato_email: null, contato_uf: a.uf, status: 'pendente',
        mensagem_renderizada: renderMensagemComPlaceholders(c.mensagem || '', a, c),
      }));
    }
    if (lista.length === 0) { if (typeof showToast === 'function') showToast('Nenhum cliente', 'warn'); return; }

    const BOM = '\ufeff';
    const headers = ['Nome','Telefone','Celular','Email','UF','Status','Mensagem'];
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g,'""').replace(/\r?\n/g,' ')}"`;
    const csv = BOM + headers.map(esc).join(';') + '\r\n'
      + lista.map(e => [e.contato_nome, e.contato_telefone, e.contato_celular, e.contato_email, e.contato_uf, e.status, e.mensagem_renderizada].map(esc).join(';')).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campanha_${c.nome.replace(/[^a-z0-9]+/gi,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    if (typeof showToast === 'function') showToast(`CSV com ${lista.length} linhas exportado`, 'success');
  };

  // ─── Export PDF (janela print-friendly) ───
  window.c360ExportPdfCampanha = async function(campanhaId) {
    const c = state.campanhas.find(x => x.id === campanhaId);
    if (!c) return;
    const { data: envios } = await state.sb
      .from('cliente_campanha_envios').select('*')
      .eq('campanha_id', campanhaId).order('contato_nome').limit(3000);

    let lista = envios || [];
    if (lista.length === 0) {
      if (!state.segmentosCustom) state.segmentosCustom = await loadSegmentosCustom();
      const alvos = getClientesAlvoCampanha(c);
      lista = alvos.map(a => ({
        contato_nome: a.contato_nome, contato_telefone: a.telefone, contato_celular: a.celular,
        contato_email: null, contato_uf: a.uf, segmento: a.segmento, status: 'pendente',
        mensagem_renderizada: renderMensagemComPlaceholders(c.mensagem || '', a, c),
      }));
    }
    if (lista.length === 0) { if (typeof showToast === 'function') showToast('Nenhum cliente', 'warn'); return; }

    const win = window.open('', '_blank', 'width=900,height=1200');
    if (!win) { if (typeof showToast === 'function') showToast('Permita popups pra exportar', 'error'); return; }

    const hoje = new Date().toLocaleDateString('pt-BR');
    const fmtFone = (f) => {
      if (!f) return '—';
      const d = String(f).replace(/\D/g,'');
      if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
      if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
      return f;
    };
    const msgExemplo = c.mensagem
      ? renderMensagemComPlaceholders(c.mensagem, lista[0] ? { contato_nome: lista[0].contato_nome, uf: lista[0].contato_uf } : {}, c)
      : '';

    const rows = lista.map((e, i) => `
      <tr>
        <td style="width:28px;text-align:center;color:#999">${i+1}</td>
        <td><strong>${escapeHtml(e.contato_nome || '')}</strong>${e.segmento ? ` <span class="chip">${escapeHtml(e.segmento)}</span>` : ''}</td>
        <td>${escapeHtml(fmtFone(e.contato_celular))}</td>
        <td>${escapeHtml(fmtFone(e.contato_telefone))}</td>
        <td>${escapeHtml(e.contato_email || '—')}</td>
        <td>${escapeHtml(e.contato_uf || '—')}</td>
        <td class="status-${e.status}">${STATUS_ENVIO_LABELS[e.status] || e.status}</td>
        <td style="width:20px;text-align:center"><span class="check"></span></td>
      </tr>`).join('');

    win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Campanha: ${escapeHtml(c.nome)} · Dana Jalecos · ${hoje}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --border:#e6e6e6; --muted:#666; }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
  body { font-family:'DM Sans',sans-serif; color:#0a0a0a; max-width:900px; margin:0 auto; padding:26px 32px; line-height:1.5; font-size:12px; background:#fff; }
  .pdf-header { background:#0a0a0a; color:#fff; border-radius:12px; padding:20px 24px; margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  .pdf-title { font-family:'Syne',sans-serif; font-weight:800; font-size:19px; }
  .pdf-sub { font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:rgba(255,255,255,0.55); font-weight:700; }
  .meta { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px; }
  .meta-cell { background:#fafafa; border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
  .meta-label { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:var(--muted); font-weight:700; margin-bottom:2px; }
  .meta-val { font-family:'Syne',sans-serif; font-weight:700; font-size:13px; color:#0a0a0a; }
  .msg-box { background:#fafafa; border:1px dashed #ccc; border-radius:8px; padding:12px 14px; margin-bottom:16px; white-space:pre-wrap; font-size:12px; color:#333; }
  .msg-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:var(--muted); margin-bottom:6px; }
  h2.sec { font-family:'Syne',sans-serif; font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:1.5px; margin:16px 0 10px; padding-bottom:6px; border-bottom:2px solid #0a0a0a; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { background:#0a0a0a; color:#fff; text-align:left; font-size:9.5px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; padding:7px 8px; }
  td { padding:6px 8px; border-bottom:1px solid #eee; }
  tr:nth-child(even) td { background:#fafafa; }
  .chip { display:inline-block; padding:1px 6px; border-radius:3px; background:#f0f0f0; font-size:9px; font-weight:700; color:#555; }
  .check { display:inline-block; width:12px; height:12px; border:1.5px solid #0a0a0a; border-radius:2px; }
  .status-pendente { color:#666; }
  .status-enviado, .status-entregue, .status-lido { color:#1a4fa0; font-weight:600; }
  .status-respondido { color:#1a7a3a; font-weight:700; }
  .status-falhou { color:#c0392b; font-weight:700; }
  .pdf-footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--border); text-align:center; font-size:10px; color:#999; }
  @media print {
    body { padding:18px; font-size:10.5px; }
    table { page-break-inside:auto; }
    tr { page-break-inside:avoid; page-break-after:auto; }
    thead { display:table-header-group; }
  }
</style></head><body>
<div class="pdf-header">
  <div><div class="pdf-sub">Campanha de Marketing</div><div class="pdf-title">${escapeHtml(c.nome)}</div></div>
  <div class="pdf-sub">${hoje}</div>
</div>
<div class="meta">
  <div class="meta-cell"><div class="meta-label">Segmento</div><div class="meta-val">${escapeHtml(c.segmento_nome_cache || '—')}</div></div>
  <div class="meta-cell"><div class="meta-label">Canal</div><div class="meta-val">${CANAL_LABELS[c.canal] || c.canal}</div></div>
  <div class="meta-cell"><div class="meta-label">Status</div><div class="meta-val">${STATUS_CAMP_LABELS[c.status] || c.status}</div></div>
  <div class="meta-cell"><div class="meta-label">Total Clientes</div><div class="meta-val">${fmtNum(lista.length)}</div></div>
</div>
${msgExemplo ? `<div class="msg-box"><div class="msg-title">💬 Mensagem modelo (exemplo com primeiro cliente)</div>${escapeHtml(msgExemplo)}</div>` : ''}
<h2 class="sec">Lista de Contatos</h2>
<table>
  <thead><tr>
    <th style="width:28px">#</th><th>Nome</th><th>WhatsApp</th><th>Telefone</th><th>Email</th><th>UF</th><th>Status</th><th style="width:20px">✓</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="pdf-footer">
  Dana Jalecos Exclusivos · Cliente 360 · Gerado em ${hoje} por ${escapeHtml(c.criado_por_nome || '—')}<br>
  Empresa: ${EMPRESA_LABELS[c.empresa] || c.empresa} · Total de contatos: ${fmtNum(lista.length)}
</div>
<script>setTimeout(() => { window.print(); }, 400);<\/script>
</body></html>`);
  };

  // ─── Realtime ───
  function subscribeRealtimeCampanhas() {
    if (state.campanhasChannel) return;
    state.campanhasChannel = state.sb
      .channel('realtime-cliente-campanhas')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cliente_campanhas' }, async () => {
        const active = document.querySelector('.page-section.active');
        if (active?.id === 'page-campanhas') await renderCampanhasPage();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cliente_campanha_envios' }, async () => {
        const active = document.querySelector('.page-section.active');
        if (active?.id === 'page-campanhas') {
          setTimeout(async () => { await renderCampanhasPage(); }, 300);
        }
      })
      .subscribe();
  }

  // ─── Boot ───
  async function boot() {
    console.log('[c360] Boot iniciado · empresa=' + state.empresa);
    updateEmpresaToggleUI();
    const authOK = await initSupabase();
    if (!authOK) return;
    wireSearchAndFilters();
    // Paralelo: lista + dashboard + mencionaveis (preload)
    await Promise.all([loadClientes(), loadDashboardResumo(), loadMencionaveis()]);
    // Subscribe realtime pra notas, segmentos e campanhas
    subscribeRealtimeNotas();
    subscribeRealtimeSegmentos();
    subscribeRealtimeCampanhas();
    // Se veio deep-link via sessionStorage, abre o cliente/aba certa
    await checkDeepLink();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
