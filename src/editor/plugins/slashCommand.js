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

// Where the "/" that opened the slash menu is, mapped through every change since, so a command removes exactly that
// character, wherever the caret has gone and whatever else changed the document meanwhile.
export const slashCommandPluginKey = new PluginKey("slashCommand");

export const slashCommandPlugin = new Plugin({
  key: slashCommandPluginKey,
  state: {
    init: () => null,
    apply(tr, pos) {
      const meta = tr.getMeta(slashCommandPluginKey);
      if (meta !== undefined) return meta;
      if (pos === null || !tr.docChanged) return pos;
      const mapped = tr.mapping.mapResult(pos, 1);
      return mapped.deleted ? null : mapped.pos;
    }
  }
});

// Remembers the "/" before the caret as the one that opened the menu
export function markSlashCommand(view) {
  const from = view.state.selection.from;
  const pos = from > 0 && view.state.doc.textBetween(from - 1, from) === "/" ? from - 1 : null;
  view.dispatch(view.state.tr.setMeta(slashCommandPluginKey, pos).setMeta("addToHistory", false));
}

// The "/" that opened the menu, as a range, while it is still there
export function slashCommandRange(state) {
  const pos = slashCommandPluginKey.getState(state);
  if (pos === null || pos === undefined || state.doc.textBetween(pos, pos + 1) !== "/") return null;
  return { from: pos, to: pos + 1 };
}
