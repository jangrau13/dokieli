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

// The agent chat as a widget decoration: in the flow of the document where /agent was typed, but out of the
// document model, so it is never serialised, saved, synced, or recorded in the undo history.
export const agentChatPluginKey = new PluginKey("agentChat");

const closed = { pos: null, dom: null };

export const agentChatPlugin = new Plugin({
  key: agentChatPluginKey,

  state: {
    init: () => closed,
    apply(tr, value) {
      const meta = tr.getMeta(agentChatPluginKey);
      if (meta) return meta.close ? closed : { pos: meta.pos, dom: meta.dom };
      if (value.pos === null || !tr.docChanged) return value;
      return { ...value, pos: tr.mapping.map(value.pos, -1) };
    }
  },

  props: {
    decorations(state) {
      const { pos, dom } = agentChatPluginKey.getState(state);
      if (pos === null) return null;

      return DecorationSet.create(state.doc, [
        Decoration.widget(pos, dom, { key: "agent-chat", side: -1, ignoreSelection: true, stopEvent: () => true })
      ]);
    },

    handleKeyDown(view, event) {
      if (event.key === "Escape" && agentChatPluginKey.getState(view.state).pos !== null) {
        closeAgentChatWidget(view);
      }
      return false;
    }
  }
});

export function openAgentChatWidget(view, pos, dom) {
  view.dispatch(view.state.tr.setMeta(agentChatPluginKey, { pos, dom }).setMeta("addToHistory", false));
}

export function closeAgentChatWidget(view) {
  if (agentChatPluginKey.getState(view.state)?.pos === null) return;
  view.dispatch(view.state.tr.setMeta(agentChatPluginKey, { close: true }).setMeta("addToHistory", false));
}

export function agentChatPosition(state) {
  return agentChatPluginKey.getState(state)?.pos ?? null;
}
