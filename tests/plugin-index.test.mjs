/**
 * rc.5 Host plugin adapter tests: channel registration through ctx.effect,
 * effect-owned disposal, lazy config-only data-root loading, no client grants.
 *
 * The fake Cordis context mirrors the two facts we verified in the extracted
 * rc.5 sources: `ctx.connection.rpc.handle(channel, handler)` returns a
 * disposer, and `ctx.effect(fn)` owns registrations for the plugin fiber.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import plugin, { apply, inject, name } from '../plugin/index.mjs';
import { saveRegistryToDirectory } from '../src/editor/access.mjs';
import { validateRpcResponse } from '../src/contracts.mjs';
import { buildArtifactPackage, tempRoot, testRegistry } from './fixtures/store/helpers.mjs';

/** @param {string} [principalId] */
function fakePeer(principalId = 'owner-1') {
  return { principal: { kind: 'owner', principal_id: principalId }, signal: new AbortController().signal };
}

/**
 * Fake Cordis root context: effect(fn) runs the body immediately and retains the
 * returned disposer, exactly like the fiber-scoped registration the Host uses.
 */
function fakeCtx() {
  const state = {
    effects: [],
    channel: null,
    handler: null,
    removeCalls: 0,
    labels: [],
  };
  return {
    state,
    effect(fn, label) {
      state.labels.push(label);
      const disposer = fn();
      state.effects.push(disposer);
      return () => {
        state.removeCalls += 1;
        return typeof disposer === 'function' ? disposer() : undefined;
      };
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          state.channel = channel;
          state.handler = handler;
          return () => {
            state.removeCalls += 1;
          };
        },
      },
    },
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{mode?:'read'|'edit'}} [options]
 */
function setupPlugin(t, options = {}) {
  const artifactRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  buildArtifactPackage(artifactDir);
  const dataRoot = tempRoot(t);
  const registry = testRegistry({
    root: artifactRoot,
    artifact_directory: artifactDir,
    mode: options.mode ?? 'edit',
  });
  saveRegistryToDirectory(dataRoot, registry);
  const ctx = fakeCtx();
  apply(ctx, { data_root: dataRoot });
  return { artifactRoot, artifactDir, dataRoot, registry, ctx };
}

function shell(operationId, input, overrides = {}) {
  return {
    schema_version: 1,
    operation_id: operationId,
    context_ref: 'ctx-demo',
    expected_scope_generation: 0,
    view_epoch: 3,
    input,
    ...overrides,
  };
}

test('plugin: module exports the rc.5 host plugin shape', () => {
  assert.equal(name, 'local-diagrams');
  assert.deepEqual([...inject], ['connection']);
  assert.equal(typeof apply, 'function');
  assert.equal(plugin.name, 'local-diagrams');
  assert.deepEqual([...plugin.inject], ['connection']);
  assert.equal(plugin.apply, apply);
});

test('plugin: rejects a context without effect/connection and an invalid data_root config', () => {
  assert.throws(() => apply(undefined, {}), TypeError);
  assert.throws(() => apply({ effect() {} }, {}), TypeError);
  assert.throws(
    () => apply({ effect() {}, connection: { rpc: { handle() {} } } }, { data_root: 42 }),
    TypeError,
  );
  assert.throws(
    () => apply({ effect() {}, connection: { rpc: { handle() {} } } }, { data_root: 'C:/tmp\u0000evil' }),
    TypeError,
  );
});

test('plugin: registers the /local-diagrams channel once through ctx.effect', (t) => {
  const { ctx } = setupPlugin(t);
  assert.equal(ctx.state.channel, '/local-diagrams');
  assert.equal(typeof ctx.state.handler, 'function');
  assert.equal(ctx.state.effects.length, 1);
  assert.match(String(ctx.state.labels[0]), /local-diagrams/u);
});

