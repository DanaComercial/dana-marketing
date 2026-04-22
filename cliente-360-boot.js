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
    <div id="c360-tabpanel-notas" style="padding:40px;display:none;text-align:center;color:#64748b">
      <div style="font-size:32px;margin-bottom:8px">💬</div>
      <div style="font-size:14px;margin-bottom:4px;color:#e2e8f0">Notas — em breve</div>
      <div style="font-size:12px">Em breve você vai poder adicionar notas internas sobre este cliente (observações, histórico de contato, preferências).</div>
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

  // Ao trocar pra aba insights, carrega histórico (se ainda não tem)
  const origSwitchTab = window.c360SwitchTab;
  window.c360SwitchTab = async function(tab) {
    origSwitchTab(tab);
    if (tab === 'insights') {
      const page = document.getElementById('page-cliente-1');
      const nomeEl = page?.querySelector('h2');
      const nome = nomeEl?.textContent?.trim();
      const panel = document.getElementById('c360-tabpanel-insights');
      if (!nome || !panel) return;
      // Só carrega se ainda não foi carregado
      if (panel.getAttribute('data-loaded-for') !== nome) {
        panel.setAttribute('data-loaded-for', nome);
        const history = await c360LoadInsightsHistory(nome);
        renderInsightsTab(nome, history, false);
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

  // ─── Boot ───
  async function boot() {
    console.log('[c360] Boot iniciado · empresa=' + state.empresa);
    updateEmpresaToggleUI();
    const authOK = await initSupabase();
    if (!authOK) return;
    wireSearchAndFilters();
    // Paralelo: lista + dashboard
    await Promise.all([loadClientes(), loadDashboardResumo()]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
