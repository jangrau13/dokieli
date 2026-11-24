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

// The document's agent: a service named by the document (schema:agent) that takes requests at its inbox and works
// on the stored document. Its edits arrive as remote changes. The conversation with it is kept by the agent, apart
// from the document, and shows only in the agent panel, which a signed-in author opens while editing.

import rdf from 'rdf-ext';
import { discoverInbox, parseLinkTarget, postNotification } from '@dokieli/notifications';
import { getTextQuoteSelector, getFragmentSelector } from '@dokieli/web-annotation';
import Config from './config.js';
import { i18n } from './i18n.js';
import { addMessageToLog, getDocument, getResourceInfo, showActionMessage, updateMutableResource } from './doc.js';
import { getGraphFromData, getGraphAgent, getGraphSources, getGraphOntologies, jsonldNodesFromData } from './graph.js';
import { requestOriginConsent } from './consent.js';
import { storageFetch } from './storage/backend.js';
import { syncLocalRemoteResource, markLocalSnapshotPublished } from './sync.js';
import { getDocumentStorageURL } from './uri.js';
import { getDateTimeISO, getHash } from './util.js';
import { domSanitize, htmlEncode } from './utils/sanitization.js';
import { fragmentFromString, selectArticleNode } from './utils/html.js';
import { getButtonHTML } from './ui/buttons.js';
import { Icon } from './ui/icons.js';
import { annotationIgnoreSelector, getAnnotationContainer, getSelectedParentElement } from './editor/utils/annotation.js';
import { showUserIdentityInput } from './auth.js';

const documentOptions = () => ({
  ...Config.DOMProcessing,
  format: true,
  sanitize: true,
  normalize: true
});

// Entries of a document-level list as the document shows them, e.g. for the forms that edit them
export function getDocumentItemURLs(id, rel) {
  const article = selectArticleNode(document) || document.body;
  return Array.from(article.querySelectorAll(`#${id} [rel~="${rel}"]`))
    .filter(node => !node.closest('.do'))
    .map(node => node.getAttribute('href') || node.getAttribute('resource'))
    .filter(Boolean);
}

// The agent, data sources and ontologies, read from the document's own RDFa
export async function getDocumentAgentSetup(documentURL = Config.DocumentURL) {
  const data = getDocument(null, documentOptions());
  const g = await getGraphFromData(data, { subjectURI: documentURL, contentType: 'text/html' });
  const s = rdf.grapoi({ dataset: g.dataset }).node(rdf.namedNode(documentURL));

  return {
    agent: getGraphAgent(s),
    sources: getGraphSources(s),
    ontologies: getGraphOntologies(s)
  };
}

