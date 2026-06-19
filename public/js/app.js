/* ═══════════════════════════════════════════════════════════════════
   POKEVAULT — app.js
   Tabs: Search | Portfolio
   History window: 5 days before account creation → today (fixed window)
   Features: card detail modal w/ graph+image tabs, portfolio chart,
             auto-navigate to portfolio after adding card
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const SUPABASE_URL      = 'https://jqzwvcjkekvdyimhryha.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impxend2Y2prZWt2ZHlpbWhyeWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NzU5OTYsImV4cCI6MjA5NjE1MTk5Nn0.waU_KSWUuB0W_0Zu7tizbraAxmSpXyEVnKWCQnruXjs';
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Global State ──────────────────────────────────────────────────
let USD_TO_SGD        = 1.35;
let portfolioItems    = [];
let _currentUserId    = null;
let _userProfile      = null;
let _allowedHistoryDays = 35;
let _portfolioChart   = null;
let _cardDetailChart  = null;

// Search state
let _searchLang       = 'english';
let _searchType       = 'cards';
let _activeView       = 'grid';
let _searchResults    = [];

// Portfolio search state
let _pfSearchLang     = 'english';
let _pfSearchType     = 'cards';
let _pfSearchResults  = [];
let _pfSearchDebounce = null;

// Portfolio add modal state
let _portfolioAddResult = null;

// ── DB Mappers ────────────────────────────────────────────────────
function dbToPortfolioItem(row) {
  return {
    id:               row.id,
    itemId:           row.item_id,
    type:             row.type,
    name:             row.name,
    set:              row.set_name,
    imageUrl:         row.image_url,
    purchasePrice:    row.purchase_price,
    quantity:         row.quantity     ?? 1,
    conditionOrGrade: row.condition_or_grade ?? 'Near Mint',
    language:         row.language     ?? 'english',
    notes:            row.notes,
    currentValue:     row.current_value,
    lastValueUpdated: row.last_value_updated,
    sold:             row.sold         ?? false,
    soldPrice:        row.sold_price,
    soldDate:         row.sold_date,
    createdAt:        row.created_at,
  };
}

// ── Theme ─────────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('pv-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

window.addEventListener('scroll', () => {
  document.getElementById('site-header')?.classList.toggle('scrolled', window.scrollY > 20);
});

// ── Exchange Rate ─────────────────────────────────────────────────
async function fetchExchangeRate() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) return;
    const data = await res.json();
    if (data.rates?.SGD) {
      USD_TO_SGD = data.rates.SGD;
      const el = document.getElementById('fx-rate');
      if (el) el.textContent = 'USD/SGD: ' + USD_TO_SGD.toFixed(4);
    }
  } catch { console.warn('Exchange rate fetch failed — using fallback 1.35'); }
}

// ── History Window ────────────────────────────────────────────────
function computeAllowedHistoryDays(profile) {
  if (!profile) return 35;
  if (profile.is_premium) return 180;
  const created     = new Date(profile.created_at);
  const windowStart = new Date(created);
  windowStart.setDate(windowStart.getDate() - 5);
  const today     = new Date();
  const totalDays = Math.ceil((today - windowStart) / (1000 * 60 * 60 * 24));
  return Math.max(totalDays, 5);
}

function historyWindowLabel(profile) {
  if (!profile) return '—';
  if (profile.is_premium) return '6-month history (Pro)';
  const created     = new Date(profile.created_at);
  const windowStart = new Date(created);
  windowStart.setDate(windowStart.getDate() - 5);
  const dateStr = windowStart.toLocaleDateString('en-SG', { day:'numeric', month:'short', year:'numeric' });
  return `From ${dateStr} → today`;
}

// ── Profile ───────────────────────────────────────────────────────
async function loadProfile() {
  const { data, error } = await _sb
    .from('profiles')
    .select('id, username, created_at, is_premium')
    .eq('id', _currentUserId)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: { user } } = await _sb.auth.getUser();
    const email = user?.email || '';
    const usernameVal = user?.user_metadata?.username
      || email.replace('@pokevault.app', '').replace(/@.*/, '')
      || 'user_' + _currentUserId.slice(0, 8);
    const { data: inserted, error: insertErr } = await _sb
      .from('profiles')
      .insert([{ id: _currentUserId, username: usernameVal }])
      .select()
      .single();
    if (!insertErr) _userProfile = inserted;
  } else if (!error) {
    _userProfile = data;
  }

  _allowedHistoryDays = computeAllowedHistoryDays(_userProfile);

  const premBadge = document.getElementById('premium-badge');
  if (_userProfile?.is_premium && premBadge) premBadge.style.display = 'inline-flex';

  const histEl = document.getElementById('history-days-display');
  if (histEl) histEl.textContent = historyWindowLabel(_userProfile);
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/login'; return; }
  _currentUserId = session.user.id;
  const usernameEl = document.getElementById('username-display');
  if (usernameEl) {
    const email = session.user.email || '';
    const metaUsername = session.user.user_metadata?.username;
    usernameEl.textContent = metaUsername || email.replace('@pokevault.app', '').replace(/@.*/, '');
  }

  await Promise.all([fetchExchangeRate(), loadProfile()]);
  await loadPortfolioItems();
  setupSearchListeners();
  const isFirstTime = portfolioItems.filter(i => !i.sold).length === 0;
  switchMainTab(isFirstTime ? 'search' : 'portfolio');
  updateSearchTabVisibility();
}

async function logout() {
  await _sb.auth.signOut();
  window.location.href = '/login';
}

