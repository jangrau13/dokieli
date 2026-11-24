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
import { setDocumentItem } from '../../src/editor/slashmenu/handlers.js';
import { createAgentRequest, getAgentSelectionContext, getEditorSelectionContext, getDocumentAgentSetup, getDocumentItemURLs, promptToHTML, sendAgentRequest, conversationRequestURL, discoverConversation, getConversation, conversationItemHTML, showAgentPanel } from '../../src/agent.js';
import { addItemURL, removeItemURL, getItemURLs, searchOntologies, searchKnowledgeGraphs, catalogSearchURL, LOV_AUTOCOMPLETE_URL, agentSetupPanelHTML } from '../../src/agent-setup.js';
import { SlashMenu } from '../../src/editor/slashmenu/slashmenu.js';

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
    expect(getDocumentItemURLs('document-sources', 'dcterms:source')).toEqual(SOURCES);
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

    setDocumentItem(view, 'document-ontologies', createOntologiesHTML(ONTOLOGIES), { openedWithSlash: true });
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

  it('loads nothing before the panel opens, and the conversation when it does', async () => {
    Config.DocumentURL = BASE;
    Config.Editor = { mode: 'author' };
    requestOriginConsent.mockResolvedValue(true);
    mount(createAgentHTML(AGENT));

    const fetch = vi.fn(async (url) => url === CONVERSATION
      ? jsonResponse(collection)
      : new Response('', { status: 200, headers: { 'Link': `<${CONVERSATION}>; rel="https://www.w3.org/ns/activitystreams#replies"` } }));

    expect(fetch).not.toHaveBeenCalled();
    expect(document.getElementById('agent-panel')).toBeNull();

    const panel = await showAgentPanel({ fetch });

    expect(fetch.mock.calls.map(call => call[0])).toEqual([conversationRequestURL(AGENT, BASE), CONVERSATION]);
    expect(panel.querySelectorAll('.agent-conversation li')).toHaveLength(2);
    expect(panel.querySelector('textarea[name="agent-run-content"]')).not.toBeNull();
    expect(panel.classList.contains('do')).toBe(true);
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

    addItemURL('sources', LOCAL, view);
    addItemURL('sources', 'http://127.0.0.1:7880/query', view);
    expect(getItemURLs('sources', view)).toEqual([LOCAL, 'http://127.0.0.1:7880/query']);

    const accepts = (input, value) => new RegExp(`^(?:${input.getAttribute('pattern')})$`).test(value);

    const panel = document.createElement('div');
    panel.innerHTML = agentSetupPanelHTML();
    expect(accepts(panel.querySelector('#agent-setup-sources-url'), LOCAL)).toBe(true);
    expect(accepts(panel.querySelector('#agent-setup-ontologies-url'), 'http://xmlns.com/foaf/0.1/')).toBe(true);
    expect(accepts(panel.querySelector('#agent-setup-agent-url'), 'http://agent.example/')).toBe(false);

    const form = document.createElement('div');
    form.innerHTML = SlashMenu.prototype.createDocumentListWidgetHTML.call({}, 'data-source', []);
    expect(accepts(form.querySelector('#set-data-source'), LOCAL)).toBe(true);
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
