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

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@dokieli/notifications', async (importOriginal) => ({ ...(await importOriginal()), discoverInbox: vi.fn(), postNotification: vi.fn() }));
vi.mock('../../src/consent.js', async (importOriginal) => ({ ...(await importOriginal()), requestOriginConsent: vi.fn() }));

import rdf from 'rdf-ext';
import { RdfaParser } from 'rdfa-streaming-parser';
import { DOMParser as PMDOMParser, DOMSerializer } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { discoverInbox, postNotification } from '@dokieli/notifications';
import { requestOriginConsent } from '../../src/consent.js';
import { initButtons } from '../../src/ui/buttons.js';
import { cleanProseMirrorOutput } from '../../src/utils/normalization.js';
import { getHash } from '../../src/util.js';
import { schema } from '../../src/editor/schema/base.js';
import Config from '../../src/config.js';
import { createAgentHTML, createDataSourcesHTML, createOntologiesHTML, getDocument, getGraphData } from '../../src/doc.js';
import { EditorView } from 'prosemirror-view';
import { history, undoDepth } from 'prosemirror-history';
import { setDocumentItem, addItemURL, removeItemURL, getItemURLs } from '../../src/editor/utils/documentItems.js';
import { createAgentRequest, getAgentSelectionContext, getEditorSelectionContext, getDocumentAgentSetup, promptToHTML, sendAgentRequest, conversationRequestURL, discoverConversation, getConversation, conversationItemHTML, showAgentChat } from '../../src/agent.js';
import { searchOntologies, searchKnowledgeGraphs, catalogSearchURL, LOV_AUTOCOMPLETE_URL, agentSetupPanelHTML } from '../../src/agent-setup.js';
import { agentChatPlugin, openAgentChatWidget, closeAgentChatWidget } from '../../src/editor/plugins/agentChat.js';
import { documentItemsToolsPlugin, openDocumentItemSearch } from '../../src/editor/plugins/documentItemsTools.js';
import { SlashMenu } from '../../src/editor/slashmenu/slashmenu.js';
import { slashCommandPlugin } from '../../src/editor/plugins/slashCommand.js';

const BASE = 'https://example.org/article';
const AGENT = 'https://agent.example/';
const SOURCES = ['https://data.example/a.ttl', 'https://data.example/b.ttl'];
const ONTOLOGIES = ['https://w3id.org/example/onto#'];
const PREFIX = ['dcterms', 'schema'].map(p => `${p}: ${Config.ns[p]('').value}`).join(' ');

const SCHEMA = 'http://schema.org/';
const DCTERMS = 'http://purl.org/dc/terms/';

function blocksHTML() {
  return createAgentHTML(AGENT) + createDataSourcesHTML(SOURCES) + createOntologiesHTML(ONTOLOGIES);
}

function parseRDFa(html) {
  return new Promise((resolve, reject) => {
    const quads = [];
    const parser = new RdfaParser({ baseIRI: BASE, contentType: 'text/html' });
    parser.on('data', q => quads.push([q.subject.value, q.predicate.value, q.object.value]));
    parser.on('error', reject);
    parser.on('end', () => resolve(quads));
    parser.write(`<html><body about="" prefix="${PREFIX}">${html}</body></html>`);
    parser.end();
  });
}

function has(quads, s, p, o) {
  return quads.some(([qs, qp, qo]) => qs === s && qp === p && qo === o);
}

async function expectSetup(html) {
  const quads = await parseRDFa(html);
  expect(has(quads, BASE, `${SCHEMA}agent`, AGENT)).toBe(true);
  SOURCES.forEach(source => expect(has(quads, BASE, `${DCTERMS}source`, source)).toBe(true));
  ONTOLOGIES.forEach(ontology => expect(has(quads, BASE, `${DCTERMS}conformsTo`, ontology)).toBe(true));
}

function mount(html) {
  document.body.setAttribute('about', '');
  document.body.setAttribute('prefix', PREFIX);
  document.body.innerHTML = `<main><article><h1>Title</h1>${html}<p id="p1">Hello brave new world</p></article></main>`;
}