// ── Tab Navigation ────────────────────────────────────────────────
function switchMainTab(tab) {
  document.getElementById('tab-search').style.display    = tab === 'search'    ? 'block' : 'none';
  document.getElementById('tab-portfolio').style.display = tab === 'portfolio' ? 'block' : 'none';
  document.getElementById('nav-search').classList.toggle('active',    tab === 'search');
  document.getElementById('nav-portfolio').classList.toggle('active', tab === 'portfolio');
  document.getElementById('nav-search').setAttribute('aria-selected',    tab === 'search');
  document.getElementById('nav-portfolio').setAttribute('aria-selected', tab === 'portfolio');
}

function updateSearchTabVisibility() {
  const hasItems  = portfolioItems.filter(i => !i.sold).length > 0;
  const navSearch = document.getElementById('nav-search');
  if (navSearch) navSearch.style.display = hasItems ? 'none' : '';
  if (hasItems && document.getElementById('tab-search')?.style.display !== 'none') {
    switchMainTab('portfolio');
  }
}

// ── Utility ───────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add('toast-show'), 10);
  setTimeout(() => { el.classList.remove('toast-show'); setTimeout(() => el.remove(), 300); }, 3500);
}

function confirmDialog(message) {
  return new Promise(resolve => {
    document.getElementById('confirm-message').textContent = message;
    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.add('active');
    const ok     = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    function cleanup(result) {
      overlay.classList.remove('active');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

function animateValue(el, target, prefix) {
  if (!el) return;
  const start = parseFloat(el.getAttribute('data-val') || '0');
  const duration = 600; const t0 = performance.now();
  const step = now => {
    const p = Math.min((now - t0) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + '$' + (start + (target - start) * ease).toFixed(2);
    if (p < 1) requestAnimationFrame(step);
    else { el.textContent = prefix + '$' + target.toFixed(2); el.setAttribute('data-val', target); }
  };
  requestAnimationFrame(step);
}

// ── Price Extraction ──────────────────────────────────────────────
function extractResultPrice(r, isSealed) {
  if (isSealed) return r.unopenedPrice ?? null;
  if (r.prices?.market   != null) return r.prices.market;
  if (r.prices?.lowPrice != null) return r.prices.lowPrice;
  if (r.prices?.midPrice != null) return r.prices.midPrice;
  if (r.japanesePrice    != null) return r.japanesePrice;
  if (r.averagePrice     != null) return r.averagePrice;
  if (r.marketPrice      != null) return r.marketPrice;
  if (r.price            != null) return r.price;
  return null;
}

// ── Graded Price Extraction ───────────────────────────────────────
// The API returns graded eBay data as r.ebay: { psa10: { avg, salesCount, ... }, psa9: {...}, bgs9_5: {...}, ... }
// conditionOrGrade is stored as e.g. "PSA 10", "PSA 9", "BGS 9.5", "BGS 10"
// This converts that label to the API key (e.g. "psa10", "bgs9_5") and reads the avg price.
function extractGradedPrice(apiResult, conditionOrGrade) {
  if (!apiResult || !conditionOrGrade) return null;

  const gradeMatch = conditionOrGrade.match(/^(PSA|BGS|CGC)\s+(.+)$/i);
  if (!gradeMatch) return null;

  const company = gradeMatch[1].toLowerCase();                      // "psa", "bgs", "cgc"
  const grade   = gradeMatch[2].trim().replace('.', '_');           // "10" → "10", "9.5" → "9_5"
  const key     = company + grade;                                  // "psa10", "bgs9_5", "cgc9"

  // The API nests this under r.ebay (from includeEbay=true)
  const ebay = apiResult.ebay ?? apiResult.ebaySales ?? apiResult.ebay_sales ?? null;
  if (!ebay || typeof ebay !== 'object') return null;

  // Try the exact key first, then a few common aliases the API may use
  const entry = ebay[key] ?? ebay[company + '_' + grade] ?? null;
  if (!entry) return null;

  // The docs show { avg, salesCount, smartMarketPrice, ... } — prefer smartMarketPrice then avg
  const price = parseFloat(entry.smartMarketPrice ?? entry.avg ?? entry.averagePrice ?? entry.price ?? 0);
  return price > 0 ? price : null;
}

// ── Chart Helpers ─────────────────────────────────────────────────
function destroyChart(chartRef) {
  if (chartRef) { try { chartRef.destroy(); } catch(e) {} }
  return null;
}

function buildChartConfig(labels, values, label, color = '#00e5cc') {
  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2,
        pointRadius: values.length > 30 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => 'SGD $' + Number(ctx.parsed.y).toFixed(2),
          },
          backgroundColor: '#0e1017',
          borderColor: color,
          borderWidth: 1,
          titleColor: '#f0f2ff',
          bodyColor: '#a8b0d0',
        },
      },
      scales: {
        x: {
          ticks: { color: '#5a6080', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 },
          grid:  { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          ticks: {
            color: '#5a6080',
            font: { family: 'JetBrains Mono', size: 10 },
            callback: v => 'SGD $' + Number(v).toFixed(2),
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  SEARCH TAB
// ══════════════════════════════════════════════════════════════════

function setupSearchListeners() {
  const input   = document.getElementById('search-input');
  const btn     = document.getElementById('search-btn');
  const setInp  = document.getElementById('set-input');

  btn?.addEventListener('click', doSearch);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  setInp?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  document.querySelectorAll('.lang-btn:not(.pf-lang-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lang-btn:not(.pf-lang-btn)').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      _searchLang = btn.dataset.lang;
    });
  });

  document.querySelectorAll('.search-type-btn:not(#pf-type-cards):not(#pf-type-sealed)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.search-type-btn:not(#pf-type-cards):not(#pf-type-sealed)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _searchType = btn.dataset.type;
    });
  });

  document.querySelectorAll('.hint-chip, .example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.query;
      if (!q) return;
      document.getElementById('search-input').value = q;
      if (chip.dataset.lang === 'japanese') {
        _searchLang = 'japanese';
        document.querySelectorAll('.lang-btn:not(.pf-lang-btn)').forEach(b => {
          b.classList.toggle('active', b.dataset.lang === 'japanese');
          b.setAttribute('aria-pressed', b.dataset.lang === 'japanese' ? 'true' : 'false');
        });
      }
      doSearch();
    });
  });

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeView = btn.dataset.view;
      const grid = document.getElementById('results-grid');
      if (grid) grid.classList.toggle('list-view', _activeView === 'list');
    });
  });
}

