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

// The document's agent, knowledge graphs (dl#document-sources) and ontologies (dl#document-ontologies): document-level
// dl blocks that hold links from the document, written through the editor. A block exists only with entries.

import { DOMParser as PMDOMParser } from "prosemirror-model";
import Config from "../../config.js";
import { createAgentHTML, createDataSourcesHTML, createOntologiesHTML } from "../../doc.js";
import { ensureDocumentPrefixes } from "../../table.js";
import { fragmentFromString } from "../../utils/html.js";
import { registerDocumentTransform } from "../../utils/documentTransforms.js";

export const DOCUMENT_ITEMS = {
  agent: { id: 'document-agent', rel: 'schema:agent', prefix: 'schema', protocols: ['https:'], html: (urls) => createAgentHTML(urls[0]) },
  // Read by the agent, never fetched by the browser, so local http addresses are fine
  sources: { id: 'document-sources', rel: 'dcterms:source', prefix: 'dcterms', protocols: ['http:', 'https:'], html: createDataSourcesHTML },
  // Ontology namespaces are names, many of them http
  ontologies: { id: 'document-ontologies', rel: 'dcterms:conformsTo', prefix: 'dcterms', protocols: ['http:', 'https:'], html: createOntologiesHTML }
};

export function findDocumentItem(doc, id) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs?.originalAttributes?.id === id) {
      found = { node, pos };
      return false;
    }
  });
  return found;
}

// The addresses a document-level dl links with rel, as the editor holds them
export function getDocumentItemEntries(doc, id, rel) {
  const item = findDocumentItem(doc, id);
  if (!item) return [];

  const urls = [];
  item.node.descendants((node) => {
    node.marks?.forEach((mark) => {
      const { rel: rels, href } = mark.attrs.originalAttributes || {};
      if (href && String(rels || '').split(/\s+/).includes(rel) && !urls.includes(href)) urls.push(href);
    });
  });
  return urls;
}

// After the nearest earlier item in Config.DocumentItems, else after the h1, as insertDocumentLevelHTML places them
export function documentItemPosition(doc, id) {
  for (let i = Config.DocumentItems.indexOf(id) - 1; i >= 0; i--) {
    const previous = findDocumentItem(doc, Config.DocumentItems[i]);
    if (previous) return previous.pos + previous.node.nodeSize;
  }

  // Before a later item, so the block joins the other document details wherever they are, e.g. in a details element
  for (let i = Config.DocumentItems.indexOf(id) + 1; i < Config.DocumentItems.length; i++) {
    const next = findDocumentItem(doc, Config.DocumentItems[i]);
    if (next && next.node.type.name === 'dl') return next.pos;
  }

  let heading = null;
  doc.descendants((node, pos) => {
    if (heading) return false;
    if (node.type.name === 'heading' && node.attrs.level === 1) {
      heading = { node, pos };
      return false;
    }
  });

  return heading ? heading.pos + heading.node.nodeSize : 0;
}

// Deletes the "/" that opened the slash menu (slash: its range), and its line when nothing else is on it.
// Returns where the line was, or the position the "/" had, in tr's document; null without a slash
export function removeSlashCommand(tr, slash) {
  if (!slash) return null;

  const $slash = tr.doc.resolve(slash.from);
  const line = $slash.parent;

  if (line.isTextblock && line.textContent === '/' && $slash.depth >= 1 && $slash.node(-1).childCount > 1) {
    const from = $slash.before();
    tr.delete(from, $slash.after());
    return { pos: from, lineRemoved: true };
  }

  tr.delete(slash.from, slash.to);
  return { pos: slash.from, lineRemoved: false };
}

// Writes a document-level dl (e.g. #document-agent) in place of the one there, or removes it when html is empty
export function setDocumentItem(view, id, html, { slash = null } = {}) {
  const { schema } = view.state;
  const tr = view.state.tr;

  removeSlashCommand(tr, slash);

  const nodes = html ? PMDOMParser.fromSchema(schema).parseSlice(fragmentFromString(html)).content : null;
  const existing = findDocumentItem(tr.doc, id);

  if (existing) {
    if (nodes) {
      tr.replaceWith(existing.pos, existing.pos + existing.node.nodeSize, nodes);
    }
    else {
      tr.delete(existing.pos, existing.pos + existing.node.nodeSize);
    }
  }
  else if (nodes) {
    tr.insert(documentItemPosition(tr.doc, id), nodes);
  }

  if (tr.docChanged) view.dispatch(tr.scrollIntoView());
}

export function getItemURLs(kind, view) {
  const { id, rel } = DOCUMENT_ITEMS[kind];
  return view ? getDocumentItemEntries(view.state.doc, id, rel) : [];
}

function writeItem(kind, urls, view, options) {
  const { id, prefix, html } = DOCUMENT_ITEMS[kind];
  setDocumentItem(view, id, urls.length ? html(urls) : '', options);
  if (urls.length) ensureDocumentPrefixes([prefix]);
}

// Absolute addresses only, so they hold wherever the document is stored or copied
export function addItemURL(kind, url, view, options = {}) {
  let href;
  try { href = new URL(String(url).trim()); } catch { return false; }
  if (!DOCUMENT_ITEMS[kind].protocols.includes(href.protocol)) return false;
  href = href.href;

  const urls = kind === 'agent' ? [href] : [...getItemURLs(kind, view).filter(u => u !== href), href];
  writeItem(kind, urls, view, options);
  return true;
}

export function removeItemURL(kind, url, view, options = {}) {
  writeItem(kind, getItemURLs(kind, view).filter(u => u !== url), view, options);
}

// A block left without entries, e.g. after editing its text away, is not saved
registerDocumentTransform((doc) => {
  Object.values(DOCUMENT_ITEMS).forEach(({ id, rel }) => {
    doc.querySelectorAll(`dl#${id}`).forEach((dl) => {
      if (!dl.querySelector(`[rel~="${rel}"][href]`)) dl.remove();
    });
  });
});