describe('document agent, data sources and ontologies blocks', () => {
  it('writes one dl per block with the document as subject', async () => {
    const container = document.createElement('div');
    container.innerHTML = blocksHTML();

    expect(container.querySelector('dl#document-agent a[rel="schema:agent"]').getAttribute('href')).toBe(AGENT);
    expect(Array.from(container.querySelectorAll('dl#document-sources a[rel="dcterms:source"]')).map(a => a.getAttribute('href'))).toEqual(SOURCES);
    expect(Array.from(container.querySelectorAll('dl#document-ontologies a[rel="dcterms:conformsTo"]')).map(a => a.getAttribute('href'))).toEqual(ONTOLOGIES);

    await expectSetup(blocksHTML());
  });

  it('writes nothing without entries and lists each entry once', () => {
    expect(createAgentHTML('')).toBe('');
    expect(createDataSourcesHTML([])).toBe('');
    expect(createOntologiesHTML([ONTOLOGIES[0], ONTOLOGIES[0]]).match(/dcterms:conformsTo/g)).toHaveLength(1);
  });

  it('survives the editor parse and serialise round trip', async () => {
    const container = document.createElement('div');
    container.innerHTML = `<h1>Title</h1>${blocksHTML()}`;

    const doc = PMDOMParser.fromSchema(schema).parse(container);
    const out = document.createElement('div');
    out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));

    expect(Array.from(out.querySelectorAll('dl')).map(dl => dl.id)).toEqual(['document-agent', 'document-sources', 'document-ontologies']);
    await expectSetup(out.innerHTML);
  });

  it('survives the normalised document serialisation', async () => {
    mount(blocksHTML());

    const saved = new DOMParser().parseFromString(getDocument(document.documentElement, { normalize: true }), 'text/html');

    expect(saved.querySelector('dl#document-agent a[rel="schema:agent"]').getAttribute('href')).toBe(AGENT);
    await expectSetup(saved.body.innerHTML);
  });

  it('reads the blocks back from the document graph', () => {
    const subject = rdf.namedNode(BASE);
    const dataset = rdf.dataset([
      rdf.quad(subject, rdf.namedNode(`${SCHEMA}agent`), rdf.namedNode(AGENT)),
      ...SOURCES.map(source => rdf.quad(subject, rdf.namedNode(`${DCTERMS}source`), rdf.namedNode(source))),
      ...ONTOLOGIES.map(ontology => rdf.quad(subject, rdf.namedNode(`${DCTERMS}conformsTo`), rdf.namedNode(ontology)))
    ]);

    const info = getGraphData(rdf.grapoi({ dataset }).node(subject), { subjectURI: BASE });

    expect(info.agent).toBe(AGENT);
    expect(info.sources).toEqual(SOURCES);
    expect(info.ontologies).toEqual(ONTOLOGIES);
  });

  it('reads the blocks from the live document', async () => {
    mount(blocksHTML());

    expect(await getDocumentAgentSetup(BASE)).toEqual({ agent: AGENT, sources: SOURCES, ontologies: ONTOLOGIES });
  });
});