function showSearchState(state) {
  document.getElementById('welcome-state').classList.toggle('hidden', state !== 'welcome');
  document.getElementById('loading').classList.toggle('visible', state === 'loading');
  document.getElementById('empty-state').classList.toggle('visible', state === 'empty');
  document.getElementById('error-state').classList.toggle('visible', state === 'error');
  const grid = document.getElementById('results-grid');
  grid.classList.toggle('hidden', state !== 'results');
  document.getElementById('status-bar').classList.toggle('hidden', state !== 'results');
}

function isCardNumber(q) {
  return /^\d+\/\d+$/.test(q.trim()) || /^\d{3}$/.test(q.trim());
}

async function doSearch() {
  const raw   = (document.getElementById('search-input')?.value || '').trim();
  const set   = (document.getElementById('set-input')?.value || '').trim();
  if (!raw) return;

  showSearchState('loading');

  try {
    let params;
    if (_searchType === 'sealed') {
      params = new URLSearchParams({ action: 'sealed', language: _searchLang });
      params.set('name', raw);
    } else if (isCardNumber(raw)) {
      params = new URLSearchParams({ action: 'bynumber', name: raw, language: _searchLang });
      if (set) params.set('set', set);
    } else {
      const q = set ? raw + ' ' + set : raw;
      params = new URLSearchParams({ action: 'search', name: q, language: _searchLang });
    }

    const res  = await fetch('/api/pokeprice?' + params);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _searchResults = data.results || [];

    if (!_searchResults.length) { showSearchState('empty'); return; }

    renderSearchResults(_searchResults, _searchType === 'sealed');
    showSearchState('results');

    const countEl = document.getElementById('result-count');
    if (countEl) countEl.innerHTML = `<strong>${_searchResults.length}</strong> result${_searchResults.length !== 1 ? 's' : ''}`;
  } catch (e) {
    console.error('doSearch error:', e);
    document.getElementById('error-msg').textContent = e.message || 'Unknown error';
    showSearchState('error');
  }
}

function renderSearchResults(results, isSealed) {
  const grid = document.getElementById('results-grid');
  grid.classList.toggle('list-view', _activeView === 'list');

  grid.innerHTML = results.map((r, i) => {
    const thumb    = r.imageCdnUrl400 || r.imageCdnUrl200 || r.imageCdnUrl || '';
    const priceUSD = extractResultPrice(r, isSealed);
    const mktSGD   = priceUSD != null ? 'SGD $' + (priceUSD * USD_TO_SGD).toFixed(2) : null;
    const lowSGD   = r.prices?.lowPrice != null ? 'SGD $' + (r.prices.lowPrice * USD_TO_SGD).toFixed(2) : null;
    const imgEl    = thumb
      ? `<img src="${esc(thumb)}" loading="lazy" alt="${esc(r.name)}" />`
      : `<div class="card-img-placeholder">${isSealed ? '📦' : '🃏'}</div>`;
    const rarity = r.rarity ? `<span class="rarity-badge">${esc(r.rarity)}</span>` : '';
    const number = r.cardNumber ? `<span class="number-badge">#${esc(r.cardNumber)}</span>` : '';
    const jpFlag = _searchLang === 'japanese' ? ' 🇯🇵' : '';

    return `<div class="card" role="listitem" onclick="openSearchResult(${i},${isSealed})">
      <div class="card-img-wrap">
        ${imgEl}${rarity}${number}
      </div>
      <div class="card-body">
        <div class="card-name">${esc(r.name)}${jpFlag}</div>
        <div class="card-meta">${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}</div>
        <div class="card-prices">
          <div class="price-row">
            <span class="price-label">Market</span>
            <span class="price-value ${mktSGD?'':'na'}">${mktSGD||'—'}</span>
          </div>
          ${lowSGD ? `<div class="price-row"><span class="price-label">Low</span><span class="price-value">${lowSGD}</span></div>` : ''}
        </div>
        <button class="btn-add-portfolio" onclick="event.stopPropagation();addToPortfolioFromSearch(${i},${isSealed})">+ Portfolio</button>
      </div>
    </div>`;
  }).join('');
}