// Paragraphs at blank lines, line breaks within
export function promptToHTML(prompt) {
  return String(prompt).trim().split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p>${htmlEncode(paragraph).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

// A selection is told to the agent as a part of the document: the quoted text and the nearest element with an id
export function getAgentSelectionContext(range, documentURL = Config.DocumentURL) {
  if (!range || range.collapsed) return null;

  const container = getAnnotationContainer(getSelectedParentElement(range));
  if (!container) return null;

  const fragmentElement = container.closest('[id]');
  const options = { contextLength: Config.ContextLength, ignoreSelector: annotationIgnoreSelector };
  const { type, exact, prefix, suffix } = getTextQuoteSelector(range, fragmentElement || container, options);
  if (!exact.trim()) return null;

  const selector = [{ type, exact, prefix, suffix }];

  const fragment = fragmentElement && getFragmentSelector(fragmentElement, { climb: false });
  if (fragment) {
    selector.push({ type: fragment.type, value: fragment.value, conformsTo: fragment.conformsTo });
  }

  return { type: 'SpecificResource', source: documentURL, selector };
}

// Where the author is in the editor: the selected text, else the element with an id around the caret
export function getEditorSelectionContext(view, documentURL = Config.DocumentURL) {
  const article = selectArticleNode(document);
  const { from, to, empty } = view.state.selection;

  if (!empty) {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return article?.contains(range.commonAncestorContainer) ? getAgentSelectionContext(range, documentURL) : null;
  }

  const { node } = view.domAtPos(from);
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const target = element?.closest('[id]');
  if (!target || target === article || !article?.contains(target)) return null;

  const { type, value, conformsTo } = getFragmentSelector(target, { climb: false });
  return { type: 'SpecificResource', source: documentURL, selector: [{ type, value, conformsTo }] };
}

// The request as ActivityStreams JSON-LD, posted as it is; the actor is the signed-in author
export function createAgentRequest({ prompt, documentURL, actor, context, published }) {
  if (!actor) throw new Error('An agent request needs the WebID of the author making it');

  const request = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    'type': 'Create',
    'actor': actor
  };

  request['object'] = { 'type': 'Note', 'content': promptToHTML(prompt) };
  request['target'] = documentURL;

  if (context) request['context'] = context;

  request['published'] = published;

  return request;
}

function agentMessage(key, { type = 'info', timer = Config.ActionMessage.Timer, vars = {}, extra = '', clearId } = {}) {
  const content = `<span data-i18n="${key}">${i18n.t(`${key}.textContent`, vars)}</span>${extra}`;
  const message = { content, type, timer };
  addMessageToLog(message, Config.MessageLog);
  return showActionMessage(document.body, message, clearId ? { clearId } : {});
}

// The agent reads the stored document, so edits on screen are saved first
async function saveUnsavedChanges(documentURL) {
  const data = getDocument(null, documentOptions());
  if (Config.Resource[documentURL]?.digestSRI === await getHash(data)) return true;

  const storageURL = Config.DocumentAction === 'new' ? null : getDocumentStorageURL(documentURL);
  if (!storageURL) {
    agentMessage('agent.message.save-first', { type: 'error', timer: null });
    return false;
  }

  try {
    // Shows its own outcome
    await updateMutableResource(storageURL);
    await markLocalSnapshotPublished(documentURL);
  }
  catch (error) {
    agentMessage('agent.message.save-failed', { type: 'error', timer: null });
    return false;
  }

  // What was stored is the baseline the agent's changes are told apart from
  await getResourceInfo(getDocument(null, documentOptions()), { storeHash: true });

  return true;
}

// The document's agent once the author may talk to it: editing, signed in, and the agent's origin allowed
async function prepareAgent(documentURL) {
  if (Config.Editor?.mode !== 'author') return null;

  if (!Config.User.IRI) {
    showUserIdentityInput();
    return null;
  }

  const { agent } = await getDocumentAgentSetup(documentURL);

  if (!agent) {
    agentMessage('agent.message.no-agent', { type: 'warning' });
    Config.Editor.slashMenu?.showForm('agent');
    return null;
  }

  if (!await requestOriginConsent(agent, { reason: 'agent', ask: true })) {
    agentMessage('agent.message.declined', { type: 'warning' });
    return null;
  }

  return agent;
}

// Posts the request to the agent's inbox; the outcome, or null when nothing was sent
export async function sendAgentRequest({ prompt, context = null, agent = null }) {
  const documentURL = Config.DocumentURL;

  if (!prompt?.trim()) return null;

  agent = agent || await prepareAgent(documentURL);
  if (!agent) return null;

  if (!await saveUnsavedChanges(documentURL)) return null;

  const progressId = agentMessage('agent.message.sending', { timer: null, extra: ` ${Icon['.fas.fa-circle-notch.fa-spin.fa-fw']}` });

  let inbox;
  try {
    inbox = await discoverInbox(agent, { fetch: storageFetch, parser: jsonldNodesFromData });
  }
  catch (error) {
    inbox = null;
  }

  if (!inbox) {
    agentMessage('agent.message.no-inbox', { type: 'error', timer: null, vars: { agent }, clearId: progressId });
    return null;
  }

  const request = createAgentRequest({
    prompt,
    documentURL,
    actor: Config.User.IRI,
    context,
    published: getDateTimeISO()
  });

  let result;
  try {
    result = await postNotification(inbox, request, { fetch: storageFetch, contentType: Config.Agent.ContentType });
  }
  catch (error) {
    const reason = [error?.status, error?.message].filter(Boolean).join(' ');
    agentMessage('agent.message.failed', { type: 'error', timer: null, vars: { error: reason }, clearId: progressId });
    return null;
  }

  const key = result.outcome === 'created' ? 'agent.message.sent' : 'agent.message.accepted';

  agentMessage(key, {
    type: 'success',
    clearId: progressId,
    extra: ` <span data-i18n="agent.message.updates">${i18n.t('agent.message.updates.textContent')}</span>`
  });

  return { ...result, request };
}

const AS_REPLIES = 'https://www.w3.org/ns/activitystreams#replies';
const ACCEPT_ACTIVITY = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/activity+json;q=0.9, application/ld+json;q=0.8';

// The agent resource asked about one document
export function conversationRequestURL(agent, documentURL) {
  const url = new URL(agent);
  url.hash = '';
  url.searchParams.set('document', documentURL);
  return url.href;
}

function iriOf(value) {
  value = Array.isArray(value) ? value[0] : value;
  return typeof value === 'string' ? value : (value?.id || value?.['@id'] || null);
}

// The first value of an Activity Streams term, compacted, prefixed or expanded
function asValue(node, term) {
  return node?.[term] ?? node?.[`as:${term}`] ?? node?.[`https://www.w3.org/ns/activitystreams#${term}`];
}

// as:replies in a JSON-LD body: on the top node, or on a node in its @graph
export function conversationFromBody(json, baseURL) {
  const nodes = Array.isArray(json) ? json : [json, ...(Array.isArray(json?.['@graph']) ? json['@graph'] : [])];

  for (const node of nodes) {
    const iri = iriOf(asValue(node, 'replies'));
    if (iri) return new URL(iri, baseURL).href;
  }

  return null;
}

// Where the agent keeps its conversation about the document: the Link header, else the body
export async function discoverConversation(agent, documentURL, { fetch = storageFetch } = {}) {
  const url = conversationRequestURL(agent, documentURL);
  const response = await fetch(url, { method: 'GET', headers: { 'Accept': ACCEPT_ACTIVITY } });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || ''}`.trim());
  }

  const link = response.headers.get('Link');
  const fromLink = link ? parseLinkTarget(link, AS_REPLIES, response.url || url) : null;
  if (fromLink) return fromLink;

  try {
    return conversationFromBody(await response.json(), response.url || url);
  }
  catch {
    return null;
  }
}

function contentOf(note) {
  const content = asValue(note, 'content');
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : c?.['@value'] || '')).join('');
  return content?.['@value'] || '';
}

// One turn of the conversation as the panel shows it
export function normalizeConversationItem(note) {
  return {
    actor: iriOf(asValue(note, 'actor') ?? asValue(note, 'attributedTo')),
    content: contentOf(note),
    published: asValue(note, 'published') || '',
    context: asValue(note, 'context') || null
  };
}

async function readJSON(url, fetch) {
  const response = await fetch(url, { method: 'GET', headers: { 'Accept': ACCEPT_ACTIVITY } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || ''}`.trim());
  }
  return response.json();
}

