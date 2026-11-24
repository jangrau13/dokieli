/*!
Copyright 2012-2026 Sarven Capadisli <https://csarven.ca/>
Copyright 2023-2026 Virginia Balseiro <https://virginiabalseiro.com/>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Agent setup: the document's agent, the knowledge graphs it draws on (dl#document-sources) and the ontologies its
// data conforms to (dl#document-ontologies), each added and removed in the editor. Ontologies are found on Linked
// Open Vocabularies, knowledge graphs in the agent's catalog.

import Config from './config.js';
import { i18n } from './i18n.js';
import { createAgentHTML, createDataSourcesHTML, createOntologiesHTML } from './doc.js';
import { getResource } from './fetcher.js';
import { requestOriginConsent } from './consent.js';
import { storageFetch } from './storage/backend.js';
import { ensureDocumentPrefixes } from './table.js';
import { htmlEncode } from './utils/sanitization.js';
import { fragmentFromString } from './utils/html.js';
import { getButtonHTML } from './ui/buttons.js';
import { getDocumentItemEntries, setDocumentItem } from './editor/slashmenu/handlers.js';

export const DOCUMENT_ITEMS = {
  agent: { id: 'document-agent', rel: 'schema:agent', prefix: 'schema', html: (urls) => createAgentHTML(urls[0]) },
  sources: { id: 'document-sources', rel: 'dcterms:source', prefix: 'dcterms', html: createDataSourcesHTML },
  ontologies: { id: 'document-ontologies', rel: 'dcterms:conformsTo', prefix: 'dcterms', html: createOntologiesHTML }
};

export const LOV_AUTOCOMPLETE_URL = 'https://lov.linkeddata.es/dataset/api/v2/vocabulary/autocomplete';

function editorView() {
  return Config.Editor?.editorView;
}

export function getItemURLs(kind, view = editorView()) {
  const { id, rel } = DOCUMENT_ITEMS[kind];
  return view ? getDocumentItemEntries(view.state.doc, id, rel) : [];
}

function writeItem(kind, urls, view) {
  const { id, prefix, html } = DOCUMENT_ITEMS[kind];
  setDocumentItem(view, id, urls.length ? html(urls) : '');
  if (urls.length) ensureDocumentPrefixes([prefix]);
}

// Absolute addresses only, so they hold wherever the document is stored or copied
export function addItemURL(kind, url, view = editorView()) {
  let href;
  try { href = new URL(String(url).trim()).href; } catch { return false; }

  const urls = kind === 'agent' ? [href] : [...getItemURLs(kind, view).filter(u => u !== href), href];
  writeItem(kind, urls, view);
  return true;
}

export function removeItemURL(kind, url, view = editorView()) {
  writeItem(kind, getItemURLs(kind, view).filter(u => u !== url), view);
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

// Vocabularies matching the query: prefix, title and namespace
export async function searchOntologies(query, { fetch } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const url = `${LOV_AUTOCOMPLETE_URL}?q=${encodeURIComponent(q)}`;
  if (!(await requestOriginConsent(url, { reason: 'search' }))) return [];

  const headers = { 'Accept': 'application/json' };
  // A public service: the user's credentials stay home
  const response = fetch ? await fetch(url, { headers }) : await getResource(url, headers, { withoutSignIn: true });
  const data = await response.json();

  const language = (Config.User?.UI?.Language || 'en').split('-')[0];

  return (data?.results || []).map((r) => ({
    uri: first(r.uri),
    prefix: first(r.prefix) || '',
    title: first(r[`http://purl.org/dc/terms/title@${language}`]) || first(r['http://purl.org/dc/terms/title@en']) || first(r['http://purl.org/dc/terms/title']) || ''
  })).filter(r => r.uri);
}

function textOf(value) {
  value = first(value);
  return typeof value === 'string' ? value : (value?.['@value'] || '');
}

function iriOf(value) {
  value = first(value);
  return typeof value === 'string' ? value : (value?.id || value?.['@id'] || '');
}

function datasetsOf(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['@graph', 'items', 'orderedItems', 'itemListElement', 'dataset', 'datasets']) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  return [];
}

// The agent's catalog address for a search: <agent>/knowledge-graphs?q=
export function catalogSearchURL(agent, query) {
  const url = new URL(agent);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '') + '/knowledge-graphs';
  url.searchParams.set('q', query);
  return url.href;
}

// Knowledge graphs in the agent's catalog: name, description, address (SPARQL endpoint or RDF document) and kind
export async function searchKnowledgeGraphs(agent, query, { fetch = storageFetch } = {}) {
  const q = String(query || '').trim();
  if (!agent || !q) return [];

  if (!(await requestOriginConsent(agent, { reason: 'agent', ask: true }))) return [];

  const url = catalogSearchURL(agent, q);
  const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/ld+json, application/json;q=0.9' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || ''}`.trim());
  }

  return datasetsOf(await response.json()).map((d) => ({
    name: textOf(d.name ?? d['schema:name'] ?? d.title ?? d['dcterms:title']),
    description: textOf(d.description ?? d['schema:description'] ?? d['dcterms:description']),
    url: iriOf(d.sparqlEndpoint ?? d['void:sparqlEndpoint'] ?? d.endpoint ?? d.dataDump ?? d['void:dataDump'] ?? d.url ?? d.contentUrl ?? d.id ?? d['@id']),
    kind: textOf(d.kind)
  })).filter(d => d.url);
}

function entriesHTML(kind, urls) {
  if (!urls.length) {
    return `<li data-i18n="dialog.agent-setup.none.li">${i18n.t('dialog.agent-setup.none.li.textContent')}</li>`;
  }

  return urls.map(url => `<li><a dir="ltr" href="${htmlEncode(url, { mode: 'attribute' })}" rel="noopener" target="_blank">${htmlEncode(url)}</a> <button class="agent-setup-remove" data-i18n="dialog.agent-setup.remove.button" data-kind="${kind}" data-url="${htmlEncode(url, { mode: 'attribute' })}" type="button">${i18n.t('dialog.agent-setup.remove.button.textContent')}</button></li>`).join('');
}

function addButtonHTML(kind, url) {
  return `<button class="agent-setup-add" data-i18n="dialog.agent-setup.add.button" data-kind="${kind}" data-url="${htmlEncode(url, { mode: 'attribute' })}" type="button">${i18n.t('dialog.agent-setup.add.button.textContent')}</button>`;
}

export function ontologyResultHTML(r) {
  return `<li><strong>${htmlEncode(r.prefix)}</strong> ${htmlEncode(r.title)} <code dir="ltr">${htmlEncode(r.uri)}</code> ${addButtonHTML('ontologies', r.uri)}</li>`;
}

export function knowledgeGraphResultHTML(d) {
  return `<li><strong>${htmlEncode(d.name || d.url)}</strong>${d.kind ? ` <span class="agent-setup-kind">${htmlEncode(d.kind)}</span>` : ''}${d.description ? ` <span>${htmlEncode(d.description)}</span>` : ''} <code dir="ltr">${htmlEncode(d.url)}</code> ${addButtonHTML('sources', d.url)}</li>`;
}

function sectionHTML(kind, { search = '' } = {}) {
  return `
      <section aria-labelledby="agent-setup-${kind}-label" data-kind="${kind}">
        <h3 data-i18n="dialog.agent-setup.${kind}.h3" id="agent-setup-${kind}-label">${i18n.t(`dialog.agent-setup.${kind}.h3.textContent`)}</h3>
        <ul class="agent-setup-entries"></ul>
        ${search}
        <form class="agent-setup-url">
          <label data-i18n="dialog.agent-setup.${kind}.url.label" for="agent-setup-${kind}-url">${i18n.t(`dialog.agent-setup.${kind}.url.label.textContent`)}</label>
          <input dir="ltr" id="agent-setup-${kind}-url" name="url" pattern="${kind === 'agent' ? 'https://.+' : 'https?://.+'}" placeholder="${i18n.t('editor.toolbar.form.url.input.placeholder')}" required="" type="url" value="" />
          <button data-i18n="dialog.agent-setup.add.button" type="submit">${i18n.t('dialog.agent-setup.add.button.textContent')}</button>
        </form>
      </section>`;
}

function searchHTML(kind) {
  return `
        <form class="agent-setup-search">
          <label data-i18n="dialog.agent-setup.${kind}.search.label" for="agent-setup-${kind}-search">${i18n.t(`dialog.agent-setup.${kind}.search.label.textContent`)}</label>
          <input id="agent-setup-${kind}-search" name="q" required="" type="search" value="" />
          <button data-i18n="dialog.agent-setup.search.button" type="submit">${i18n.t('dialog.agent-setup.search.button.textContent')}</button>
        </form>
        <ul aria-live="polite" class="agent-setup-results"></ul>`;
}

export function agentSetupPanelHTML() {
  const buttonClose = getButtonHTML({ key: 'dialog.agent-setup.close.button', button: 'close', buttonClass: 'close', iconSize: 'fa-2x' });

  return `
    <aside aria-labelledby="agent-setup-label" class="do on" dir="${Config.User.UI.LanguageDir}" id="agent-setup" lang="${Config.User.UI.Language}" rel="schema:hasPart" resource="#agent-setup" xml:lang="${Config.User.UI.Language}">
      <h2 data-i18n="dialog.agent-setup.h2" id="agent-setup-label" property="schema:name">${i18n.t('dialog.agent-setup.h2.textContent')}</h2>
      ${buttonClose}
      ${sectionHTML('agent')}
      ${sectionHTML('sources', { search: searchHTML('sources') })}
      ${sectionHTML('ontologies', { search: searchHTML('ontologies') })}
    </aside>`;
}

function renderEntries(panel) {
  Object.keys(DOCUMENT_ITEMS).forEach((kind) => {
    panel.querySelector(`section[data-kind="${kind}"] .agent-setup-entries`).replaceChildren(fragmentFromString(entriesHTML(kind, getItemURLs(kind))));
  });
}

function showResults(list, html) {
  list.replaceChildren(fragmentFromString(html));
}

async function search(kind, query, list) {
  showResults(list, `<li data-i18n="dialog.agent-setup.searching.li">${i18n.t('dialog.agent-setup.searching.li.textContent')}</li>`);

  try {
    let html;
    if (kind === 'ontologies') {
      html = (await searchOntologies(query)).map(ontologyResultHTML).join('');
    }
    else {
      const agent = getItemURLs('agent')[0];
      if (!agent) {
        showResults(list, `<li data-i18n="dialog.agent-setup.sources.no-agent.li">${i18n.t('dialog.agent-setup.sources.no-agent.li.textContent')}</li>`);
        return;
      }
      html = (await searchKnowledgeGraphs(agent, query)).map(knowledgeGraphResultHTML).join('');
    }
    showResults(list, html || `<li data-i18n="dialog.agent-setup.no-results.li">${i18n.t('dialog.agent-setup.no-results.li.textContent')}</li>`);
  }
  catch (error) {
    showResults(list, `<li data-i18n="dialog.agent-setup.search-failed.li">${i18n.t('dialog.agent-setup.search-failed.li.textContent', { error: error?.message || '' })}</li>`);
  }
}

// From the Document menu while editing
export function showAgentSetup() {
  if (Config.Editor?.mode !== 'author' || !editorView()) return null;

  document.getElementById('agent-setup')?.remove();
  document.body.appendChild(fragmentFromString(agentSetupPanelHTML()));

  const panel = document.getElementById('agent-setup');
  renderEntries(panel);

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.closest('section[data-kind]')?.dataset.kind;
    if (!kind) return;

    if (form.classList.contains('agent-setup-search')) {
      search(kind, form.querySelector('[name="q"]').value, form.parentNode.querySelector('.agent-setup-results'));
      return;
    }

    if (addItemURL(kind, form.querySelector('[name="url"]').value)) {
      form.reset();
      renderEntries(panel);
    }
  });

  panel.addEventListener('click', (e) => {
    const add = e.target.closest('button.agent-setup-add');
    const remove = e.target.closest('button.agent-setup-remove');
    if (add) {
      addItemURL(add.dataset.kind, add.dataset.url);
      add.disabled = true;
      renderEntries(panel);
    }
    else if (remove) {
      removeItemURL(remove.dataset.kind, remove.dataset.url);
      renderEntries(panel);
    }
  });

  return panel;
}