function openSearchResult(index, isSealed) {
  const r = _searchResults[index];
  if (!r) return;
  const thumb    = r.imageCdnUrl400 || r.imageCdnUrl || r.imageCdnUrl200 || '';
  const priceUSD = extractResultPrice(r, isSealed);
  const mktSGD   = priceUSD != null ? 'SGD $' + (priceUSD * USD_TO_SGD).toFixed(2) : '—';
  const lowSGD   = r.prices?.lowPrice != null ? 'SGD $' + (r.prices.lowPrice * USD_TO_SGD).toFixed(2) : '—';
  const midSGD   = r.prices?.midPrice != null ? 'SGD $' + (r.prices.midPrice * USD_TO_SGD).toFixed(2) : '—';
  const hiSGD    = r.prices?.highPrice != null ? 'SGD $' + (r.prices.highPrice * USD_TO_SGD).toFixed(2) : '—';
  const jpFlag   = _searchLang === 'japanese' ? ' 🇯🇵' : '';

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-body">
      <div class="modal-img-wrap">
        ${thumb
          ? `<img src="${esc(thumb)}" alt="${esc(r.name)}" />`
          : `<div class="modal-img-placeholder">${isSealed ? '📦' : '🃏'}</div>`
        }
      </div>
      <div class="modal-info">
        <div class="modal-card-name">${esc(r.name)}${jpFlag}</div>
        <div class="modal-card-set">${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}${r.rarity?' · '+esc(r.rarity):''}</div>
        <div class="modal-tags">
          ${isSealed ? '<span class="modal-tag accent">📦 Sealed</span>' : ''}
          ${r.pokemonType ? `<span class="modal-tag">${esc(r.pokemonType)}</span>` : ''}
        </div>

        <div class="modal-section-title">Prices (SGD)</div>
        <div class="price-table-wrap" style="margin-bottom:20px;">
          <table class="price-table">
            <thead><tr><th>Type</th><th>Price</th></tr></thead>
            <tbody>
              <tr><td class="label-cell">Market</td><td class="price-cell">${mktSGD}</td></tr>
              ${!isSealed ? `
              <tr><td class="label-cell">Low</td><td class="price-cell">${lowSGD}</td></tr>
              <tr><td class="label-cell">Mid</td><td class="price-cell">${midSGD}</td></tr>
              <tr><td class="label-cell">High</td><td class="price-cell">${hiSGD}</td></tr>` : ''}
            </tbody>
          </table>
        </div>

        <button class="btn-search" style="width:100%;" onclick="_destroyModal();addToPortfolioFromSearch(${index},${isSealed})">
          + Add to Portfolio
        </button>
      </div>
    </div>`;

  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  _destroyModal();
}

function _destroyModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

function addToPortfolioFromSearch(index, isSealed) {
  const r = _searchResults[index];
  if (!r) return;
  openPortfolioAddModal(r, isSealed);
}

// ══════════════════════════════════════════════════════════════════
//  CARD DETAIL MODAL (Portfolio — click card row)
// ══════════════════════════════════════════════════════════════════

async function openCardDetailModal(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;

  const overlay = document.getElementById('card-detail-overlay');
  const content = document.getElementById('card-detail-content');

  const thumb = item.imageUrl || '';
  const langFlag = item.language === 'japanese' ? ' 🇯🇵' : '';
  const cost = Number(item.purchasePrice) * (item.quantity || 1);
  const val  = item.currentValue != null ? Number(item.currentValue) * (item.quantity || 1) : null;
  const profit = val != null ? val - cost : null;
  const profitStr = profit != null
    ? (profit >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(profit).toFixed(2)
    : '—';
  const profitClass = profit == null ? '' : (profit >= 0 ? 'profit-pos' : 'profit-neg');

  content.innerHTML = `
    <div style="padding:24px 28px 0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--text);">${esc(item.name)}${langFlag}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:4px;font-family:var(--font-mono);">${esc(item.set||'—')} · ${esc(item.conditionOrGrade)} · ×${item.quantity||1}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--text3);">Cost → Value</div>
        <div style="font-family:var(--font-mono);font-size:14px;font-weight:600;">SGD $${cost.toFixed(2)} → ${val!=null?'SGD $'+val.toFixed(2):'—'}</div>
        <div class="${profitClass}" style="font-family:var(--font-mono);font-size:13px;font-weight:700;">${profitStr}</div>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="card-detail-tabs" style="padding:0 28px;margin-top:16px;">
      <button class="card-detail-tab active" id="cd-tab-chart" onclick="switchCardDetailTab('chart')">📈 Price Chart</button>
      <button class="card-detail-tab" id="cd-tab-image" onclick="switchCardDetailTab('image')">🃏 Card Image</button>
    </div>

    <!-- Chart pane -->
    <div id="cd-pane-chart" style="padding:20px 28px 28px;">
      <div id="cd-chart-loading" style="text-align:center;padding:40px;color:var(--text3);">
        <div class="spinner"></div>
        <div style="margin-top:12px;font-size:13px;">Loading price history…</div>
      </div>
      <canvas id="cd-chart-canvas" style="display:none;max-height:340px;"></canvas>
      <div id="cd-chart-empty" style="display:none;text-align:center;padding:40px;color:var(--text3);">No price history data available yet.<br><span style="font-size:12px;">Data accumulates as you refresh your portfolio values.</span></div>
    </div>

    <!-- Image pane -->
    <div id="cd-pane-image" style="display:none;padding:20px 28px 28px;text-align:center;">
      ${thumb
        ? `<img src="${esc(thumb)}" alt="${esc(item.name)}" style="max-width:100%;max-height:500px;object-fit:contain;border-radius:var(--r-md);box-shadow:var(--shadow-card);" />`
        : `<div style="padding:60px;color:var(--text3);font-size:40px;">🃏</div>`
      }
    </div>
  `;

  overlay.classList.add('active');
  await loadCardPriceHistory(item);
}

function switchCardDetailTab(tab) {
  document.getElementById('cd-tab-chart').classList.toggle('active', tab === 'chart');
  document.getElementById('cd-tab-image').classList.toggle('active', tab === 'image');
  document.getElementById('cd-pane-chart').style.display = tab === 'chart' ? 'block' : 'none';
  document.getElementById('cd-pane-image').style.display = tab === 'image' ? 'block' : 'none';
}

async function loadCardPriceHistory(item) {
  const loadingEl = document.getElementById('cd-chart-loading');
  const canvasEl  = document.getElementById('cd-chart-canvas');
  const emptyEl   = document.getElementById('cd-chart-empty');

  if (!loadingEl || !canvasEl) return;

  try {
    const { data: rows, error } = await _sb
      .from('price_history_cache')
      .select('recorded_date, price')
      .eq('item_id', item.itemId)
      .order('recorded_date', { ascending: true });

    if (!error && rows && rows.length > 1) {
      renderCardChart(canvasEl, loadingEl, emptyEl, rows, item.name);
      return;
    }
  } catch(e) { console.warn('Cache fetch failed:', e); }

  try {
    const isSealed = item.type === 'sealed';
    const lang = item.language || 'english';
    let params;
    if (isSealed) {
      params = new URLSearchParams({ action: 'sealed', language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
      params.set('name', item.name);
    } else {
      params = new URLSearchParams({ action: 'search', name: item.name, language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
      if (item.set) params.set('set', item.set);
    }

    const res  = await fetch('/api/pokeprice?' + params);
    const data = await res.json();
    const results = data.results || [];

    if (!results.length) { showCardChartEmpty(loadingEl, canvasEl, emptyEl); return; }

    const r = results[0];
    const history = r.priceHistory || r.history || [];
    if (history.length < 2) {
      const price = extractResultPrice(r, isSealed);
      if (price != null) {
        const today = new Date().toISOString().split('T')[0];
        renderCardChart(canvasEl, loadingEl, emptyEl, [{ recorded_date: today, price }], item.name);
      } else {
        showCardChartEmpty(loadingEl, canvasEl, emptyEl);
      }
      return;
    }

    const rows = history.map(h => ({
      recorded_date: h.date || h.recorded_date,
      price: Number(h.price || h.marketPrice || h.value || 0),
    })).filter(h => h.price > 0);

    renderCardChart(canvasEl, loadingEl, emptyEl, rows, item.name);
  } catch(e) {
    console.warn('Card history fetch failed:', e);
    showCardChartEmpty(loadingEl, canvasEl, emptyEl);
  }
}

function renderCardChart(canvasEl, loadingEl, emptyEl, rows, name) {
  loadingEl.style.display = 'none';
  if (!rows || rows.length === 0) { showCardChartEmpty(loadingEl, canvasEl, emptyEl); return; }
  const labels = rows.map(r => r.recorded_date);
  const values = rows.map(r => Number(r.price) * USD_TO_SGD);
  canvasEl.style.display = 'block';
  _cardDetailChart = destroyChart(_cardDetailChart);
  _cardDetailChart = new Chart(canvasEl, buildChartConfig(labels, values, name + ' (SGD)', '#00e5cc'));
}

function showCardChartEmpty(loadingEl, canvasEl, emptyEl) {
  if (loadingEl) loadingEl.style.display = 'none';
  if (canvasEl)  canvasEl.style.display  = 'none';
  if (emptyEl)   emptyEl.style.display   = 'block';
}

function closeCardDetailModal(e) {
  if (e && e.target !== document.getElementById('card-detail-overlay')) return;
  document.getElementById('card-detail-overlay').classList.remove('active');
  _cardDetailChart = destroyChart(_cardDetailChart);
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO CHART MODAL
// ══════════════════════════════════════════════════════════════════

async function openPortfolioChartModal() {
  const overlay  = document.getElementById('portfolio-chart-overlay');
  const loading  = document.getElementById('portfolio-chart-loading');
  const canvas   = document.getElementById('portfolio-chart-canvas');
  const errEl    = document.getElementById('portfolio-chart-error');

  loading.style.display = 'block';
  canvas.style.display  = 'none';
  errEl.style.display   = 'none';
  overlay.classList.add('active');

  _portfolioChart = destroyChart(_portfolioChart);

  const active = portfolioItems.filter(i => !i.sold);
  if (!active.length) {
    loading.style.display = 'none';
    errEl.style.display   = 'block';
    errEl.textContent     = 'No portfolio items to chart.';
    return;
  }

  try {
    const itemIds = active.map(i => i.itemId).filter(Boolean);
    const { data: rows, error } = await _sb
      .from('price_history_cache')
      .select('item_id, recorded_date, price')
      .in('item_id', itemIds)
      .order('recorded_date', { ascending: true });

    if (error || !rows || rows.length === 0) {
      const today = new Date().toISOString().split('T')[0];
      const total = active.reduce((s, i) => s + (i.currentValue != null ? Number(i.currentValue) * (i.quantity||1) : Number(i.purchasePrice) * (i.quantity||1)), 0);
      if (total === 0) { loading.style.display = 'none'; errEl.style.display = 'block'; return; }
      renderPortfolioChart(canvas, loading, [{ date: today, value: total }]);
      return;
    }

    const dateMap = {};
    for (const row of rows) {
      const item = active.find(i => i.itemId === row.item_id);
      if (!item) continue;
      const qty = item.quantity || 1;
      const val = Number(row.price) * qty * USD_TO_SGD;
      if (!dateMap[row.recorded_date]) dateMap[row.recorded_date] = 0;
      dateMap[row.recorded_date] += val;
    }

    const dates = Object.keys(dateMap).sort();
    if (dates.length === 0) { loading.style.display = 'none'; errEl.style.display = 'block'; return; }

    renderPortfolioChart(canvas, loading, dates.map(d => ({ date: d, value: dateMap[d] })));
  } catch(e) {
    console.warn('Portfolio chart error:', e);
    loading.style.display = 'none';
    errEl.style.display   = 'block';
  }
}

function renderPortfolioChart(canvas, loading, points) {
  loading.style.display = 'none';
  canvas.style.display  = 'block';
  _portfolioChart = new Chart(canvas, buildChartConfig(
    points.map(p => p.date),
    points.map(p => p.value),
    'Portfolio Value (SGD)', '#7c6cff'
  ));
}

function closePortfolioChartModal(e) {
  if (e && e.target !== document.getElementById('portfolio-chart-overlay')) return;
  document.getElementById('portfolio-chart-overlay').classList.remove('active');
  _portfolioChart = destroyChart(_portfolioChart);
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO TAB — Search
// ══════════════════════════════════════════════════════════════════

function pfSetSearchLang(lang) {
  _pfSearchLang = lang;
  document.querySelectorAll('.pf-lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === lang));
}

function pfSetSearchType(type) {
  _pfSearchType = type;
  document.getElementById('pf-type-cards')?.classList.toggle('active',  type === 'cards');
  document.getElementById('pf-type-sealed')?.classList.toggle('active', type === 'sealed');
}

function pfSearchDebounce() {
  clearTimeout(_pfSearchDebounce);
  _pfSearchDebounce = setTimeout(pfSearch, 480);
}

async function pfSearch() {
  clearTimeout(_pfSearchDebounce);
  const raw       = (document.getElementById('pf-search-input')?.value || '').trim();
  const setFilter = (document.getElementById('pf-set-input')?.value || '').trim();
  const isSealed  = _pfSearchType === 'sealed';
  const resultsEl = document.getElementById('pf-search-results');

  if (!raw) {
    if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }
    return;
  }

  if (resultsEl) {
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<div class="pf-search-loading">Searching…</div>';
  }

  try {
    let params;
    if (isSealed) {
      params = new URLSearchParams({ action: 'sealed', language: _pfSearchLang });
      params.set('name', raw);
      if (setFilter) params.set('set', setFilter);
    } else if (isCardNumber(raw)) {
      params = new URLSearchParams({ action: 'bynumber', name: raw, language: _pfSearchLang });
      if (setFilter) params.set('set', setFilter);
    } else {
      params = new URLSearchParams({ action: 'search', name: raw, language: _pfSearchLang });
      if (setFilter) params.set('set', setFilter);
    }

    const res  = await fetch('/api/pokeprice?' + params);
    const data = await res.json();
    _pfSearchResults = data.results || [];
    pfRenderSearchResults(_pfSearchResults, isSealed);
  } catch (e) {
    if (resultsEl) resultsEl.innerHTML = '<div class="pf-search-loading">Search failed — check connection</div>';
  }
}

function pfRenderSearchResults(results, isSealed) {
  const box = document.getElementById('pf-search-results');
  if (!box) return;
  if (!results.length) {
    box.style.display = 'block';
    box.innerHTML = '<div class="pf-search-loading">No results found</div>';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = results.slice(0, 20).map((r, i) => {
    const thumb    = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
    const priceUSD = extractResultPrice(r, isSealed);
    const priceTxt = priceUSD != null ? `SGD $${(priceUSD * USD_TO_SGD).toFixed(2)}` : '';
    const imgEl = thumb
      ? `<img src="${esc(thumb)}" style="width:34px;height:48px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
      : `<span style="width:34px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px;">${isSealed?'📦':'🃏'}</span>`;
    const sub = isSealed
      ? esc(r.setName||'—')
      : `${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}${r.rarity?' · '+esc(r.rarity):''}`;
    return `<div class="pf-result-row" onclick="pfPickResult(${i},${isSealed})">
      ${imgEl}
      <div class="pf-result-info">
        <div class="pf-result-name">${esc(r.name)}</div>
        <div class="pf-result-sub">${sub}</div>
      </div>
      <div class="pf-result-right">
        <span class="pf-result-price">${esc(priceTxt)}</span>
        <button class="btn-add-portfolio" onclick="event.stopPropagation();pfPickResult(${i},${isSealed})">+ Portfolio</button>
      </div>
    </div>`;
  }).join('');
}