describe('setting a block in the editor', () => {
  function viewFor(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    let state = EditorState.create({ doc: PMDOMParser.fromSchema(schema).parse(container) });
    return { get state() { return state; }, dispatch(tr) { state = state.apply(tr); } };
  }

  function serialize(view) {
    const out = document.createElement('div');
    out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(view.state.doc.content));
    return out;
  }

  function caretAfter(view, text) {
    let pos = null;
    view.state.doc.descendants((node, p) => {
      if (pos == null && node.isText && node.text.includes(text)) pos = p + node.text.indexOf(text) + text.length;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  }

  it('puts a new block after the h1 and in document item order, dropping the slash line', () => {
    const view = viewFor('<h1>Title</h1><p>Intro</p><p>/</p>');
    caretAfter(view, '/');
    const slashPos = view.state.selection.from - 1;

    setDocumentItem(view, 'document-ontologies', createOntologiesHTML(ONTOLOGIES), { slash: { from: slashPos, to: slashPos + 1 } });
    setDocumentItem(view, 'document-agent', createAgentHTML(AGENT));

    const out = serialize(view);
    expect(Array.from(out.children).map(n => n.id || n.nodeName.toLowerCase())).toEqual(['h1', 'document-agent', 'document-ontologies', 'p']);
    // The slash line is gone; only the document's own paragraph is left at the top level
    expect(Array.from(out.querySelectorAll(':scope > p')).map(p => p.textContent)).toEqual(['Intro']);

    // The editor's dd paragraphs are unwrapped on save
    const saved = document.createElement('div');
    saved.appendChild(cleanProseMirrorOutput(out));
    expect(saved.querySelectorAll('#document-agent dd > p, #document-ontologies dd > p')).toHaveLength(0);
    expect(saved.querySelector('#document-agent dd > a[rel="schema:agent"]').getAttribute('href')).toBe(AGENT);
  });

  it('replaces an existing block, and removes it when it has no entries', () => {
    const view = viewFor(`<h1>Title</h1>${createDataSourcesHTML([SOURCES[0]])}<p>Text</p>`);

    setDocumentItem(view, 'document-sources', createDataSourcesHTML(SOURCES));
    expect(Array.from(serialize(view).querySelectorAll('#document-sources a')).map(a => a.getAttribute('href'))).toEqual(SOURCES);

    setDocumentItem(view, 'document-sources', createDataSourcesHTML([]));
    expect(serialize(view).querySelector('#document-sources')).toBeNull();
  });
});

describe('agent request', () => {
  it('is an ActivityStreams Create of a Note targeting the document', () => {
    const context = { type: 'SpecificResource', source: BASE, selector: [{ type: 'TextQuoteSelector', exact: 'brave', prefix: 'Hello ', suffix: ' new world' }] };

    const request = createAgentRequest({ prompt: 'Add a summary', documentURL: BASE, actor: 'https://alice.example/#me', context, published: '2026-11-24T10:00:00Z' });

    expect(JSON.parse(JSON.stringify(request))).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      'type': 'Create',
      'actor': 'https://alice.example/#me',
      'object': { 'type': 'Note', 'content': '<p>Add a summary</p>' },
      'target': BASE,
      'context': context,
      'published': '2026-11-24T10:00:00Z'
    });
  });

  it('leaves out the context when there is none', () => {
    const request = createAgentRequest({ prompt: 'Check the tables', documentURL: BASE, actor: 'https://alice.example/#me', published: '2026-11-24T10:00:00Z' });

    expect(Object.keys(request)).toEqual(['@context', 'type', 'actor', 'object', 'target', 'published']);
  });

  it('is never made without the author\'s WebID', () => {
    expect(() => createAgentRequest({ prompt: 'Check the tables', documentURL: BASE, published: '2026-11-24T10:00:00Z' })).toThrow();
  });

  it('writes the prompt as HTML paragraphs, escaped', () => {
    expect(promptToHTML('One <b>\nline\n\nTwo')).toBe('<p>One &lt;b&gt;<br />line</p><p>Two</p>');
  });

  it('names the selection by its quote and the nearest element with an id', () => {
    mount('');
    const text = document.querySelector('#p1').firstChild;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);

    expect(getAgentSelectionContext(range, BASE)).toEqual({
      type: 'SpecificResource',
      source: BASE,
      selector: [
        { type: 'TextQuoteSelector', exact: 'brave', prefix: 'Hello ', suffix: ' new world' },
        { type: 'FragmentSelector', value: 'p1', conformsTo: 'https://tools.ietf.org/html/rfc3987' }
      ]
    });
  });
});

describe('where the author is in the editor', () => {
  // Positions 1 and 2 stand for the two ends of a selection in #p1's text
  function viewAt(from, to) {
    const text = document.querySelector('#p1').firstChild;
    const points = { 1: { node: text, offset: 6 }, 2: { node: text, offset: 11 } };
    return { state: { selection: { from, to, empty: from === to } }, domAtPos: pos => points[pos] };
  }

  it('names the selected text', () => {
    mount('');
    expect(getEditorSelectionContext(viewAt(1, 2), BASE).selector.map(s => s.type)).toEqual(['TextQuoteSelector', 'FragmentSelector']);
    expect(getEditorSelectionContext(viewAt(1, 2), BASE).selector[0].exact).toBe('brave');
  });

  it('names the element around the caret', () => {
    mount('');
    expect(getEditorSelectionContext(viewAt(1, 1), BASE)).toEqual({
      type: 'SpecificResource',
      source: BASE,
      selector: [{ type: 'FragmentSelector', value: 'p1', conformsTo: 'https://tools.ietf.org/html/rfc3987' }]
    });
  });
});