test('plugin: first RPC opens a registered document and returns a closed business response', async (t) => {
  const { ctx, artifactDir, dataRoot } = setupPlugin(t);
  const result = await ctx.state.handler(
    'document.open',
    shell('op-plugin-open-1', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const business = result.value;
  assert.equal(business.status, 'ok');
  assert.equal(business.scope_generation, 0);
  assert.ok(validateRpcResponse(business).ok === true);
  assert.equal(business.data.document_id, 'doc-001');
  assert.equal(business.data.version.generation, 0);
  const text = JSON.stringify(business);
  assert.equal(text.includes(artifactDir), false);
  assert.equal(text.includes(dataRoot), false);
});

test('plugin: lazy initialization touches the filesystem only on the first call', async (t) => {
  const artifactRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  buildArtifactPackage(artifactDir);
  const targetRoot = path.join(tempRoot(t), 'not-created-yet');
  const ctx = fakeCtx();
  apply(ctx, { data_root: targetRoot });
  assert.equal(fs.existsSync(targetRoot), false, 'apply must not load the registry');
  // No registered document at the new root: the lazy load creates the registry
  // directory and then denies the unknown document.
  const result = await ctx.state.handler(
    'document.open',
    shell('op-plugin-lazy-1', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(targetRoot), true, 'first call creates/loads the data root');
  assert.equal(result.value.status, 'denied');
  // Empty registry: the shell context itself is not registered.
  assert.equal(result.value.reason_code, 'CONTEXT_UNBOUND');
});

test('plugin: default data root is DSH_HOME/local-diagrams (config.data_root is optional)', async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = tempRoot(t);
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const artifactRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  buildArtifactPackage(artifactDir);
  const registry = testRegistry({ root: artifactRoot, artifact_directory: artifactDir });
  const localRoot = path.join(home, 'local-diagrams');
  saveRegistryToDirectory(localRoot, registry);

  const ctx = fakeCtx();
  apply(ctx, {}); // no data_root
  const result = await ctx.state.handler(
    'document.open',
    shell('op-plugin-home-1', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'ok');
  assert.equal(fs.existsSync(path.join(localRoot, 'registry.json')), true);
});

test('plugin: missing DSH_HOME and no config yields a fixed, path-free failure', async (t) => {
  const previousHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  t.after(() => {
    if (previousHome !== undefined) process.env.DSH_HOME = previousHome;
  });
  const ctx = fakeCtx();
  apply(ctx, {});
  const result = await ctx.state.handler(
    'document.open',
    shell('op-plugin-nohome-1', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'INTERNAL_FAILURE', message: 'internal failure', details: {} },
  });
  assert.equal(JSON.stringify(result).includes('DSH_HOME'), false);
});

test('plugin: a corrupt registry is a fixed failure, never a thrown exception or path echo', async (t) => {
  const dataRoot = tempRoot(t);
  fs.writeFileSync(path.join(dataRoot, 'registry.json'), '{not-json', 'utf8');
  const ctx = fakeCtx();
  apply(ctx, { data_root: dataRoot });
  const result = await ctx.state.handler(
    'document.open',
    shell('op-plugin-corrupt-1', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'INTERNAL_FAILURE', message: 'internal failure', details: {} },
  });
  assert.equal(JSON.stringify(result).includes(dataRoot), false);
  assert.equal(JSON.stringify(result).includes('not-json'), false);
});

test('plugin: RPC payload cannot register grants, change the data root or bypass the owner gate', async (t) => {
  const { ctx, dataRoot } = setupPlugin(t);
  const attempts = [
    // payload-level grant/config smuggling is an endpoint input schema violation
    shell('op-plugin-grant-1', {
      document_ref: 'doc-demo',
      caller: { principal: { kind: 'owner' } },
      data_root: path.join(dataRoot, 'evil'),
    }),
    shell('op-plugin-path-1', { document_ref: path.join(dataRoot, '..', 'evil') }),
  ];
  for (const payload of attempts) {
    const result = await ctx.state.handler('document.open', payload, undefined, fakePeer());
    assert.equal(result.ok, true);
    assert.equal(result.value.status, 'invalid');
    assert.equal(result.value.reason_code, 'INVALID_REQUEST');
  }
  const nonOwner = await ctx.state.handler(
    'document.open',
    shell('op-plugin-api-1', { document_ref: 'doc-demo' }),
    undefined,
    { principal: { kind: 'api' }, signal: new AbortController().signal },
  );
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.error.code, 'OWNER_REQUIRED');
});

test('plugin: unload removes the channel, revokes sessions and rejects later calls', async (t) => {
  const { ctx } = setupPlugin(t);
  const opened = await ctx.state.handler(
    'document.open',
    shell('op-plugin-unload-open', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.equal(opened.ok, true);
  assert.equal(opened.value.status, 'ok');
  const handler = ctx.state.handler;
  assert.equal(ctx.state.removeCalls, 0);

  const effectDisposer = ctx.state.effects[0];
  await effectDisposer();
  assert.equal(ctx.state.removeCalls, 1, 'channel disposer must run');

  // Old captured handler reference: unload must revoke the service, not reload it.
  const afterUnload = await handler(
    'document.open',
    shell('op-plugin-unload-after', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.deepEqual(afterUnload, {
    ok: false,
    error: { code: 'INTERNAL_FAILURE', message: 'internal failure', details: {} },
  });

  // Disposal is idempotent; a second unload is a no-op.
  await effectDisposer();
  assert.equal(ctx.state.removeCalls, 2);
});

test('plugin: session.close through the channel revokes the store session', async (t) => {
  const { ctx } = setupPlugin(t);
  const opened = await ctx.state.handler(
    'document.open',
    shell('op-plugin-close-open', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  const data = opened.value.data;
  assert.equal(typeof data.editor_session_ref, 'string');
  const closed = await ctx.state.handler(
    'session.close',
    shell('op-plugin-close-1', { editor_session_ref: data.editor_session_ref }),
    undefined,
    fakePeer(),
  );
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.value.data, { closed: true });
});

test('plugin: read-only document mode denies save even through the owner channel', async (t) => {
  const { ctx } = setupPlugin(t, { mode: 'read' });
  const opened = await ctx.state.handler(
    'document.open',
    shell('op-plugin-read-open', { document_ref: 'doc-demo' }),
    undefined,
    fakePeer(),
  );
  assert.equal(opened.ok, true);
  assert.equal(opened.value.status, 'ok');
  const data = opened.value.data;
  const save = await ctx.state.handler(
    'document.save',
    shell('op-plugin-read-save', {
      document_id: data.document_id,
      editor_session_ref: data.editor_session_ref,
      expected_version: data.version,
      xml: data.xml,
      overlay: data.overlay,
    }),
    undefined,
    fakePeer(),
  );
  assert.equal(save.ok, true);
  assert.equal(save.value.status, 'denied');
  assert.equal(save.value.reason_code, 'DOCUMENT_DENIED');
});