function pfPickResult(index, isSealed) {
  const r = _pfSearchResults[index];
  if (!r) return;
  const box = document.getElementById('pf-search-results');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  document.getElementById('pf-search-input').value = '';
  const setInp = document.getElementById('pf-set-input');
  if (setInp) setInp.value = '';
  openPortfolioAddModal(r, isSealed);
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO ADD MODAL
// ══════════════════════════════════════════════════════════════════

function openPortfolioAddModal(apiResult, isSealed) {
  if (!apiResult) return;
  _portfolioAddResult = { result: apiResult, isSealed };

  const priceUSD = extractResultPrice(apiResult, isSealed);
  const priceSGD = priceUSD != null ? (priceUSD * USD_TO_SGD).toFixed(2) : '';

  document.getElementById('pf-item-name').textContent  = apiResult.name || '—';
  document.getElementById('pf-item-set').textContent   = apiResult.setName || '—';
  document.getElementById('pf-item-type').textContent  = isSealed ? '📦 Sealed Product' : '🃏 Card';

  const imgEl = document.getElementById('pf-item-img');
  const thumb = apiResult.imageCdnUrl200 || apiResult.imageCdnUrl400 || apiResult.imageCdnUrl || '';
  if (imgEl) { imgEl.src = thumb; imgEl.style.display = thumb ? 'block' : 'none'; }

  document.getElementById('pf-purchase-price').value = priceSGD;
  document.getElementById('pf-quantity').value       = '1';
  document.getElementById('pf-notes').value          = '';

  const gradeEl = document.getElementById('pf-condition');
  if (gradeEl) {
    gradeEl.innerHTML = isSealed
      ? `<option value="Sealed">Sealed / Unopened</option><option value="Opened">Opened</option>`
      : `<option value="Near Mint">Near Mint</option>
         <option value="Lightly Played">Lightly Played</option>
         <option value="Moderately Played">Moderately Played</option>
         <option value="Heavily Played">Heavily Played</option>
         <option value="Damaged">Damaged</option>
         <option value="PSA 10">PSA 10</option>
         <option value="PSA 9">PSA 9</option>
         <option value="PSA 8">PSA 8</option>
         <option value="BGS 10">BGS 10</option>
         <option value="BGS 9.5">BGS 9.5</option>`;
  }

  document.getElementById('portfolio-add-overlay').classList.add('active');
  setTimeout(() => document.getElementById('pf-purchase-price')?.focus(), 100);
}

function closePortfolioAddModal() {
  document.getElementById('portfolio-add-overlay').classList.remove('active');
  _portfolioAddResult = null;
}

async function savePortfolioItem() {
  const { result: r, isSealed } = _portfolioAddResult || {};
  if (!r) return;

  const purchasePrice    = parseFloat(document.getElementById('pf-purchase-price').value);
  const quantity         = parseInt(document.getElementById('pf-quantity').value, 10) || 1;
  const conditionOrGrade = document.getElementById('pf-condition').value;
  const notes            = document.getElementById('pf-notes').value.trim();

  if (!purchasePrice || purchasePrice <= 0) { toast('Please enter a valid purchase price.', 'error'); return; }

  const imgUrl = r.imageCdnUrl || r.imageCdnUrl400 || r.imageCdnUrl200 || null;
  const itemId = String(r.tcgPlayerId || r.id || r.productId || crypto.randomUUID());

  // ── Graded price lookup ───────────────────────────────────────────
  // API returns graded data as r.ebay.psa10.avg, r.ebay.psa9.avg, r.ebay.bgs9_5.avg etc.
  // extractGradedPrice() converts "PSA 10" → key "psa10" and reads .smartMarketPrice ?? .avg
  let currentValueSGD = null;

  const isGraded = !isSealed && /^(PSA|BGS|CGC)\s+/i.test(conditionOrGrade);

  if (isGraded) {
    // Check the result object already in memory first (no extra API call needed if ebay data is present)
    const gradedUSD = extractGradedPrice(r, conditionOrGrade);
    if (gradedUSD != null) {
      currentValueSGD = Math.round(gradedUSD * USD_TO_SGD * 100) / 100;
    }

    // If the initial search didn't include eBay data, fetch it now with includeEbay=true
    if (currentValueSGD == null) {
      try {
        const params = new URLSearchParams({
          action:      'search',
          name:        r.name,
          language:    _pfSearchLang,
          includeEbay: 'true',
        });
        if (r.setName) params.set('set', r.setName);
        if (r.tcgPlayerId) params.set('tcgPlayerId', String(r.tcgPlayerId));

        const res  = await fetch('/api/pokeprice?' + params);
        const data = await res.json();
        const liveResult = (data.results || [])[0];
        if (liveResult) {
          const gradedUSD2 = extractGradedPrice(liveResult, conditionOrGrade);
          if (gradedUSD2 != null) currentValueSGD = Math.round(gradedUSD2 * USD_TO_SGD * 100) / 100;
        }
      } catch (e) { console.warn('Graded price live fetch failed:', e); }
    }
  }

  // Fall back to raw market price if not graded or no graded price found
  if (currentValueSGD == null) {
    const priceUSD = extractResultPrice(r, isSealed);
    currentValueSGD = priceUSD != null ? Math.round(priceUSD * USD_TO_SGD * 100) / 100 : null;
  }

  const row = {
    user_id:            _currentUserId,
    item_id:            itemId,
    type:               isSealed ? 'sealed' : 'card',
    name:               r.name || '—',
    set_name:           r.setName || null,
    image_url:          imgUrl,
    purchase_price:     purchasePrice,
    quantity,
    condition_or_grade: conditionOrGrade,
    language:           _pfSearchLang,
    notes:              notes || null,
    current_value:      currentValueSGD,
    last_value_updated: currentValueSGD ? new Date().toISOString() : null,
  };

  const { data, error } = await _sb.from('portfolio_items').insert([row]).select().single();
  if (error) { toast('Failed to save: ' + error.message, 'error'); return; }

  portfolioItems.push(dbToPortfolioItem(data));
  closePortfolioAddModal();
  renderPortfolio();
  updateSearchTabVisibility();
  toast(`${r.name} added to portfolio.`, 'success');
  switchMainTab('portfolio');
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO — Load & Render
// ══════════════════════════════════════════════════════════════════

async function loadPortfolioItems() {
  const { data, error } = await _sb.from('portfolio_items').select('*')
    .eq('user_id', _currentUserId).order('created_at', { ascending: true });
  if (error) { console.error('loadPortfolioItems error:', error); return; }
  portfolioItems = data.map(dbToPortfolioItem);
  renderPortfolio();
  updateSearchTabVisibility();
}

function renderPortfolio() {
  const tbody = document.getElementById('portfolio-table');
  if (!tbody) return;

  const active = portfolioItems.filter(i => !i.sold);

  const totalCost  = active.reduce((s, i) => s + Number(i.purchasePrice) * (i.quantity||1), 0);
  const totalValue = active.reduce((s, i) => {
    const val = i.currentValue != null ? Number(i.currentValue) : Number(i.purchasePrice);
    return s + val * (i.quantity||1);
  }, 0);
  const totalPL = totalValue - totalCost;
  const roi     = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  const metricCost  = document.getElementById('pf-metric-cost');
  const metricValue = document.getElementById('pf-metric-value');
  const metricPL    = document.getElementById('pf-metric-pl');
  const metricROI   = document.getElementById('pf-metric-roi');

  if (metricCost)  metricCost.textContent  = 'SGD $' + totalCost.toFixed(2);
  if (metricValue) animateValue(metricValue, totalValue, 'SGD ');
  if (metricPL) {
    metricPL.textContent = (totalPL >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(totalPL).toFixed(2);
    metricPL.className   = 'pf-metric-val ' + (totalPL >= 0 ? 'profit-pos' : 'profit-neg');
  }
  if (metricROI) {
    metricROI.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
    metricROI.className   = 'pf-metric-val ' + (roi >= 0 ? 'profit-pos' : 'profit-neg');
  }

  if (!active.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">No items in portfolio — use the search above to add cards or sealed products</div></td></tr>';
    return;
  }

  tbody.innerHTML = active.map(item => {
    const cost      = Number(item.purchasePrice) * (item.quantity||1);
    const val       = item.currentValue != null ? Number(item.currentValue) * (item.quantity||1) : null;
    const profit    = val != null ? val - cost : null;
    const profitStr = profit != null
      ? (profit >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(profit).toFixed(2)
      : '—';
    const profitClass = profit == null ? '' : (profit >= 0 ? 'profit-pos' : 'profit-neg');
    const typeIcon    = item.type === 'sealed' ? '📦' : '🃏';
    const thumb       = item.imageUrl;
    const imgEl       = thumb
      ? `<img src="${esc(thumb)}" style="width:28px;height:40px;object-fit:contain;border-radius:3px;vertical-align:middle;margin-right:8px;cursor:pointer;" onclick="event.stopPropagation();openCardDetailModal('${item.id}')" title="View card" />`
      : `<span style="margin-right:8px;">${typeIcon}</span>`;
    const langFlag = item.language === 'japanese' ? ' 🇯🇵' : '';

    return `<tr class="pf-row-clickable" onclick="openCardDetailModal('${item.id}')" title="View chart & details">
      <td style="font-weight:600;">${imgEl}${esc(item.name)}${langFlag}</td>
      <td style="color:var(--text2);">${esc(item.set||'—')}</td>
      <td><span class="badge badge-raw">${esc(item.conditionOrGrade)}</span></td>
      <td style="font-family:var(--font-mono);">×${item.quantity||1}</td>
      <td style="font-family:var(--font-mono);">SGD $${cost.toFixed(2)}</td>
      <td style="font-family:var(--font-mono);">${val != null ? 'SGD $'+val.toFixed(2) : '<span style="color:var(--text3);">—</span>'}</td>
      <td class="${profitClass}" style="font-family:var(--font-mono);font-weight:600;">${profitStr}</td>
      <td><button class="del-btn" onclick="event.stopPropagation();deletePortfolioItem('${item.id}')" title="Remove">✕</button></td>
    </tr>`;
  }).join('');
}

async function deletePortfolioItem(id) {
  const item = portfolioItems.find(i => i.id === id);
  if (!await confirmDialog('Remove "' + (item?.name ?? 'this item') + '" from your portfolio?')) return;
  const { error } = await _sb.from('portfolio_items').delete().eq('id', id).eq('user_id', _currentUserId);
  if (error) { toast('Failed to delete.', 'error'); return; }
  portfolioItems = portfolioItems.filter(i => i.id !== id);
  renderPortfolio();
  toast('Item removed from portfolio.', 'info');
}

// ── Refresh portfolio current values ─────────────────────────────
async function refreshPortfolioValues(silent = false) {
  const active = portfolioItems.filter(i => !i.sold);
  if (!active.length) { if (!silent) toast('No items to refresh.', 'info'); return; }

  const btn = document.querySelector('.btn-refresh-small');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }

  let updated = 0;

  for (const item of active) {
    try {
      const lang     = item.language || 'english';
      const isSealed = item.type === 'sealed';
      let params;

      if (isSealed) {
        params = new URLSearchParams({
          action: 'sealed', language: lang,
          includeHistory: 'true', days: String(_allowedHistoryDays),
        });
        params.set('name', item.name);
      } else {
        params = new URLSearchParams({
          action: 'search', name: item.name, language: lang,
          includeHistory: 'true', days: String(_allowedHistoryDays),
        });
        if (item.set) params.set('set', item.set);
      }

      const res = await fetch('/api/pokeprice?' + params);
      if (!res.ok) continue;
      const d       = await res.json();
      const results = d.results || [];
      if (!results.length) continue;

      // ── Graded price lookup during refresh ────────────────────────
      // API returns r.ebay.psa10.avg etc. extractGradedPrice() reads this correctly.
      // conditionOrGrade is "PSA 10", "BGS 9.5" etc — stored in the DB from when it was saved.
      let priceSGD = null;
      const isGraded = !isSealed && /^(PSA|BGS|CGC)\s+/i.test(item.conditionOrGrade || '');

      if (isGraded) {
        const gradedUSD = extractGradedPrice(results[0], item.conditionOrGrade);
        if (gradedUSD != null) priceSGD = Math.round(gradedUSD * USD_TO_SGD * 100) / 100;
      }

      // Fall back to raw market price if not graded or no graded price returned
      if (priceSGD == null) {
        const priceUSD = extractResultPrice(results[0], isSealed);
        if (priceUSD == null) continue;
        priceSGD = Math.round(priceUSD * USD_TO_SGD * 100) / 100;
      }

      await _sb.from('portfolio_items')
        .update({ current_value: priceSGD, last_value_updated: new Date().toISOString() })
        .eq('id', item.id).eq('user_id', _currentUserId);

      const idx = portfolioItems.findIndex(i => i.id === item.id);
      if (idx > -1) portfolioItems[idx] = { ...portfolioItems[idx], currentValue: priceSGD };
      updated++;
    } catch (e) { console.warn('Portfolio refresh failed for', item.name, e); }
    await new Promise(r => setTimeout(r, 350));
  }

  renderPortfolio();
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh values'; }
  if (!silent) {
    toast(updated ? `Updated ${updated} item${updated !== 1 ? 's' : ''}.` : 'No prices found.', updated ? 'success' : 'info');
  }
}

// ── Keyboard shortcut ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['modal-overlay', 'confirm-overlay', 'portfolio-add-overlay', 'card-detail-overlay', 'portfolio-chart-overlay']
    .forEach(id => document.getElementById(id)?.classList.remove('active'));
  _cardDetailChart  = destroyChart(_cardDetailChart);
  _portfolioChart   = destroyChart(_portfolioChart);
});

// ── Bootstrap ─────────────────────────────────────────────────────
init();