describe('sending to the agent', () => {
  // The document on screen is the one stored, so nothing is saved first
  async function mountSaved(html) {
    mount(html);
    Config.Resource[BASE] = { digestSRI: await getHash(getDocument(null, { ...Config.DOMProcessing, format: true, sanitize: true, normalize: true })) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Config.DocumentURL = BASE;
    Config.Editor = { mode: 'author' };
    Config.User.IRI = 'https://alice.example/#me';
    requestOriginConsent.mockResolvedValue(true);
    discoverInbox.mockResolvedValue('https://agent.example/inbox/');
    postNotification.mockResolvedValue({ outcome: 'created', location: 'https://agent.example/inbox/1' });
  });

  it('posts the request to the inbox the agent advertises', async () => {
    await mountSaved(createAgentHTML(AGENT));

    await sendAgentRequest({ prompt: 'Add a summary' });

    expect(requestOriginConsent).toHaveBeenCalledWith(AGENT, { reason: 'agent', ask: true });
    expect(discoverInbox.mock.calls[0][0]).toBe(AGENT);

    const [inbox, body, options] = postNotification.mock.calls[0];
    expect(inbox).toBe('https://agent.example/inbox/');
    expect(options.contentType).toBe('application/ld+json; profile="https://www.w3.org/ns/activitystreams"');
    expect(body).toMatchObject({ type: 'Create', actor: 'https://alice.example/#me', object: { type: 'Note', content: '<p>Add a summary</p>' }, target: BASE });
  });

  it('sends nothing when the document has no agent', async () => {
    await mountSaved('');

    await sendAgentRequest({ prompt: 'Add a summary' });

    expect(requestOriginConsent).not.toHaveBeenCalled();
    expect(postNotification).not.toHaveBeenCalled();
  });

  it('asks to sign in first, and sends nothing until then', async () => {
    // As i18n.js sets it when dokieli loads; i18n is mocked here
    Config.DocsTranslations = ['en', 'es'];
    initButtons();
    await mountSaved(createAgentHTML(AGENT));
    Config.User.IRI = null;

    await sendAgentRequest({ prompt: 'Add a summary' });

    expect(document.getElementById('user-identity-input')).not.toBeNull();
    expect(postNotification).not.toHaveBeenCalled();
  });

  it('sends nothing when contacting the agent is not allowed', async () => {
    await mountSaved(createAgentHTML(AGENT));
    requestOriginConsent.mockResolvedValue(false);

    await sendAgentRequest({ prompt: 'Add a summary' });

    expect(discoverInbox).not.toHaveBeenCalled();
    expect(postNotification).not.toHaveBeenCalled();
  });
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/ld+json', ...headers } });
}

const CONVERSATION = 'https://agent.example/agent/conversations/article/';
const ME = 'https://alice.example/#me';

const collection = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  'id': CONVERSATION,
  'type': 'OrderedCollection',
  'orderedItems': [
    { 'type': 'Note', 'attributedTo': ME, 'content': '<p>Add a summary</p>', 'published': '2026-11-24T10:00:00Z', 'context': { 'type': 'SpecificResource', 'source': BASE, 'selector': [{ 'type': 'TextQuoteSelector', 'exact': 'brave' }] } },
    { 'type': 'Note', 'actor': AGENT, 'content': '<p>Done.</p><script>alert(1)</script><img src="x" onerror="alert(2)">', 'published': '2026-11-24T10:01:00Z' }
  ]
};