// The last turns of an OrderedCollection, oldest first, newest last
export async function getConversation(url, { fetch = storageFetch, limit = Config.Agent.ConversationLimit } = {}) {
  const collection = await readJSON(url, fetch);

  let items = asValue(collection, 'orderedItems') ?? asValue(collection, 'items');
  if (!items) {
    let first = asValue(collection, 'first');
    if (typeof first === 'string') first = await readJSON(new URL(first, url).href, fetch);
    items = asValue(first, 'orderedItems') ?? asValue(first, 'items') ?? [];
  }

  items = Array.isArray(items) ? items : [items];
  return items.slice(-limit).map(normalizeConversationItem);
}

function contextHTML(context) {
  const selectors = [].concat(asValue(context, 'selector') || []);
  const quote = selectors.find(s => s?.type === 'TextQuoteSelector')?.exact;
  const fragment = selectors.find(s => s?.type === 'FragmentSelector')?.value;

  if (quote) return `<q dir="auto">${htmlEncode(quote)}</q>`;
  if (fragment) return `<code dir="ltr">#${htmlEncode(fragment)}</code>`;
  return '';
}

// A conversation turn is text to read: dokieli's usual allowance for scripts and frames does not apply
const CONVERSATION_SANITIZE = { ADD_TAGS: [], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style'] };

// Who, when, what; the content is the agent's or the author's HTML, so it is sanitised
export function conversationItemHTML(item, { agent = null } = {}) {
  let who, className;
  if (item.actor && item.actor === Config.User.IRI) {
    who = `<span data-i18n="dialog.agent.you.span">${i18n.t('dialog.agent.you.span.textContent')}</span>`;
    className = 'agent-conversation-user';
  }
  else if (item.actor && item.actor === agent) {
    who = `<span data-i18n="dialog.agent.agent.span">${i18n.t('dialog.agent.agent.span.textContent')}</span>`;
    className = 'agent-conversation-agent';
  }
  else {
    who = item.actor ? `<a dir="ltr" href="${htmlEncode(item.actor, { mode: 'attribute' })}" rel="noopener" target="_blank">${htmlEncode(item.actor)}</a>` : '';
    className = 'agent-conversation-other';
  }

  const date = item.published ? new Date(item.published) : null;
  const when = (date && !isNaN(date))
    ? ` <time datetime="${htmlEncode(item.published, { mode: 'attribute' })}">${htmlEncode(date.toLocaleString(Config.User.UI.Language))}</time>`
    : '';
  const about = item.context ? contextHTML(item.context) : '';

  return `<li class="${className}"><p>${who}${when}${about ? ` ${about}` : ''}</p><div dir="auto">${domSanitize(item.content || '', CONVERSATION_SANITIZE)}</div></li>`;
}

function renderConversation(panel, items, agent) {
  const list = panel.querySelector('.agent-conversation');
  if (!items.length) {
    list.replaceChildren(fragmentFromString(`<li class="agent-conversation-empty" data-i18n="dialog.agent.conversation.empty.li">${i18n.t('dialog.agent.conversation.empty.li.textContent')}</li>`));
    return;
  }
  list.replaceChildren(fragmentFromString(items.map(item => conversationItemHTML(item, { agent })).join('')));
  list.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
}

function showConversationStatus(panel, key, vars = {}) {
  panel.querySelector('.agent-conversation').replaceChildren(fragmentFromString(`<li class="agent-conversation-status" data-i18n="${key}">${i18n.t(`${key}.textContent`, vars)}</li>`));
}

// Reads the conversation again, finding where it is the first time
export async function refreshConversation(panel = document.getElementById('agent-panel'), { fetch = storageFetch } = {}) {
  const agent = panel?.dataset.agent;
  if (!agent) return;

  showConversationStatus(panel, 'dialog.agent.conversation.loading.li');

  try {
    if (!panel.dataset.conversation) {
      const conversation = await discoverConversation(agent, Config.DocumentURL, { fetch });
      if (!conversation) {
        renderConversation(panel, [], agent);
        return;
      }
      panel.dataset.conversation = conversation;
    }
    renderConversation(panel, await getConversation(panel.dataset.conversation, { fetch }), agent);
  }
  catch (error) {
    showConversationStatus(panel, 'dialog.agent.conversation.unavailable.li', { error: error?.message || '' });
  }
}

function appendConversationItem(panel, item) {
  const list = panel.querySelector('.agent-conversation');
  list.querySelectorAll('.agent-conversation-empty, .agent-conversation-status').forEach(li => li.remove());
  list.appendChild(fragmentFromString(conversationItemHTML(item, { agent: panel.dataset.agent })));
  list.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
}

export function agentPanelHTML({ context = null } = {}) {
  const buttonClose = getButtonHTML({ key: 'dialog.agent.close.button', button: 'close', buttonClass: 'close', iconSize: 'fa-2x' });
  const about = context ? contextHTML(context) : '';

  return `
    <aside aria-labelledby="agent-panel-label" class="do on" dir="${Config.User.UI.LanguageDir}" id="agent-panel" lang="${Config.User.UI.Language}" rel="schema:hasPart" resource="#agent-panel" xml:lang="${Config.User.UI.Language}">
      <h2 data-i18n="dialog.agent.h2" id="agent-panel-label" property="schema:name">${i18n.t('dialog.agent.h2.textContent')}</h2>
      ${buttonClose}
      <div class="info"></div>
      <section aria-labelledby="agent-conversation-label">
        <h3 data-i18n="dialog.agent.conversation.h3" id="agent-conversation-label">${i18n.t('dialog.agent.conversation.h3.textContent')}</h3>
        <ul aria-live="polite" class="agent-conversation"></ul>
      </section>
      <form class="editor-form">
        <fieldset>
          <legend data-i18n="editor.toolbar.agent-run.form.legend">${i18n.t('editor.toolbar.agent-run.form.legend.textContent')}</legend>
          ${about ? `<p class="agent-context"><span data-i18n="dialog.agent.context.span">${i18n.t('dialog.agent.context.span.textContent')}</span> ${about}</p>` : ''}
          <label class="editor-form-visually-hidden" data-i18n="editor.toolbar.agent-run.form.label" for="agent-run-content">${i18n.t('editor.toolbar.agent-run.form.label.textContent')}</label>
          <textarea class="editor-form-textarea" cols="20" data-i18n="editor.toolbar.agent-run.form.textarea" dir="auto" id="agent-run-content" name="agent-run-content" placeholder="${i18n.t('editor.toolbar.agent-run.form.textarea.placeholder')}" required="" rows="4"></textarea>
          <div>
            <button class="editor-form-submit" data-i18n="editor.toolbar.form.send.button" type="submit">${i18n.t('editor.toolbar.form.send.button.textContent')}</button>
            ${getButtonHTML({ key: 'agent.check-updates.button', button: 'more', buttonClass: 'agent-check-updates', buttonType: 'button' })}
          </div>
        </fieldset>
      </form>
    </aside>
  `;
}

// Opened from /agent: the conversation about this document above the prompt. Nothing of it loads before
export async function showAgentPanel({ context = null, fetch = storageFetch } = {}) {
  document.getElementById('agent-panel')?.remove();

  const agent = await prepareAgent(Config.DocumentURL);
  if (!agent) return null;

  document.body.appendChild(fragmentFromString(agentPanelHTML({ context })));
  const panel = document.getElementById('agent-panel');
  panel.dataset.agent = agent;

  const form = panel.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const textarea = form.querySelector('textarea');
    const prompt = textarea.value.trim();
    if (!prompt) return;

    const submit = form.querySelector('.editor-form-submit');
    submit.disabled = true;

    const result = await sendAgentRequest({ prompt, context, agent });

    submit.disabled = false;
    if (!result) return;

    // The author's turn shows at once; the agent's reply comes with the next refresh
    textarea.value = '';
    appendConversationItem(panel, {
      actor: result.request.actor,
      content: result.request.object.content,
      published: result.request.published,
      context
    });
  });

  form.querySelector('textarea').focus();

  await refreshConversation(panel, { fetch });
  return panel;
}

// The agent's edits come in the way any remote change does; its replies into the open panel
export async function checkAgentUpdates() {
  const progressId = agentMessage('agent.message.checking', { timer: null, extra: ` ${Icon['.fas.fa-circle-notch.fa-spin.fa-fw']}` });

  try {
    await syncLocalRemoteResource();
  }
  catch (error) {
    agentMessage('agent.message.failed', { type: 'error', vars: { error: error?.message || '' }, clearId: progressId });
    return;
  }

  await refreshConversation();

  agentMessage('agent.message.checked', { type: 'success', clearId: progressId });
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const button = e.target.closest?.('button.agent-check-updates');
    if (!button) return;
    e.preventDefault();
    button.disabled = true;
    checkAgentUpdates().finally(() => { button.disabled = false; });
  });
}
