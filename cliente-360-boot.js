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
    empresa: 'todas',
    clientes: [],     // Array de cliente_scoring rows
    filtered: [],     // Após aplicar busca
    segmentFilter: 'todos',
    searchQuery: '',
    page: 0,
    loadingList: false,
    clientSelected: null,
  };

  // ─── Helpers ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const fmtBRL = (n) => (Number(n)||0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtNum = (n) => (Number(n)||0).toLocaleString('pt-BR');
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '-';
  const escapeHtml = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Empresa label
  const EMPRESA_LABELS = { matriz: 'Matriz (Piçarras)', bc: 'BC (Balneário)', todas: 'Matriz + BC' };

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
      const params = new URLSearchParams(location.search);
      state.empresa = params.get('empresa') || 'todas';

      const { data, error } = await state.sb
        .from('cliente_scoring')
        .select('*')
        .eq('empresa', state.empresa)
        .order('score', { ascending: false, nullsFirst: false })
        .limit(5000);

      if (error) {
        console.error('[c360] erro load clientes:', error);
        return;
      }

      state.clientes = data || [];
      applyFilters();
      console.log(`[c360] ${state.clientes.length} clientes (empresa=${state.empresa})`);
    } catch (e) {
      console.error('[c360] exception load:', e);
    } finally {
      state.loadingList = false;
    }
  }

  function applyFilters() {
    const q = (state.searchQuery || '').trim().toLowerCase();
    state.filtered = state.clientes.filter(c => {
      if (state.segmentFilter !== 'todos' && c.segmento !== state.segmentFilter) return false;
      if (q && !String(c.contato_nome || '').toLowerCase().includes(q)) return false;
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

  // ─── Filtros: busca + segmento ───
  function wireSearchAndFilters() {
    // Input de busca na aba clientes (pega o primeiro input type=text/search)
    const searchInput = document.querySelector('#page-clientes input[type="text"], #page-clientes input[type="search"], #page-clientes input[placeholder*="Buscar"]');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value || '';
        applyFilters();
      });
    }

    // Se houver um select de segmento, wire nele tambem (fallback: ignora)
    // Por enquanto deixamos os filtros visuais originais (demo) — controlam via applyFilters se os botoes chamam window.filtrarClientes com arg
    window.filtrarClientesFase2 = (segmento) => {
      state.segmentFilter = segmento || 'todos';
      applyFilters();
    };
  }

  // ─── Realtime de mudanças no filtro de empresa (parent muda ?empresa=) ───
  window.addEventListener('message', (e) => {
    if (e && e.data && e.data.type === 'empresa-changed') {
      state.empresa = e.data.empresa || 'todas';
      loadClientes();
    }
  });

  // ─── Detalhe de cliente (placeholder — sobrescreve a demo) ───
  // Será completado no Commit 2
  window.showClientDetail = function(clienteId) {
    console.log('[c360] showClientDetail (encoded):', clienteId);
    const nome = decodeURIComponent(clienteId);
    alert('Detalhe do cliente "' + nome + '" será implementado no próximo commit.\n\n(Fase 2 — Commit 1: lista dinâmica já funcionando!)');
  };

  // ─── Boot ───
  async function boot() {
    console.log('[c360] Boot iniciado');
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