describe('the conversation with the agent', () => {
  beforeEach(() => {
    Config.User.IRI = ME;
  });

  it('asks the agent resource about the document', () => {
    expect(conversationRequestURL('https://agent.example/agent#me', BASE)).toBe(`https://agent.example/agent?document=${encodeURIComponent(BASE)}`);
  });

  it('is found from the Link header', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { 'Link': `<${CONVERSATION}>; rel="https://www.w3.org/ns/activitystreams#replies"` } }));

    expect(await discoverConversation(AGENT, BASE, { fetch })).toBe(CONVERSATION);
    expect(fetch.mock.calls[0][0]).toBe(conversationRequestURL(AGENT, BASE));
  });

  it('is found from as:replies in the body when there is no Link header', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ '@context': 'https://www.w3.org/ns/activitystreams', 'id': AGENT, 'replies': { 'id': CONVERSATION } }));

    expect(await discoverConversation(AGENT, BASE, { fetch })).toBe(CONVERSATION);
  });

  it('reads the last turns, newest last, from actor or attributedTo', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(collection));

    const items = await getConversation(CONVERSATION, { fetch, limit: 20 });

    expect(items.map(item => item.actor)).toEqual([ME, AGENT]);
    expect(items[0].context.selector[0].exact).toBe('brave');
    expect((await getConversation(CONVERSATION, { fetch: vi.fn().mockResolvedValue(jsonResponse(collection)), limit: 1 })).map(item => item.actor)).toEqual([AGENT]);
  });

  it('shows who said what, when, and about which part, without scripts', () => {
    const container = document.createElement('ul');
    container.innerHTML = collection.orderedItems.map(note => conversationItemHTML({ actor: note.attributedTo || note.actor, content: note.content, published: note.published, context: note.context || null }, { agent: AGENT })).join('');

    const [mine, agents] = container.querySelectorAll('li');
    expect(mine.classList.contains('agent-conversation-user')).toBe(true);
    expect(mine.querySelector('time').getAttribute('datetime')).toBe('2026-11-24T10:00:00Z');
    expect(mine.querySelector('q').textContent).toBe('brave');
    expect(agents.classList.contains('agent-conversation-agent')).toBe(true);
    expect(agents.querySelector('div').textContent).toContain('Done.');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img').hasAttribute('onerror')).toBe(false);
  });

  it('reads a missing conversation as none yet', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));

    expect(await discoverConversation(AGENT, BASE, { fetch })).toBeNull();
    expect(await getConversation(CONVERSATION, { fetch })).toEqual([]);
  });
});

// jsdom has no layout; ProseMirror asks for rects when it scrolls a change into view
function stubLayout() {
  const RangePrototype = document.createRange().constructor.prototype;
  const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  RangePrototype.getClientRects = () => [];
  RangePrototype.getBoundingClientRect = () => rect;
  document.elementFromPoint = () => null;
}

// An author-mode editor on the page's article, with the plugins under test
function mountEditor(html, plugins = [history(), documentItemsToolsPlugin, agentChatPlugin, slashCommandPlugin]) {
  stubLayout();
  document.body.setAttribute('about', '');
  document.body.setAttribute('prefix', PREFIX);
  document.body.innerHTML = '<main><article></article></main>';
  const container = document.createElement('div');
  container.innerHTML = html;
  const state = EditorState.create({ doc: PMDOMParser.fromSchema(schema).parse(container), plugins });
  return new EditorView(document.querySelector('article'), { state });
}

