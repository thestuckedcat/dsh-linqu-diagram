/**
 * Client bundle entry (ui/client-entry.mjs), inlined into plugin/client.js by
 * tools/build-client.mjs.
 *
 * rc.5 lazy-CJS contract: the generated bundle registers
 * `window.__ModuleLoader__.load({id:'dsh-local-diagrams', factory(require){...}})`
 * and the factory returns this module's exports. The loader treats an object with
 * `name`/`inject`/`apply` as one client plugin (same shape as the shipped
 * `@deepseek-ai/dsh-client-ui-*` bundles).
 *
 * The `apply` body is the only Host-facing seam:
 *  - `inject: ['slots','layout','connection']`;
 *  - registers the `main` keyed slot entry `{name:'main', key:'local-diagrams'}`
 *    with a wrapper that closes over this plugin's ctx and renders the panel;
 *  - the panel calls the authenticated `/local-diagrams` RPC channel through
 *    `ctx.connection.rpc.call` and never touches XML files directly.
 *
 * `__test` exposes the inlined pure modules so Node tests (and the isolated
 * editor smoke) can drive the SAME code the browser runs under a fake
 * `window.__ModuleLoader__` + fake `require`.
 */

import { createElement as h } from 'react';

import { LocalDiagramsPanel as LocalDiagramsPanelComponent } from './panel.mjs';
import * as rpc from './rpc.mjs';
import * as commands from './commands.mjs';
import * as view from './view-model.mjs';
import * as xmlDraft from './xml-draft.mjs';
import * as conflict from './conflict.mjs';
import * as hash from './hash.mjs';
import * as descriptor from '../src/descriptor.mjs';
import { createEditorModel, executeEdit, rebaseOverlay, redo, undo } from '../src/editor/model.mjs';
import { canonicalMxGraph, exportDrawio, parseDrawioXml } from '../src/drawio/xml.mjs';

export const name = 'local-diagrams';
export const inject = ['slots', 'layout', 'connection'];
export const PANEL_KEY = 'local-diagrams';
export const PANEL_SLOT = 'main';
export const LocalDiagramsPanel = LocalDiagramsPanelComponent;

/**
 * Client plugin body. Throws (loudly) when the Host wiring is missing; never
 * silently registers half a panel.
 * @param {any} ctx rc.5 client root context
 */
export function apply(ctx) {
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
    throw new TypeError('local-diagrams client: ctx.slots.inject/register are required (inject: [slots])');
  }
  if (!ctx.connection || !ctx.connection.rpc || typeof ctx.connection.rpc.call !== 'function') {
    throw new TypeError('local-diagrams client: ctx.connection.rpc.call is required (inject: [connection])');
  }
  ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, key: PANEL_KEY }, function LocalDiagramsSlot(props) {
    return h(LocalDiagramsPanel, { ...props, ctx });
  }));
}

/** Inlined pure modules for Node tests / the isolated editor smoke. */
export const __test = Object.freeze({
  rpc,
  commands,
  view,
  xmlDraft,
  conflict,
  hash,
  descriptor,
  editor: Object.freeze({ createEditorModel, executeEdit, undo, redo, rebaseOverlay }),
  drawio: Object.freeze({ exportDrawio, parseDrawioXml, canonicalMxGraph }),
});
