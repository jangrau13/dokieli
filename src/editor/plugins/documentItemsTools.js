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

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { i18n } from "../../i18n.js";
import { Icon } from "../../ui/icons.js";
import { fragmentFromString } from "../../utils/html.js";
import { widgetButton } from "./sectionsNavDecorations.js";
import { DOCUMENT_ITEMS, addItemURL, documentItemPosition, findDocumentItem, removeItemURL } from "../utils/documentItems.js";
import { documentItemResultsHTML } from "../../agent-setup.js";

// Author-mode controls for the agent, knowledge graphs and ontologies, as documentTypeTools does for Document Type:
// a "−" per entry and a "+ Add …" at the end of each block. A block without entries shows as an empty, unsaved
// placeholder where it would go, so it can be found. "+ Add …", and /knowledge graph and /ontology, open a search
// in place: Linked Open Vocabularies, the agent's catalog, or a pasted address.

export const documentItemsToolsKey = new PluginKey("documentItemsTools");

const KINDS = ["agent", "sources", "ontologies"];

function isAddress(value) {
  return /^https?:\/\/\S+$/i.test(value);
}

function closeSearch(view) {
  view.dispatch(view.state.tr.setMeta(documentItemsToolsKey, { open: null }));
}

// Opens the search for kind in its block, e.g. from the slash menu
export function openDocumentItemSearch(view, kind) {
  view.dispatch(view.state.tr.setMeta(documentItemsToolsKey, { open: kind }));
}

function add(view, kind, url) {
  if (addItemURL(kind, url, view)) closeSearch(view);
}

function searchWidget(view, kind) {
  const searchable = kind !== "agent";
  const dom = fragmentFromString(`<span class="do document-item-search">
      <input aria-label="${i18n.t(`editor.document-items.${kind}.search.input.aria-label`)}" dir="auto" placeholder="${i18n.t(`editor.document-items.${kind}.search.input.placeholder`)}" type="${searchable ? "search" : "url"}" value="" />
      <button class="document-item-search-submit" data-i18n="editor.document-items.${searchable ? "search" : "set"}.button" type="button">${i18n.t(`editor.document-items.${searchable ? "search" : "set"}.button.textContent`)}</button>
      <button class="document-item-search-cancel" data-i18n="editor.toolbar.form.cancel.button" type="button">${i18n.t("editor.toolbar.form.cancel.button.textContent")}</button>
      <ul aria-live="polite" class="document-item-results"></ul>
    </span>`).firstElementChild;
  // Sanitising drops contenteditable; the search is not part of the editable document
  dom.setAttribute("contenteditable", "false");

  const input = dom.querySelector("input");
  const results = dom.querySelector(".document-item-results");

  const run = async () => {
    const value = input.value.trim();
    if (!value) return;
    // A pasted address is added as it is
    if (isAddress(value)) {
      add(view, kind, value);
      return;
    }
    if (!searchable) return;
    results.replaceChildren(fragmentFromString(`<li data-i18n="dialog.agent-setup.searching.li">${i18n.t("dialog.agent-setup.searching.li.textContent")}</li>`));
    results.replaceChildren(fragmentFromString(await documentItemResultsHTML(kind, value, view)));
  };

  dom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearch(view);
      view.focus();
    }
  });

  dom.addEventListener("click", (e) => {
    if (e.target.closest(".document-item-search-submit")) run();
    else if (e.target.closest(".document-item-search-cancel")) closeSearch(view);
    else {
      const result = e.target.closest("button.agent-setup-add");
      if (result) add(view, kind, result.dataset.url);
    }
  });

  setTimeout(() => input.focus());
  return dom;
}

function addWidget(view, kind) {
  return widgetButton({
    className: "do document-type-add document-item-add",
    label: i18n.t(`editor.document-items.${kind}.add.button.textContent`),
    icon: Icon[".fas.fa-plus"],
    onClick: (e) => {
      e.preventDefault();
      openDocumentItemSearch(view, kind);
    }
  });
}

function addOrSearch(view, kind, open) {
  return open === kind ? searchWidget(view, kind) : addWidget(view, kind);
}

function removeWidget(view, kind, url) {
  return widgetButton({
    className: "do document-type-remove document-item-remove",
    label: "",
    icon: Icon[".fas.fa-minus"],
    title: i18n.t(`editor.document-items.${kind}.remove.button.title`),
    onClick: (e) => {
      e.preventDefault();
      removeItemURL(kind, url, view);
    }
  });
}

// The empty block, as dokieli UI: never part of the document
function placeholderWidget(view, kind, open) {
  const { id } = DOCUMENT_ITEMS[kind];
  const dl = fragmentFromString(`<dl class="do document-item-placeholder" data-item="${kind}"><dt>${i18n.tDoc(`${id}.dt.textContent`)}</dt><dd></dd></dl>`).firstElementChild;
  dl.setAttribute("contenteditable", "false");
  dl.querySelector("dd").appendChild(addOrSearch(view, kind, open));
  return dl;
}

function entryURL(dd, rel) {
  let url = null;
  dd.descendants((node) => {
    if (url) return false;
    node.marks?.forEach((mark) => {
      const { rel: rels, href } = mark.attrs.originalAttributes || {};
      if (!url && href && String(rels || "").split(/\s+/).includes(rel)) url = href;
    });
  });
  return url;
}

const widgetSpec = (key, side) => ({ key, side, ignoreSelection: true, stopEvent: () => true });

function buildDecorations(doc, open) {
  const decos = [];

  KINDS.forEach((kind, index) => {
    const { id, rel } = DOCUMENT_ITEMS[kind];
    const item = findDocumentItem(doc, id);
    const state = open === kind ? "search" : "add";

    if (!item) {
      decos.push(Decoration.widget(documentItemPosition(doc, id), (view) => placeholderWidget(view, kind, open), widgetSpec(`${kind}-placeholder-${state}`, index + 1)));
      return;
    }

    let off = item.pos + 1;
    let entries = 0;
    item.node.forEach((child) => {
      const url = child.type.name === "dd" ? entryURL(child, rel) : null;
      if (url) {
        entries++;
        decos.push(Decoration.widget(off + child.nodeSize - 1, (view) => removeWidget(view, kind, url), widgetSpec(`${kind}-remove-${url}`, 1)));
      }
      off += child.nodeSize;
    });

    // One agent per document
    if (kind !== "agent" || !entries) {
      decos.push(Decoration.widget(item.pos + 1 + item.node.content.size, (view) => addOrSearch(view, kind, open), widgetSpec(`${kind}-${state}`, 1)));
    }
  });

  return DecorationSet.create(doc, decos);
}

export const documentItemsToolsPlugin = new Plugin({
  key: documentItemsToolsKey,
  state: {
    init: (_config, state) => ({ open: null, decorations: buildDecorations(state.doc, null) }),
    apply(tr, value, _oldState, newState) {
      const meta = tr.getMeta(documentItemsToolsKey);
      const open = meta ? meta.open : value.open;
      if (!meta && !tr.docChanged) return value;
      return { open, decorations: buildDecorations(newState.doc, open) };
    }
  },
  props: {
    decorations(state) { return documentItemsToolsKey.getState(state).decorations; }
  }
});