// The caret right after the "/" of a paragraph holding only "/", as typing a slash command leaves it
function caretOnSlashLine(view) {
  let pos = null;
  view.state.doc.descendants((node, p) => {
    if (pos == null && node.type.name === 'p' && node.textContent === '/') pos = p + 2;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

// What the editor should hold once a slash command is done: the same document without its slash line
function docWithout(html, removed) {
  const container = document.createElement('div');
  container.innerHTML = html.replace(removed, '');
  return PMDOMParser.fromSchema(schema).parse(container);
}

// Opens the slash menu as typing "/" does
function openSlashMenu(view) {
  const slashMenu = new SlashMenu(view);
  slashMenu.showMenu(0, 0);
  return slashMenu;
}

function savedDocument() {
  return getDocument(document.documentElement, { ...Config.DOMProcessing, format: true, sanitize: true, normalize: true });
}

describe('the inline agent chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Config.DocumentURL = BASE;
    Config.User.IRI = ME;
    requestOriginConsent.mockResolvedValue(true);
  });

  it('opens from /agent where the slash line was, and loads the conversation only then', async () => {
    const html = `<h1>Title</h1>${createAgentHTML(AGENT)}<p>Before</p><p>/</p><p>After</p>`;
    const view = mountEditor(html);
    Config.Editor = { mode: 'author', editorView: view };
    caretOnSlashLine(view);

    const fetch = vi.fn(async (url) => url === CONVERSATION
      ? jsonResponse(collection)
      : new Response('', { status: 200, headers: { 'Link': `<${CONVERSATION}>; rel="https://www.w3.org/ns/activitystreams#replies"` } }));
    expect(fetch).not.toHaveBeenCalled();

    const slashMenu = openSlashMenu(view);
    // The caret has moved since the menu opened; the "/" removed is still the one typed
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const chat = await slashMenu.openAgentPanel({ fetch });

    expect(chat.id).toBe('agent-chat');
    expect(chat.classList.contains('do')).toBe(true);
    expect(chat.getAttribute('contenteditable')).toBe('false');
    expect(chat.previousElementSibling.textContent).toBe('Before');
    expect(chat.nextElementSibling.textContent).toBe('After');
    expect(view.state.doc.eq(docWithout(html, '<p>/</p>'))).toBe(true);
    expect(view.state.doc.textContent).toContain(AGENT);

    expect(fetch.mock.calls.map(call => call[0])).toEqual([conversationRequestURL(AGENT, BASE), CONVERSATION]);
    expect(chat.querySelectorAll('.agent-conversation li')).toHaveLength(2);
    expect(chat.querySelector('textarea[name="agent-run-content"]')).not.toBeNull();
  });

  it('keeps typing and clicks in the chat out of the document', async () => {
    const view = mountEditor(`<h1>Title</h1>${createAgentHTML(AGENT)}<p>Text</p>`);
    Config.Editor = { mode: 'author', editorView: view };

    const chat = await showAgentChat(view, { pos: view.state.doc.content.size, fetch: vi.fn().mockResolvedValue(new Response('', { status: 404 })) });
    const before = view.state.doc;
    const textarea = chat.querySelector('textarea');

    ['a', 'b', 'Enter', 'Backspace'].forEach((key) => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true }));
    });
    textarea.value = 'Add a summary';
    textarea.dispatchEvent(new InputEvent('input', { data: 'Add a summary', inputType: 'insertText', bubbles: true }));
    chat.querySelector('button.agent-check-updates').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(view.state.doc.eq(before)).toBe(true);
    expect(textarea.value).toBe('Add a summary');
    expect(chat.getAttribute('contenteditable')).toBe('false');
  });

  it('is never part of the document: not serialised, not saved, not in the undo history', () => {
    const view = mountEditor('<h1>Title</h1><p>Before</p><p>After</p>');
    const depth = undoDepth(view.state);
    const chat = document.createElement('div');
    chat.className = 'do agent-chat';
    chat.id = 'agent-chat';

    openAgentChatWidget(view, 1 + view.state.doc.child(0).nodeSize, chat);

    expect(document.getElementById('agent-chat')).not.toBeNull();
    expect(undoDepth(view.state)).toBe(depth);

    const serialised = document.createElement('div');
    serialised.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(view.state.doc.content));
    expect(serialised.querySelector('#agent-chat')).toBeNull();
    expect(savedDocument()).not.toContain('agent-chat');

    closeAgentChatWidget(view);
    expect(document.getElementById('agent-chat')).toBeNull();
    expect(undoDepth(view.state)).toBe(depth);
  });

  it('closes with Escape', async () => {
    const view = mountEditor(`<h1>Title</h1>${createAgentHTML(AGENT)}<p>Text</p>`);
    Config.Editor = { mode: 'author', editorView: view };

    const chat = await showAgentChat(view, { pos: view.state.doc.content.size, fetch: vi.fn().mockResolvedValue(new Response('', { status: 404 })) });
    expect(chat.querySelector('.agent-conversation-empty')).not.toBeNull();

    chat.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.getElementById('agent-chat')).toBeNull();
  });
});

