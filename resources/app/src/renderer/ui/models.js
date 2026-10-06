import { api, unwrap } from '../core/api.js';
import { $, $$, escapeHtml } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { showToast } from './common.js';

const PROV_LABEL = { trae: 'Trae', workbuddy: 'WorkBuddy' };
const MODEL_LABEL = {
  'glm-4.5': 'GLM 4.5',
  'glm-4.6': 'GLM 4.6',
  'glm-5.3': 'GLM 5.3',
  'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
  'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
  'claude-sonnet-4': 'Claude Sonnet 4',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-opus-4-1': 'Claude Opus 4.1',
  'deepseek-v3': 'DeepSeek V3',
  'deepseek-v3-1': 'DeepSeek V3.1',
  'deepseek-r1': 'DeepSeek R1',
  'doubao-pro': 'Doubao Pro',
  'kimi-k2': 'Kimi K2',
  'gpt-5': 'GPT-5',
  'gpt-5-codex': 'GPT-5 Codex',
  'gemini-3-pro': 'Gemini 3 Pro',
};

function displayLabel(id) {
  return MODEL_LABEL[id] || id;
}

let modelsData = null;
let filter = { provider: 'all', search: '', onlyAvailable: false };
let loading = false;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('common.copied'));
  } catch {
    showToast(t('common.copyFailed'), true);
  }
}

async function fetchModels(force = false) {
  if (modelsData && !force) return modelsData;
  if (loading) return modelsData;
  loading = true;
  $('#btn-models-refresh').disabled = true;
  try {
    modelsData = await unwrap(api.gateway.getModels());
  } finally {
    loading = false;
    $('#btn-models-refresh').disabled = false;
  }
  return modelsData;
}

function collectRows() {
  const rows = [];
  for (const prov of modelsData || []) {
    for (const m of prov.models || []) {
      if (!m.id) continue;
      rows.push({
        id: m.id,
        label: m.name || displayLabel(m.id),
        provider: prov.provider,
        provLabel: PROV_LABEL[prov.provider] || prov.provider,
        enabled: prov.enabled,
        available: prov.available,
        variants: [m.id, `${prov.provider}:${m.id}`],
      });
    }
  }
  return rows;
}

function applyFilter(rows) {
  const kw = filter.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.provider !== 'all' && r.provider !== filter.provider) return false;
    if (filter.onlyAvailable && r.available <= 0) return false;
    if (!kw) return true;
    return (
      r.id.toLowerCase().includes(kw) ||
      r.label.toLowerCase().includes(kw) ||
      r.provLabel.toLowerCase().includes(kw)
    );
  });
}

function renderModels() {
  const box = $('#models-list');
  if (!box) return;
  if (!modelsData) {
    box.innerHTML = `<p class="muted">${t('common.loading')}</p>`;
    return;
  }
  const rows = applyFilter(collectRows());
  const countEl = $('#models-count');
  if (countEl) countEl.textContent = t('models.count', { count: rows.length });

  if (!rows.length) {
    box.innerHTML = `<p class="muted">${t('models.empty')}</p>`;
    return;
  }
  box.innerHTML = rows.map((r) => `
    <div class="model-row" data-id="${escapeHtml(r.id)}" data-provider="${escapeHtml(r.provider)}">
      <div class="model-main">
        <span class="model-name">${escapeHtml(r.label)}</span>
        <code class="model-id" title="${escapeHtml(r.id)}">${escapeHtml(r.id)}</code>
      </div>
      <div class="model-side">
        <span class="model-prov-badge prov-${escapeHtml(r.provider)}">${escapeHtml(r.provLabel)}</span>
        <span class="model-avail ${r.available > 0 ? 'gw-ok-text' : 'gw-bad-text'}" title="${t('models.availTip')}">
          ${t('models.avail', { count: r.available })}
        </span>
        <button type="button" class="btn btn-ghost btn-copy model-copy" data-id="${escapeHtml(r.id)}">${t('common.copy')}</button>
      </div>
    </div>
  `).join('');
}

function readFilterUI() {
  filter.search = $('#models-search')?.value || '';
  filter.onlyAvailable = !!$('#models-only-available')?.checked;
  const active = $('.filter-chip[data-provider].active');
  filter.provider = active?.dataset.provider || 'all';
}

export async function loadModelsPage(force = false) {
  await fetchModels(force);
  readFilterUI();
  renderModels();
}

export function initModelsEvents() {
  let raf = 0;
  $('#models-search')?.addEventListener('input', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      readFilterUI();
      renderModels();
    });
  });

  $$('.filter-chip[data-provider]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.filter-chip[data-provider]').forEach((c) => c.classList.toggle('active', c === chip));
      readFilterUI();
      renderModels();
    });
  });

  $('#models-only-available')?.addEventListener('change', () => {
    readFilterUI();
    renderModels();
  });

  $('#btn-models-refresh')?.addEventListener('click', async () => {
    try {
      await loadModelsPage(true);
      showToast(t('models.refreshed'));
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('#models-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.model-copy');
    if (!btn) return;
    copyText(btn.dataset.id || '');
  });
}
