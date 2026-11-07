/**
 * rc.5 Host plugin half for 06 local diagrams.
 *
 * Thin Cordis adapter only (DIA-DESIGN-2 §9, docs/interfaces.md §10):
 *
 *  - `inject: ['connection']`; the channel is registered through
 *    `ctx.connection.rpc.handle('/local-diagrams', handler)` exactly as the
 *    verified rc.5 interface does, and the registration is owned by `ctx.effect`
 *    so unloading the plugin fiber removes the channel.
 *  - The registry and the document store are loaded lazily from plugin
 *    configuration on the first request, never from the RPC payload:
 *    `config.data_root` is an optional local absolute path (the Host loader is
 *    trusted); the default is `DSH_HOME/local-diagrams`, the same root the
 *    local trusted `tools/registry.mjs` CLI writes. A browser client cannot
 *    register contexts/documents/output roots or point the store elsewhere.
 *  - Every handler result is an `RpcResult`; the adapter never throws. Lazy
 *    initialization failures (missing DSH_HOME, corrupt registry, filesystem
 *    errors) are collapsed to a fixed `INTERNAL_FAILURE` transport error with no
 *    path/configuration echo.
 *  - On unload the channel handler is removed first, then the service is
 *    disposed (editor sessions revoked, further calls rejected). Disposal is
 *    idempotent and awaited by the effect cleanup.
 */

import { loadRegistryFromDirectory, resolveRegistryDataRoot } from '../src/editor/access.mjs';
import { createDocumentStore } from '../src/editor/document-store.mjs';
import { createLocalDiagramsService, CHANNEL } from '../src/plugin/service.mjs';

export const name = 'local-diagrams';
export const inject = ['connection'];
export { CHANNEL };

const FIXED_UNAVAILABLE = Object.freeze({
  ok: false,
  error: { code: 'INTERNAL_FAILURE', message: 'internal failure', details: {} },
});

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readDataRoot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = /** @type {any} */ (value).data_root;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\u0000')) {
    throw new TypeError('local-diagrams: config.data_root must be a non-empty local path string');
  }
  return candidate;
}

/**
 * Cordis plugin body. Returns nothing; all registrations are effect-owned.
 *
 * @param {any} ctx Cordis root/plugin context with `connection` and `effect`.
 * @param {{data_root?:string, limits?:Record<string, number>}} [config]
 */
export function apply(ctx, config) {
  if (!ctx || typeof ctx.effect !== 'function') {
    throw new TypeError('local-diagrams: a Cordis context with effect() is required');
  }
  const connection = ctx.connection;
  if (!connection || !connection.rpc || typeof connection.rpc.handle !== 'function') {
    throw new TypeError('local-diagrams: ctx.connection.rpc.handle is required (inject: [connection])');
  }
  const dataRootOption = readDataRoot(config);
  const limits = config && typeof config === 'object' && config.limits ? config.limits : undefined;

  /** @type {{service:any, registry:any, store:any, unloaded:boolean}} */
  const state = { service: null, registry: null, store: null, unloaded: false };

  /**
   * Lazy, config-only initialization. Throws on failure; the handler converts
   * any throw to the fixed transport error.
   * @returns {any} service
   */
  function ensureService() {
    if (state.unloaded) throw new Error('local-diagrams: plugin unloaded');
    if (state.service !== null) return state.service;
    const dataRoot = resolveRegistryDataRoot(dataRootOption);
    const loaded = loadRegistryFromDirectory(dataRoot);
    const store = createDocumentStore({
      data_root: dataRoot,
      registry: loaded.registry,
      ...(limits === undefined ? {} : { limits }),
    });
    const service = createLocalDiagramsService({ registry: loaded.registry, store, limits });
    state.registry = loaded.registry;
    state.store = store;
    state.service = service;
    return service;
  }

  /** @param {any} endpoint @param {any} payload @param {any} signal @param {any} peer */
  function handler(endpoint, payload, signal, peer) {
    /** @type {any} */
    let service;
    try {
      service = ensureService();
    } catch {
      // No error text, path or configuration may reach the transport.
      return Promise.resolve(FIXED_UNAVAILABLE);
    }
    return service.handle(endpoint, payload, signal, peer);
  }

  ctx.effect(() => {
    // Registration belongs to this fiber: `handle` returns the disposer that
    // removes the /local-diagrams route from the Host web server.
    const removeChannel = connection.rpc.handle(CHANNEL, handler);
    return async () => {
      state.unloaded = true;
      try {
        if (typeof removeChannel === 'function') removeChannel();
      } catch {
        // The transport may already be disposed; continue with service cleanup.
      }
      const service = state.service;
      state.service = null;
      state.registry = null;
      state.store = null;
      if (service && typeof service.dispose === 'function') {
        try {
          await service.dispose();
        } catch {
          // Disposal is best effort; the channel is already gone.
        }
      }
    };
  }, 'local-diagrams: /local-diagrams RPC channel');
}

export default { name, inject, apply };