describe('inline knowledge graphs and ontologies in the document details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Config.DocumentURL = BASE;
    requestOriginConsent.mockResolvedValue(true);
  });

  it('shows every block while editing, empty ones as unsaved placeholders', () => {
    const view = mountEditor(`<h1>Title</h1>${createDataSourcesHTML([SOURCES[0]])}<p>Text</p>`);

    expect(document.querySelector('.document-item-placeholder[data-item="agent"] button.document-item-add')).not.toBeNull();
    expect(document.querySelector('.document-item-placeholder[data-item="ontologies"] button.document-item-add')).not.toBeNull();
    expect(document.querySelectorAll('#document-sources button.document-item-remove')).toHaveLength(1);
    expect(document.querySelector('#document-sources button.document-item-add')).not.toBeNull();

    const saved = savedDocument();
    expect(saved).not.toContain('document-item-placeholder');
    expect(saved).not.toContain('document-ontologies');
    expect(saved).toContain('document-sources');
    expect(view.state.doc.textContent).not.toContain('Add');
  });

  it('adds from "+ Add", by a pasted http address, and removes with "−"', () => {
    const LOCAL = 'http://127.0.0.1:7001/';
    const view = mountEditor('<h1>Title</h1><p>Text</p>');

    document.querySelector('.document-item-placeholder[data-item="sources"] button.document-item-add').click();
    const input = document.querySelector('.document-item-search input');
    input.value = LOCAL;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(getItemURLs('sources', view)).toEqual([LOCAL]);
    expect(document.querySelector('.document-item-search')).toBeNull();
    expect(savedDocument()).toContain(LOCAL);

    document.querySelector('#document-sources button.document-item-remove').click();
    expect(getItemURLs('sources', view)).toEqual([]);
    expect(savedDocument()).not.toContain('document-sources');
  });

  it('opens the search from /ontology and /knowledge graph, removing only the slash line', () => {
    ['ontology', 'data-source'].forEach((button) => {
      const html = `<h1>Title</h1>${createAgentHTML(AGENT)}<p>Before</p><p>/</p><p>After</p>`;
      const view = mountEditor(html);
      caretOnSlashLine(view);

      openSlashMenu(view).handlePopups(button);

      expect(view.state.doc.eq(docWithout(html, '<p>/</p>'))).toBe(true);
      const kind = button === 'ontology' ? 'ontologies' : 'sources';
      expect(document.querySelector(`.document-item-placeholder[data-item="${kind}"] .document-item-search`)).not.toBeNull();
    });
  });

  it('adds an ontology found on Linked Open Vocabularies', async () => {
    const view = mountEditor('<h1>Title</h1><p>Text</p>');

    openDocumentItemSearch(view, 'ontologies');
    const search = document.querySelector('.document-item-placeholder[data-item="ontologies"] .document-item-search');
    expect(search).not.toBeNull();

    // The result list is what the LOV search renders
    search.querySelector('.document-item-results').innerHTML = `<li><button class="agent-setup-add" data-kind="ontologies" data-url="http://www.w3.org/ns/prov#" type="button">Add</button></li>`;
    search.querySelector('button.agent-setup-add').click();

    expect(getItemURLs('ontologies', view)).toEqual(['http://www.w3.org/ns/prov#']);
  });

  it('shows entries a remote change brings, e.g. ones the agent added', () => {
    const view = mountEditor('<h1>Title</h1><p>Text</p>');

    const remote = document.createElement('div');
    remote.innerHTML = `<h1>Title</h1>${createOntologiesHTML(ONTOLOGIES)}<p>Text</p>`;
    const doc = PMDOMParser.fromSchema(schema).parse(remote);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));

    expect(getItemURLs('ontologies', view)).toEqual(ONTOLOGIES);
    expect(document.querySelectorAll('#document-ontologies button.document-item-remove')).toHaveLength(1);
    expect(document.querySelector('.document-item-placeholder[data-item="ontologies"]')).toBeNull();
  });

  it('drops a block left without entries on save', () => {
    mount('<dl id="document-sources"><dt>Knowledge graphs</dt><dd>edited away</dd></dl>');
    expect(savedDocument()).not.toContain('document-sources');
  });

  it('is found by what the user types in the slash menu', () => {
    const view = mountEditor('<h1>Title</h1><p>Text</p>');
    const slashMenu = new SlashMenu(view);
    slashMenu.createMenuItems();

    const found = (query) => {
      slashMenu.filterMenuItems(query);
      return slashMenu.visibleMenuButtons().map(b => b.id);
    };

    expect(found('knowledge graph')).toContain('editor-button-data-source');
    expect(found('kg')).toContain('editor-button-data-source');
    expect(found('ontology')).toContain('editor-button-ontology');
    expect(found('vocabulary')).toContain('editor-button-ontology');
    expect(found('agent')[0]).toBe('editor-button-agent-run');
  });
});

