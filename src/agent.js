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

// The document's agent: a service named by the document (schema:agent) that takes requests
// at its inbox and works on the stored document. Its edits arrive as remote changes, its replies as notifications.

import rdf from 'rdf-ext';
import { discoverInbox, postNotification } from '@dokieli/notifications';
import { getTextQuoteSelector, getFragmentSelector } from '@dokieli/web-annotation';
import Config from './config.js';
import { i18n } from './i18n.js';
import { addMessageToLog, getDocument, getResourceInfo, showActionMessage, updateMutableResource } from './doc.js';
import { getGraphFromData, getGraphAgent, getGraphSources, getGraphOntologies, jsonldNodesFromData } from './graph.js';
import { requestOriginConsent } from './consent.js';
import { storageFetch } from './storage/backend.js';
import { syncLocalRemoteResource, markLocalSnapshotPublished } from './sync.js';
import { showNotificationSources } from './activity.js';
import { getDocumentStorageURL } from './uri.js';
import { getDateTimeISO, getHash } from './util.js';
import { htmlEncode } from './utils/sanitization.js';
import { selectArticleNode } from './utils/html.js';
import { getButtonHTML } from './ui/buttons.js';
import { Icon } from './ui/icons.js';
import { annotationIgnoreSelector, getAnnotationContainer, getSelectedParentElement } from './editor/utils/annotation.js';
import { lazyImport } from './utils/lazy.js';
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

function checkUpdatesButtonHTML() {
  return getButtonHTML({ key: 'agent.check-updates.button', button: 'more', buttonClass: 'agent-check-updates', buttonType: 'button' });
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

// Requests are made while editing, by a signed-in author
export async function sendAgentRequest({ prompt, context = null }) {
  const documentURL = Config.DocumentURL;

  if (!prompt?.trim() || Config.Editor?.mode !== 'author') return;

  if (!Config.User.IRI) {
    showUserIdentityInput();
    return;
  }

  const { agent } = await getDocumentAgentSetup(documentURL);

  if (!agent) {
    agentMessage('agent.message.no-agent', { type: 'warning' });
    Config.Editor.slashMenu?.showForm('agent');
    return;
  }

  const allowed = await requestOriginConsent(agent, { reason: 'agent', ask: true });
  if (!allowed) {
    agentMessage('agent.message.declined', { type: 'warning' });
    return;
  }

  if (!await saveUnsavedChanges(documentURL)) return;

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
    return;
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
    return;
  }

  const location = result.location
    ? ` <a href="${htmlEncode(result.location, { mode: 'attribute' })}" rel="noopener" target="_blank">${htmlEncode(result.location)}</a>`
    : '';
  const key = result.outcome === 'created' ? 'agent.message.sent' : 'agent.message.accepted';

  agentMessage(key, {
    type: 'success',
    timer: null,
    clearId: progressId,
    extra: `${location} <span data-i18n="agent.message.updates">${i18n.t('agent.message.updates.textContent')}</span> ${checkUpdatesButtonHTML()}`
  });
}

// The agent's edits come in the way any remote change does, its replies through the document's inbox
export async function checkAgentUpdates() {
  const documentURL = Config.DocumentURL;
  const progressId = agentMessage('agent.message.checking', { timer: null, extra: ` ${Icon['.fas.fa-circle-notch.fa-spin.fa-fw']}` });

  try {
    await syncLocalRemoteResource();
  }
  catch (error) {
    agentMessage('agent.message.failed', { type: 'error', vars: { error: error?.message || '' }, clearId: progressId });
    return;
  }

  // Notifications already shown are skipped, so only new ones appear
  const inbox = Config.Resource[documentURL]?.inbox?.[0];
  if (inbox && Config.Inbox[inbox]) {
    showNotificationSources(inbox);
  }
  else {
    const { initShowNotificationSources } = await lazyImport(() => import('./init.js'));
    initShowNotificationSources();
  }

  agentMessage('agent.message.checked', { type: 'success', clearId: progressId });
}

export function agentRunFormControls() {
  return `
    <fieldset>
      <legend data-i18n="editor.toolbar.agent-run.form.legend">${i18n.t('editor.toolbar.agent-run.form.legend.textContent')}</legend>
      <label class="editor-form-visually-hidden" data-i18n="editor.toolbar.agent-run.form.label" for="agent-run-content">${i18n.t('editor.toolbar.agent-run.form.label.textContent')}</label>
      <textarea class="editor-form-textarea" cols="20" data-i18n="editor.toolbar.agent-run.form.textarea" dir="auto" id="agent-run-content" name="agent-run-content" placeholder="${i18n.t('editor.toolbar.agent-run.form.textarea.placeholder')}" required="" rows="5"></textarea>
      <div>
        <button class="editor-form-submit" data-i18n="editor.toolbar.form.send.button" type="submit">${i18n.t('editor.toolbar.form.send.button.textContent')}</button>
        <button class="editor-form-cancel" data-i18n="editor.toolbar.form.cancel.button" type="button">${i18n.t('editor.toolbar.form.cancel.button.textContent')}</button>
      </div>
    </fieldset>
  `;
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