describe('agent setup', () => {
  function viewFor(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    let state = EditorState.create({ doc: PMDOMParser.fromSchema(schema).parse(container) });
    return { get state() { return state; }, dispatch(tr) { state = state.apply(tr); } };
  }

  function serialize(view) {
    const out = document.createElement('div');
    out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(view.state.doc.content));
    return out;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    requestOriginConsent.mockResolvedValue(true);
  });

  it('adds and removes knowledge graphs and ontologies in their blocks', async () => {
    const view = viewFor('<h1>Title</h1><p>Text</p>');

    addItemURL('sources', SOURCES[0], view);
    addItemURL('sources', SOURCES[1], view);
    addItemURL('ontologies', ONTOLOGIES[0], view);
    addItemURL('agent', AGENT, view);

    expect(getItemURLs('sources', view)).toEqual(SOURCES);
    await expectSetup(serialize(view).innerHTML);

    removeItemURL('sources', SOURCES[0], view);
    expect(getItemURLs('sources', view)).toEqual([SOURCES[1]]);

    removeItemURL('ontologies', ONTOLOGIES[0], view);
    expect(serialize(view).querySelector('#document-ontologies')).toBeNull();
    expect(addItemURL('ontologies', 'not a url', view)).toBe(false);
  });

  it('takes local http knowledge graphs, which only the agent reads, and keeps the agent on https', () => {
    const LOCAL = 'http://127.0.0.1:7001/';
    const view = viewFor('<h1>Title</h1><p>Text</p>');

    expect(addItemURL('sources', LOCAL, view)).toBe(true);
    expect(addItemURL('sources', 'http://127.0.0.1:7880/query', view)).toBe(true);
    expect(getItemURLs('sources', view)).toEqual([LOCAL, 'http://127.0.0.1:7880/query']);
    expect(addItemURL('agent', 'http://agent.example/', view)).toBe(false);

    const accepts = (input, value) => new RegExp(`^(?:${input.getAttribute('pattern')})$`).test(value);
    const panel = document.createElement('div');
    panel.innerHTML = agentSetupPanelHTML();
    expect(accepts(panel.querySelector('#agent-setup-sources-url'), LOCAL)).toBe(true);
    expect(accepts(panel.querySelector('#agent-setup-ontologies-url'), 'http://xmlns.com/foaf/0.1/')).toBe(true);
    expect(accepts(panel.querySelector('#agent-setup-agent-url'), 'http://agent.example/')).toBe(false);
  });

  it('finds ontologies on Linked Open Vocabularies, with consent', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      results: [{ uri: ['http://www.w3.org/ns/prov#'], prefix: ['prov'], 'http://purl.org/dc/terms/title@en': ['W3C PROVenance Interchange'], score: 8.6 }]
    }));

    const results = await searchOntologies('prov', { fetch });

    expect(requestOriginConsent.mock.calls[0][0]).toBe(`${LOV_AUTOCOMPLETE_URL}?q=prov`);
    expect(fetch.mock.calls[0][0]).toBe(`${LOV_AUTOCOMPLETE_URL}?q=prov`);
    expect(results).toEqual([{ uri: 'http://www.w3.org/ns/prov#', prefix: 'prov', title: 'W3C PROVenance Interchange' }]);
  });

  it('searches nothing without consent', async () => {
    requestOriginConsent.mockResolvedValue(false);
    const fetch = vi.fn();

    expect(await searchOntologies('prov', { fetch })).toEqual([]);
    expect(await searchKnowledgeGraphs(AGENT, 'cities', { fetch })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('finds knowledge graphs in the agent catalog', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      '@context': { '@vocab': 'http://schema.org/' },
      '@graph': [
        { 'name': 'Urban', 'description': 'City data', 'sparqlEndpoint': 'https://kg.example/sparql', 'kind': 'sparql' },
        { 'name': 'Places', 'url': 'https://kg.example/places.ttl', 'kind': 'rdf' }
      ]
    }));

    const results = await searchKnowledgeGraphs('https://agent.example/agent', 'cities', { fetch });

    expect(requestOriginConsent).toHaveBeenCalledWith('https://agent.example/agent', { reason: 'agent', ask: true });
    expect(fetch.mock.calls[0][0]).toBe(catalogSearchURL('https://agent.example/agent', 'cities'));
    expect(fetch.mock.calls[0][0]).toBe('https://agent.example/agent/knowledge-graphs?q=cities');
    expect(results).toEqual([
      { name: 'Urban', description: 'City data', url: 'https://kg.example/sparql', kind: 'sparql' },
      { name: 'Places', description: '', url: 'https://kg.example/places.ttl', kind: 'rdf' }
    ]);
  });
});
