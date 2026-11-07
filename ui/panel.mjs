/**
 * Default local editor panel (ui/panel.mjs) - the React view registered into the
 * rc.5 main keyed slot as `local-diagrams` by ui/client-entry.mjs.
 *
 * Behaviour (DIA-DESIGN-2 §7/§9.1, docs/interfaces.md §11):
 *  - displays the Host-provided canonical base + local annotation overlay as a
 *    whitelisted SVG scene (all elements/attributes come from ui/view-model.mjs),
 *    with source/version bar, certainty legend, unresolved/truncated warnings,
 *    hidden-entity counts, orphaned-annotation count and a text-equivalent list;
 *  - editing commands are executed locally through `src/editor/model.mjs`
 *    (inlined); the Host is only contacted on open/save/export/status/close;
 *  - node drag uses Pointer Events + pointer capture and commits exactly one
 *    `move_node` command on pointerup; cancel commits nothing; arrow keys move
 *    8 px (Shift 1 px); a coordinate form is the no-drag fallback;
 *  - notes, conceptual annotation nodes, annotation edges, annotation removal,
 *    annotation-node relabel and base visibility are all regular command-union
 *    edits; undo/redo replay the model history;
 *  - save sends the model overlay + XML built by the same deterministic exporter
 *    as the Host with the exact `expected_version`; conflicts show keep
 *    both/export draft/reopen; an unknown outcome polls `operation.get` once per
 *    second with one request in flight;
 *  - every RPC result is interpreted by ui/rpc.mjs (`result.ok` first, closed-union
 *    validation, stale-epoch responses ignored); no server message/path is shown;
 *  - only whitelisted DOM/SVG elements are created; no eval/new Function/fetch/
 *    WebSocket/remote URLs. Document references come from a small in-memory
 *    recent list or the 08 navigation event, and the Host registry validates
 *    every open.
 */

import {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { OPEN_EVENT, validateOpenEventDetail } from '../src/descriptor.mjs';
import { createEditorModel, rebaseOverlay } from '../src/editor/model.mjs';
import { buildRequest, callEndpoint, makeOperationId } from './rpc.mjs';
import {
  annotationEdgePayload,
  annotationNodePayload,
  beginDrag,
  cancelDrag,
  commitDrag,
  coordinateMove,
  keyboardMove,
  makeAnnotationId,
  mergeOverlayItems,
  nodePosition,
  noteForTarget,
  notePayload,
  removeAnnotationNodePayload,
  removeAnnotationPayload,
  runEdit,
  updateDrag,
  visibilityPayload,
} from './commands.mjs';
import { buildSvgScene, buildViewState } from './view-model.mjs';
import { buildSaveInput, draftExportPlan } from './xml-draft.mjs';
import {
  CONFLICT_OPTIONS,
  conflictView,
  describeOperationResult,
  describeSaveFailure,
  operationPollPlan,
  resolveConflict,
  SAVE_REASON_MESSAGES,
} from './conflict.mjs';

export const PANEL_CHANNEL = '/local-diagrams';

const OPEN_REASON_MESSAGES = Object.freeze({
  CONTEXT_UNBOUND: 'This document reference is not registered in any local scope.',
  SCOPE_REVOKED: 'The workspace scope changed. Reopen from a registered reference.',
  DOCUMENT_DENIED: 'This document is not registered for editing in the current scope.',
  OWNER_REQUIRED: 'The local editor channel requires the application owner session.',
  LIMIT_EXCEEDED: 'The document exceeds the local size limits.',
  INVALID_XML: 'The stored document XML is not valid.',
  INVALID_OVERLAY: 'The stored annotation overlay is not valid.',
  INTERNAL_FAILURE: 'The local editor failed unexpectedly.',
});

const EXPORT_REASON_MESSAGES = Object.freeze({
  EXPORT_EXISTS: 'A file with this name already exists in the output directory. Nothing was overwritten.',
  DOCUMENT_DENIED: 'The output directory is not registered for this scope.',
  STALE_VERSION: 'The document changed. Reopen before exporting.',
  UNSUPPORTED_FORMAT: 'This export format is not supported locally.',
  LIMIT_EXCEEDED: 'The export exceeds the local size limits.',
  INTERNAL_FAILURE: 'The local export failed unexpectedly.',
});

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', height: '100%', boxSizing: 'border-box', overflow: 'auto', fontFamily: 'sans-serif', fontSize: '13px' },
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  card: { border: '1px solid #d0d7de', borderRadius: '6px', padding: '8px', background: '#ffffff' },
  muted: { color: '#57606a' },
  error: { color: '#b42318' },
  ok: { color: '#1a7f37' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  input: { padding: '3px 6px', border: '1px solid #d0d7de', borderRadius: '4px', fontSize: '12px' },
  svgWrap: { border: '1px solid #d0d7de', borderRadius: '6px', background: '#fafbfc', overflow: 'auto', outline: 'none' },
  columns: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' },
  sidebar: { width: '320px', minWidth: '280px', display: 'flex', flexDirection: 'column', gap: '8px' },
  list: { margin: 0, paddingLeft: '18px' },
};

/** @param {string} text @param {boolean} [danger] @returns {any} */
function message(text, danger = false) {
  return h('div', { style: danger ? styles.error : styles.muted }, text);
}

/** Small button factory. `key` is forwarded through createElement config. */
function button(props) {
  return h(
    'button',
    {
      key: props.key,
      type: 'button',
      onClick: props.onClick,
      disabled: props.disabled === true,
      title: props.title ?? props.label,
      style: {
        padding: '4px 10px',
        borderRadius: '4px',
        border: props.primary ? '1px solid #0969da' : '1px solid #d0d7de',
        background: props.primary ? '#0969da' : '#f6f8fa',
        color: props.primary ? '#ffffff' : '#1f2328',
        cursor: props.disabled === true ? 'not-allowed' : 'pointer',
        fontSize: '12px',
      },
    },
    props.label,
  );
}

/** Build the panel view state from the opened session + current editor model. */
function buildViewStateFor(session, model, selection) {
  return buildViewState({
    base_spec: session.base_spec,
    overlay: model.overlay,
    selection: selection === null ? [] : [selection],
    current_version: session.version,
    warnings: session.warnings,
  });
}

/** @param {any} scene @returns {any} React element tree; tags come from the whitelist. */
function renderScene(scene) {
  if (typeof scene === 'string') return scene;
  const children = (scene.children ?? []).map((child) => renderScene(child));
  return h(scene.tag, scene.attrs ?? {}, ...children);
}

/** Hit-test scene coordinates against visible nodes (topmost first). */
function hitTest(view, point) {
  const nodes = view?.nodes ?? [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.hidden === true) continue;
    if (point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height) {
      return node.id;
    }
  }
  return null;
}

/** Convert a pointer event into scene coordinates. */
function scenePoint(event, svgElement, view) {
  const rect = typeof svgElement.getBoundingClientRect === 'function' ? svgElement.getBoundingClientRect() : null;
  const bounds = view?.bounds ?? { min_x: 0, min_y: 0, width: 1, height: 1 };
  if (rect === null || rect.width <= 0 || rect.height <= 0) {
    return { x: bounds.min_x + (event.clientX ?? 0), y: bounds.min_y + (event.clientY ?? 0) };
  }
  return {
    x: bounds.min_x + ((event.clientX - rect.left) / rect.width) * bounds.width,
    y: bounds.min_y + ((event.clientY - rect.top) / rect.height) * bounds.height,
  };
}

/** Local-only draft download; returns false in non-DOM environments. */
function downloadBlob(filename, mediaType, content) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([content], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  if (typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/**
 * Panel component. Receives `{ctx}` from the slot wrapper created in `apply`.
 * @param {{ctx:any}} props
 * @returns {any}
 */
export function LocalDiagramsPanel(props) {
  const transport = props?.ctx?.connection?.rpc;

  const [recent, setRecent] = useState([]);
  const [contextRef, setContextRef] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [scopeGeneration, setScopeGeneration] = useState('0');
  const [outputRef, setOutputRef] = useState('');
  const [session, setSession] = useState(null);
  const [model, setModel] = useState(null);
  const [selection, setSelection] = useState(null);
  const [connectFrom, setConnectFrom] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [annotationLabel, setAnnotationLabel] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [coordX, setCoordX] = useState('');
  const [coordY, setCoordY] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [saveStatus, setSaveStatus] = useState('clean');
  const [operationView, setOperationView] = useState(null);
  const [preview, setPreview] = useState(null);
  const [exportStatus, setExportStatus] = useState(null);

  const viewEpochRef = useRef(0);
  const operationSeqRef = useRef(0);
  const commandSeqRef = useRef(0);
  const sessionRef = useRef(null);
  const modelRef = useRef(null);
  const activeRef = useRef(null);
  const dragRef = useRef(null);
  const abortRef = useRef(typeof AbortController === 'function' ? new AbortController() : null);
  const pollRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const openEntryRef = useRef(null);

  sessionRef.current = session;
  modelRef.current = model;

  const nextOperationId = useCallback((prefix) => {
    operationSeqRef.current += 1;
    return makeOperationId(prefix, operationSeqRef.current);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    stopPolling();
    if (abortRef.current && typeof abortRef.current.abort === 'function') abortRef.current.abort();
  }, [stopPolling]);

  const showNotice = useCallback((kind, text) => setNotice({ kind, text }), []);

  const storeActive = useCallback((entry, epoch) => {
    viewEpochRef.current = epoch;
    activeRef.current = {
      context_ref: entry.context_ref,
      expected_scope_generation: entry.expected_scope_generation,
      document_ref: entry.document_ref,
    };
  }, []);

  const beginDocument = useCallback((data, entry, epoch) => {
    const nextModel = createEditorModel(data.base_spec, data.overlay);
    storeActive(entry, epoch);
    setModel(nextModel);
    modelRef.current = nextModel;
    setSelection(null);
    setConflict(null);
    setSaveStatus('clean');
    setOperationView(null);
    setSession({
      document_id: data.document_id,
      base_spec: data.base_spec,
      overlay: data.overlay,
      version: data.version,
      editor_session_ref: data.editor_session_ref,
      warnings: data.warnings,
    });
    setContextRef(entry.context_ref);
    setDocumentRef(entry.document_ref);
    setScopeGeneration(String(entry.expected_scope_generation));
    setRecent((current) => {
      const filtered = current.filter(
        (item) => !(item.context_ref === entry.context_ref && item.document_ref === entry.document_ref),
      );
      return [{ ...entry }, ...filtered].slice(0, 8);
    });
  }, [storeActive]);

  const openEntry = useCallback(async (entry) => {
    if (!transport || busy) return;
    if (entry === null || entry === undefined) return;
    setBusy(true);
    setConflict(null);
    setOperationView(null);
    const epoch = viewEpochRef.current + 1;
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-open'),
      context_ref: entry.context_ref,
      expected_scope_generation: entry.expected_scope_generation,
      view_epoch: epoch,
      input: { document_ref: entry.document_ref },
    });
    if (requestResult.ok !== true) {
      setBusy(false);
      showNotice('error', 'The document reference is not a valid registered reference.');
      return;
    }
    const interpreted = await callEndpoint(
      transport,
      'document.open',
      requestResult.request,
      abortRef.current?.signal,
      entry.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind === 'ok') {
      const data = interpreted.data;
      if (
        typeof data?.document_id !== 'string' ||
        typeof data?.base_spec !== 'object' ||
        data.base_spec === null ||
        typeof data?.overlay !== 'object' ||
        data.overlay === null ||
        typeof data?.version !== 'object' ||
        data.version === null ||
        typeof data?.editor_session_ref !== 'string'
      ) {
        showNotice('error', 'The local editor returned an unbalanced open payload.');
        return;
      }
      try {
        beginDocument(data, entry, epoch);
        showNotice('success', `Opened ${data.document_id} (${entry.document_ref}).`);
      } catch {
        showNotice('error', 'The opened document could not be prepared for editing.');
      }
      return;
    }
    if (interpreted.kind === 'business_failure') {
      const reason = OPEN_REASON_MESSAGES[interpreted.reason_code] ?? OPEN_REASON_MESSAGES.INTERNAL_FAILURE;
      showNotice('error', reason);
      return;
    }
    if (interpreted.kind === 'stale_epoch') return;
    showNotice('error', interpreted.message ?? OPEN_REASON_MESSAGES.INTERNAL_FAILURE);
  }, [beginDocument, busy, nextOperationId, showNotice, transport]);
  openEntryRef.current = openEntry;

  // 08 navigation adapter contract: validate the event detail and open through
  // the same Host-validated path. Never accepts XML/paths from the event.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    const onOpenEvent = (event) => {
      const validated = validateOpenEventDetail(event?.detail);
      if (validated.ok !== true) return;
      const handler = openEntryRef.current;
      if (typeof handler === 'function') handler(validated.intent);
    };
    window.addEventListener(OPEN_EVENT, onOpenEvent);
    return () => window.removeEventListener(OPEN_EVENT, onOpenEvent);
  }, []);

  /** Apply one local command through the editor model. */
  const applyEdit = useCallback((kind, payload) => {
    const current = modelRef.current;
    if (current === null) return { ok: false, code: 'NO_DOCUMENT' };
    commandSeqRef.current += 1;
    const result = runEdit({ model: current, kind, payload, sequence: commandSeqRef.current });
    if (result.status === 'ok') {
      setModel(result.model);
      modelRef.current = result.model;
      setSaveStatus((status) => (status === 'saving' ? status : 'dirty'));
      return { ok: true, model: result.model };
    }
    showNotice(
      'error',
      result.status === 'stale'
        ? 'A newer edit landed first; this command was ignored.'
        : 'The local editor rejected this edit. No change was made.',
    );
    return { ok: false, code: result.code ?? 'INVALID' };
  }, [showNotice]);

  const view = useMemo(() => {
    if (session === null || model === null) return null;
    return buildViewStateFor(session, model, selection);
  }, [session, model, selection]);

  const scene = useMemo(() => {
    if (view === null) return null;
    return buildSvgScene(view, { selected: selection, connect_from: connectFrom, preview });
  }, [view, selection, connectFrom, preview]);

  /* ------------------------------- pointer -------------------------------- */

  const onPointerDown = useCallback((event) => {
    if (view === null) return;
    const svgElement = event.currentTarget;
    const point = scenePoint(event, svgElement, view);
    const nodeId = hitTest(view, point);
    if (nodeId === null) {
      setSelection(null);
      return;
    }
    setSelection(nodeId);
    setNoteText(noteForTarget(modelRef.current, nodeId)?.text ?? '');
    setCoordX(String(Math.round(point.x)));
    setCoordY(String(Math.round(point.y)));
    if (connectFrom !== null && connectFrom !== nodeId) {
      commandSeqRef.current += 1;
      applyEdit('add_annotation_edge', annotationEdgePayload({
        id: makeAnnotationId('edge', commandSeqRef.current),
        from: connectFrom,
        to: nodeId,
        label: '',
      }));
      setConnectFrom(null);
      return;
    }
    const position = nodePosition(modelRef.current, nodeId, sessionRef.current?.base_spec);
    if (position === null) return;
    const dragResult = beginDrag({
      node_id: nodeId,
      pointer_id: event.pointerId ?? 0,
      position,
      client_x: point.x,
      client_y: point.y,
    });
    if (dragResult.ok !== true) return;
    dragRef.current = dragResult.drag;
    setPreview({ node_id: nodeId, x: position.x, y: position.y });
    if (typeof svgElement.setPointerCapture === 'function') {
      try {
        svgElement.setPointerCapture(event.pointerId);
      } catch {
        // pointer capture is best effort; pointerup still commits.
      }
    }
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }, [applyEdit, connectFrom, view]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (drag === null || view === null) return;
    const point = scenePoint(event, event.currentTarget, view);
    const next = updateDrag(drag, { client_x: point.x, client_y: point.y });
    setPreview({ node_id: drag.node_id, x: next.x, y: next.y });
  }, [view]);

  const onPointerUp = useCallback((event) => {
    const drag = dragRef.current;
    if (drag === null || view === null) return;
    dragRef.current = null;
    const point = scenePoint(event, event.currentTarget, view);
    const committed = commitDrag(drag, { client_x: point.x, client_y: point.y });
    setPreview(null);
    if (committed.ok !== true) return;
    applyEdit('move_node', committed.payload);
  }, [applyEdit, view]);

  const onPointerCancel = useCallback(() => {
    if (dragRef.current !== null) {
      cancelDrag(dragRef.current);
      dragRef.current = null;
    }
    setPreview(null);
  }, []);

  /* ------------------------------- keyboard ------------------------------- */

  const onKeyDown = useCallback((event) => {
    if (selection === null || sessionRef.current === null) return;
    const position = nodePosition(modelRef.current, selection, sessionRef.current.base_spec);
    if (position === null) return;
    const move = keyboardMove({ node_id: selection, position, key: event.key, shift: event.shiftKey === true });
    if (move.ok !== true) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    applyEdit('move_node', move.payload);
  }, [applyEdit, selection]);

  /* ---------------------------------- open -------------------------------- */

  const openFromForm = useCallback(() => {
    const generation = Number.parseInt(scopeGeneration, 10);
    const entry = {
      context_ref: contextRef.trim(),
      document_ref: documentRef.trim(),
      expected_scope_generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    };
    if (entry.context_ref === '' || entry.document_ref === '') {
      showNotice('error', 'Enter a registered context ref and document ref.');
      return;
    }
    openEntry(entry);
  }, [contextRef, documentRef, openEntry, scopeGeneration, showNotice]);

  /* ---------------------------------- save -------------------------------- */

  const pollOperation = useCallback((operationRef) => {
    if (!transport || typeof operationRef !== 'string' || operationRef.length === 0) return;
    stopPolling();
    let attempts = 0;
    let inFlight = false;
    pollRef.current = setInterval(async () => {
      if (inFlight) return;
      const active = activeRef.current;
      if (active === null) {
        stopPolling();
        return;
      }
      const plan = operationPollPlan({ attempt: attempts, operation_ref: operationRef });
      if (plan.poll !== true) {
        stopPolling();
        return;
      }
      inFlight = true;
      attempts += 1;
      const requestResult = buildRequest({
        operation_id: nextOperationId('op-status'),
        context_ref: active.context_ref,
        expected_scope_generation: active.expected_scope_generation,
        view_epoch: viewEpochRef.current,
        input: { operation_ref: operationRef },
      });
      if (requestResult.ok !== true) {
        inFlight = false;
        stopPolling();
        return;
      }
      const interpreted = await callEndpoint(
        transport,
        'operation.get',
        requestResult.request,
        undefined,
        active.expected_scope_generation,
      );
      inFlight = false;
      if (interpreted.kind !== 'ok') return;
      const described = describeOperationResult(interpreted.data);
      setOperationView(described);
      if (described.state === 'saved' || described.state === 'failed') {
        stopPolling();
        if (described.state === 'saved' && described.recovered_version !== null) {
          setSession((current) => (current === null ? current : { ...current, version: described.recovered_version }));
          sessionRef.current = sessionRef.current === null
            ? sessionRef.current
            : { ...sessionRef.current, version: described.recovered_version };
          setSaveStatus('saved');
        } else {
          setSaveStatus('failed');
        }
      }
    }, 1000);
  }, [nextOperationId, stopPolling, transport]);

  const saveDocument = useCallback(async () => {
    if (!transport) {
      showNotice('error', 'The local editor channel is unavailable.');
      return;
    }
    const current = sessionRef.current;
    const currentModel = modelRef.current;
    const active = activeRef.current;
    if (current === null || currentModel === null || active === null) return;
    setBusy(true);
    setConflict(null);
    const built = buildSaveInput({
      document_id: current.document_id,
      editor_session_ref: current.editor_session_ref,
      expected_version: current.version,
      base_spec: current.base_spec,
      overlay: currentModel.overlay,
    });
    if (built.ok !== true) {
      setBusy(false);
      showNotice('error', SAVE_REASON_MESSAGES[built.code] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE);
      return;
    }
    setSaveStatus('saving');
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-save'),
      context_ref: active.context_ref,
      expected_scope_generation: active.expected_scope_generation,
      view_epoch: viewEpochRef.current,
      input: built.input,
    });
    if (requestResult.ok !== true) {
      setBusy(false);
      setSaveStatus('failed');
      showNotice('error', SAVE_REASON_MESSAGES.INVALID_REQUEST);
      return;
    }
    pendingSaveRef.current = requestResult.request.operation_id;
    const interpreted = await callEndpoint(
      transport,
      'document.save',
      requestResult.request,
      abortRef.current?.signal,
      active.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind === 'ok') {
      const version = interpreted.data?.version;
      if (typeof version?.generation !== 'number') {
        setSaveStatus('failed');
        showNotice('error', SAVE_REASON_MESSAGES.INTERNAL_FAILURE);
        return;
      }
      const nextSession = { ...current, version, overlay: currentModel.overlay };
      sessionRef.current = nextSession;
      setSession(nextSession);
      setSaveStatus('saved');
      showNotice('success', `Saved revision ${version.generation}.`);
      return;
    }
    if (interpreted.kind === 'business_failure') {
      const described = describeSaveFailure(interpreted);
      if (interpreted.status === 'conflict' && described.conflict !== null) {
        setConflict(conflictView({
          current_version: described.conflict.current_version,
          draft_ref: described.conflict.draft_ref,
          local_overlay: currentModel.overlay,
          document_id: current.document_id,
        }));
        setSaveStatus('conflict');
      } else if (interpreted.reason_code === 'OUTCOME_UNKNOWN' || interpreted.reason_code === 'CANCELLED') {
        setSaveStatus('unknown');
        setOperationView({ state: 'unknown', message: described.message, recovered_version: null });
        pollOperation(pendingSaveRef.current);
      } else {
        setSaveStatus('failed');
      }
      showNotice('error', described.message);
      return;
    }
    if (interpreted.kind === 'stale_epoch') {
      setSaveStatus('dirty');
      showNotice('error', 'A stale view response was ignored. Save again to confirm the current revision.');
      return;
    }
    // Transport failure / invalid envelope: the write outcome is unknown; poll
    // the operation record instead of blindly retrying.
    setSaveStatus('unknown');
    pollOperation(pendingSaveRef.current);
    showNotice('error', interpreted.message ?? SAVE_REASON_MESSAGES.OUTCOME_UNKNOWN);
  }, [nextOperationId, pollOperation, showNotice, transport]);

  /* ------------------------------- conflict ------------------------------- */

  const reopenWithLocalOverlay = useCallback(async (localOverlay) => {
    const active = activeRef.current;
    if (active === null || !transport) return false;
    const epoch = viewEpochRef.current + 1;
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-reopen'),
      context_ref: active.context_ref,
      expected_scope_generation: active.expected_scope_generation,
      view_epoch: epoch,
      input: { document_ref: active.document_ref },
    });
    if (requestResult.ok !== true) return false;
    setBusy(true);
    const interpreted = await callEndpoint(
      transport,
      'document.open',
      requestResult.request,
      abortRef.current?.signal,
      active.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind !== 'ok') {
      showNotice('error', interpreted.message ?? OPEN_REASON_MESSAGES.INTERNAL_FAILURE);
      return false;
    }
    const data = interpreted.data;
    try {
      // Keep both: rebase the local draft onto the reopened Host base, then
      // merge the Host's current overlay items so neither side is lost. An
      // invalid merged composite falls back to the Host overlay only.
      const rebased = rebaseOverlay(data.base_spec, localOverlay);
      const mergedOverlay = {
        ...rebased.overlay,
        items: mergeOverlayItems(data.overlay, rebased.overlay),
      };
      /** @type {any} */
      let nextModel;
      try {
        nextModel = createEditorModel(data.base_spec, mergedOverlay);
      } catch {
        nextModel = createEditorModel(data.base_spec, data.overlay);
      }
      const nextSession = {
        document_id: data.document_id,
        base_spec: data.base_spec,
        overlay: nextModel.overlay,
        version: data.version,
        editor_session_ref: data.editor_session_ref,
        warnings: data.warnings,
      };
      viewEpochRef.current = epoch;
      setSession(nextSession);
      sessionRef.current = nextSession;
      setModel(nextModel);
      modelRef.current = nextModel;
      setConflict(null);
      setSaveStatus('dirty');
      showNotice(
        rebased.orphaned.length > 0 ? 'error' : 'info',
        rebased.orphaned.length > 0
          ? `${rebased.orphaned.length} annotation(s) lost their target and are preserved as orphaned.`
          : 'Local annotations were rebased and merged onto the current Host revision.',
      );
      return true;
    } catch {
      showNotice('error', 'The local annotations could not be rebased onto the current revision.');
      return false;
    }
  }, [nextOperationId, showNotice, transport]);

  const onConflictChoice = useCallback(async (choice) => {
    if (conflict === null || modelRef.current === null) return;
    const resolution = resolveConflict({
      choice,
      current_version: conflict.current_version,
      local: { overlay: modelRef.current.overlay },
    });
    if (resolution.ok !== true) {
      showNotice('error', SAVE_REASON_MESSAGES.STALE_VERSION);
      return;
    }
    if (resolution.action === 'download_draft') {
      const built = buildSaveInput({
        document_id: sessionRef.current?.document_id ?? '',
        editor_session_ref: sessionRef.current?.editor_session_ref ?? '',
        expected_version: sessionRef.current?.version,
        base_spec: sessionRef.current?.base_spec,
        overlay: modelRef.current.overlay,
      });
      if (built.ok !== true) {
        showNotice('error', SAVE_REASON_MESSAGES[built.code] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE);
        return;
      }
      const plan = draftExportPlan({
        document_id: sessionRef.current?.document_id ?? '',
        generation: sessionRef.current?.version?.generation ?? 0,
        xml: built.xml,
        overlay: modelRef.current.overlay,
      });
      if (plan.ok !== true || !downloadBlob(plan.filename, plan.media_type, plan.content)) {
        showNotice('error', 'The local draft could not be downloaded in this environment.');
        return;
      }
      showNotice('success', `Draft ${plan.filename} downloaded locally.`);
      return;
    }
    const reopened = await reopenWithLocalOverlay(modelRef.current.overlay);
    if (reopened && resolution.action === 'reopen_then_resave') {
      // The Host keeps its conflicting revision immutable; saving the rebased
      // overlay as the next revision preserves both sides.
      await saveDocument();
    }
  }, [conflict, reopenWithLocalOverlay, saveDocument, showNotice]);

  /* -------------------------------- export -------------------------------- */

  const exportFormat = useCallback(async (format) => {
    if (!transport) return;
    const current = sessionRef.current;
    const active = activeRef.current;
    const output = outputRef.trim();
    if (current === null || active === null) return;
    if (output === '') {
      showNotice('error', 'Enter a registered output ref before exporting.');
      return;
    }
    setBusy(true);
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-export'),
      context_ref: active.context_ref,
      expected_scope_generation: active.expected_scope_generation,
      view_epoch: viewEpochRef.current,
      input: { document_id: current.document_id, version: current.version, output_ref: output, format },
    });
    if (requestResult.ok !== true) {
      setBusy(false);
      showNotice('error', SAVE_REASON_MESSAGES.INVALID_REQUEST);
      return;
    }
    const interpreted = await callEndpoint(
      transport,
      'document.export',
      requestResult.request,
      abortRef.current?.signal,
      active.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind === 'ok') {
      const data = interpreted.data;
      if (typeof data?.artifact_ref !== 'string' || typeof data?.sha256 !== 'string') {
        showNotice('error', 'The local export returned an unbalanced payload.');
        return;
      }
      setExportStatus({ artifact_ref: data.artifact_ref, sha256: data.sha256, size_bytes: data.size_bytes });
      showNotice('success', `Exported ${data.artifact_ref} (${data.size_bytes} bytes).`);
      return;
    }
    if (interpreted.kind === 'business_failure') {
      showNotice('error', EXPORT_REASON_MESSAGES[interpreted.reason_code] ?? EXPORT_REASON_MESSAGES.INTERNAL_FAILURE);
      return;
    }
    showNotice('error', interpreted.message ?? EXPORT_REASON_MESSAGES.INTERNAL_FAILURE);
  }, [nextOperationId, outputRef, showNotice, transport]);

  /* --------------------------------- close -------------------------------- */

  const closeDocument = useCallback(async () => {
    const current = sessionRef.current;
    const active = activeRef.current;
    if (current !== null && transport && active !== null) {
      const requestResult = buildRequest({
        operation_id: nextOperationId('op-close'),
        context_ref: active.context_ref,
        expected_scope_generation: active.expected_scope_generation,
        view_epoch: viewEpochRef.current,
        input: { editor_session_ref: current.editor_session_ref },
      });
      if (requestResult.ok === true) {
        await callEndpoint(transport, 'session.close', requestResult.request, undefined, active.expected_scope_generation);
      }
    }
    stopPolling();
    viewEpochRef.current += 1;
    sessionRef.current = null;
    modelRef.current = null;
    setSession(null);
    setModel(null);
    setSelection(null);
    setConflict(null);
    setOperationView(null);
    setPreview(null);
    setSaveStatus('clean');
    showNotice('info', 'Editor session closed.');
  }, [nextOperationId, showNotice, stopPolling, transport]);

  /* ------------------------------- selection ------------------------------ */

  const onSelectChange = useCallback((event) => {
    const value = String(event?.target?.value ?? '');
    setSelection(value === '' ? null : value);
    setAnnotationLabel('');
    const current = modelRef.current;
    if (current !== null && value !== '') setNoteText(noteForTarget(current, value)?.text ?? '');
  }, []);

  const saveNote = useCallback(() => {
    if (selection === null) return;
    const current = modelRef.current;
    if (current === null) return;
    const existing = noteForTarget(current, selection);
    commandSeqRef.current += 1;
    const position = nodePosition(current, selection, sessionRef.current?.base_spec) ?? { x: 0, y: 0, width: 160, height: 64 };
    applyEdit('set_note', notePayload({
      annotation_id: existing?.id ?? makeAnnotationId('note', commandSeqRef.current),
      target_ref: selection,
      text: noteText,
      position: { x: position.x, y: position.y + position.height + 8, width: 200, height: 72 },
    }));
  }, [applyEdit, noteText, selection]);

  const addAnnotationNode = useCallback(() => {
    if (addLabel.trim() === '') {
      showNotice('error', 'Enter a label for the new annotation node.');
      return;
    }
    commandSeqRef.current += 1;
    const id = makeAnnotationId('node', commandSeqRef.current);
    const offset = (commandSeqRef.current % 6) * 24;
    const applied = applyEdit('add_annotation_node', annotationNodePayload({
      id,
      label: addLabel,
      description: null,
      position: { x: offset, y: offset, width: 160, height: 64 },
    }));
    setAddLabel('');
    if (applied.ok === true) setSelection(id);
  }, [addLabel, applyEdit, showNotice]);

  const startConnect = useCallback(() => {
    if (selection === null) return;
    setConnectFrom(selection);
    showNotice('info', 'Now click the target node to create one annotation edge.');
  }, [selection, showNotice]);

  const removeSelected = useCallback(() => {
    if (selection === null) return;
    const current = modelRef.current;
    if (current === null) return;
    const item = current.overlay.items.find((entry) => entry.id === selection);
    if (item === undefined) {
      const baseNodes = sessionRef.current?.base_spec?.nodes ?? [];
      if (baseNodes.some((node) => node.id === selection)) {
        applyEdit('set_visibility', visibilityPayload({ target_ref: selection, hidden: true }));
      }
      return;
    }
    if (item.kind === 'annotation_node') {
      applyEdit('remove_annotation_node', removeAnnotationNodePayload({ node_id: selection }));
    } else if (item.kind === 'note' || item.kind === 'annotation_edge') {
      applyEdit('remove_annotation', removeAnnotationPayload({ id: selection }));
    }
    setSelection(null);
  }, [applyEdit, selection]);

  const toggleSelectedVisibility = useCallback(() => {
    if (selection === null) return;
    const current = modelRef.current;
    if (current === null || sessionRef.current === null) return;
    const hidden = current.overlay.items.some(
      (item) => item.kind === 'visibility' && item.target_ref === selection && item.hidden === true,
    );
    applyEdit('set_visibility', visibilityPayload({ target_ref: selection, hidden: !hidden }));
  }, [applyEdit, selection]);

  const applyCoordinateForm = useCallback(() => {
    if (selection === null) return;
    const result = coordinateMove({ node_id: selection, x: coordX, y: coordY });
    if (result.ok !== true) {
      showNotice('error', 'Coordinates must be integers between -100000 and 100000.');
      return;
    }
    applyEdit('move_node', result.payload);
  }, [applyEdit, coordX, coordY, selection, showNotice]);

  const renameAnnotationNode = useCallback(() => {
    if (selection === null || annotationLabel.trim() === '') return;
    applyEdit('set_annotation_node', { id: selection, label: annotationLabel, description: null });
    setAnnotationLabel('');
  }, [annotationLabel, applyEdit, selection]);

  /* --------------------------------- render ------------------------------- */

  const selectedBaseSpec = session?.base_spec ?? null;
  const selectionOptions = view?.nodes?.map((node) => node.id) ?? [];

  function renderOpenForm() {
    return h('div', { style: styles.card }, [
      h('div', { key: 'heading', style: styles.row }, [
        h('strong', { key: 'a' }, 'Open a registered document'),
        h('span', { key: 'b', style: styles.muted }, 'Only registry references are accepted; the Host validates every open.'),
      ]),
      h('div', { key: 'form', style: styles.row }, [
        h('label', { key: 'c' }, [
          'context ref ',
          h('input', { style: styles.input, value: contextRef, onChange: (event) => setContextRef(String(event.target.value)), placeholder: 'ctx-demo' }),
        ]),
        h('label', { key: 'd' }, [
          'document ref ',
          h('input', { style: styles.input, value: documentRef, onChange: (event) => setDocumentRef(String(event.target.value)), placeholder: 'doc-demo' }),
        ]),
        h('label', { key: 'e' }, [
          'scope generation ',
          h('input', { style: styles.input, value: scopeGeneration, onChange: (event) => setScopeGeneration(String(event.target.value)), size: 4 }),
        ]),
        button({ key: 'f', label: busy ? 'Opening...' : 'Open', onClick: openFromForm, disabled: busy, primary: true }),
      ]),
      recent.length > 0
        ? h('div', { key: 'recent' }, [
            h('div', { key: 'h', style: styles.muted }, 'Recent (Host-validated) references'),
            h('ul', { key: 'list', style: styles.list }, recent.map((entry) => h(
              'li',
              { key: `${entry.context_ref}/${entry.document_ref}` },
              h('button', {
                type: 'button',
                style: { background: 'none', border: 'none', color: '#0969da', cursor: 'pointer', padding: 0 },
                onClick: () => openEntry(entry),
              }, `${entry.document_ref} | ${entry.context_ref}`),
            ))),
          ])
        : null,
    ]);
  }

  function renderWarnings() {
    const warnings = view?.warnings;
    if (warnings === undefined) return null;
    const lines = [];
    if (warnings.unresolved_count > 0) lines.push(`unresolved relations: ${warnings.unresolved_count}`);
    if (warnings.truncated === true) {
      lines.push(`truncated: omitted ${warnings.omitted_nodes} node(s) / ${warnings.omitted_edges} edge(s)`);
    }
    if (warnings.hidden_nodes > 0 || warnings.hidden_edges > 0) {
      lines.push(`hidden evidence: ${warnings.hidden_nodes} node(s) / ${warnings.hidden_edges} edge(s) hidden in this view; still counted in coverage`);
    }
    if (warnings.orphaned_annotations > 0) lines.push(`orphaned annotations preserved: ${warnings.orphaned_annotations}`);
    for (const storeWarning of warnings.store_warnings) lines.push(`store warning: ${storeWarning}`);
    if (lines.length === 0) return null;
    return h('div', { key: 'warnings', style: { ...styles.card, ...styles.row } }, lines.map((line, index) => h('span', { key: index }, line)));
  }

  function renderConflict() {
    return h('div', { key: 'conflict', style: { ...styles.card, borderColor: '#bf8700' } }, [
      h('div', { key: 'h' }, h('strong', {}, conflict.title)),
      h('div', { key: 'm', style: styles.muted }, conflict.message),
      h('div', { key: 'g', style: styles.muted }, `current Host revision: g${conflict.current_generation ?? '?'}`),
      conflict.draft_ref === null ? null : h('div', { key: 'd', style: styles.muted }, `Host draft ref: ${conflict.draft_ref}`),
      h('div', { key: 'row', style: styles.row }, CONFLICT_OPTIONS.map((option) => button({
        key: option.id,
        label: option.label,
        title: option.description,
        onClick: () => onConflictChoice(option.id),
        disabled: busy,
      }))),
    ]);
  }

  function renderEditor() {
    return h('div', { style: styles.columns }, [
      h('div', { key: 'main', style: { flex: '1 1 520px', minWidth: '360px', display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h('div', { key: 'sourcebar', style: { ...styles.card, ...styles.row } }, [
          h('span', { key: 'title' }, `${view?.title ?? 'Diagram'} | ${session?.document_id ?? ''}`),
          h('span', { key: 'gen', style: styles.muted }, `g${session?.version?.generation ?? 0}`),
          h('span', { key: 'sha', style: styles.muted }, `sha256 ${(session?.version?.content_sha256 ?? '').slice(0, 12)}`),
          h('span', { key: 'source', style: styles.muted }, `source_state: ${view?.source_state ?? 'unknown'}`),
        ]),
        renderWarnings(),
        h(
          'div',
          {
            key: 'svgwrap',
            style: styles.svgWrap,
            tabIndex: 0,
            onKeyDown,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            title: 'Select a node, then drag. Arrow keys move 8 px (Shift 1 px).',
          },
          scene === null ? message('No scene.') : renderScene(scene),
        ),
        h('div', { key: 'text', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, `Text equivalent (${view?.text_equivalent?.length ?? 0} entries)`),
          h('ul', { key: 'list', style: styles.list }, (view?.text_equivalent ?? []).slice(0, 200).map((entry) => h('li', { key: entry.id }, entry.text))),
        ]),
      ]),
      h('div', { key: 'side', style: styles.sidebar }, [
        h('div', { key: 'legend', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Certainty legend'),
          h('ul', { key: 'list', style: styles.list }, (view?.legend ?? []).map((entry) => h('li', { key: entry.kind }, `${entry.label}: ${entry.count}`))),
          h('div', { key: 'hidden', style: styles.muted }, `hidden evidence: ${view?.warnings?.hidden_nodes ?? 0} nodes / ${view?.warnings?.hidden_edges ?? 0} edges`),
          (view?.warnings?.orphaned_annotations ?? 0) > 0
            ? h('div', { key: 'orphan', style: styles.error }, `${view.warnings.orphaned_annotations} orphaned annotation(s) preserved`)
            : null,
        ]),
        h('div', { key: 'select', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Selection'),
          h('select', { style: styles.input, value: selection ?? '', onChange: onSelectChange }, [
            h('option', { key: 'none', value: '' }, 'none'),
            ...selectionOptions.map((id) => h('option', { key: id, value: id }, id)),
          ]),
          h('div', { key: 'row', style: styles.row }, [
            button({ key: 'connect', label: 'Connect from selected', onClick: startConnect, disabled: selection === null || busy }),
            button({ key: 'hide', label: 'Hide/show base entity', onClick: toggleSelectedVisibility, disabled: selection === null || busy }),
            button({ key: 'remove', label: 'Remove annotation', onClick: removeSelected, disabled: selection === null || busy }),
          ]),
        ]),
        h('div', { key: 'coords', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Move selected node (form fallback)'),
          h('div', { key: 'row', style: styles.row }, [
            h('label', { key: 'x' }, ['x ', h('input', { style: styles.input, value: coordX, onChange: (event) => setCoordX(String(event.target.value)), size: 7 })]),
            h('label', { key: 'y' }, ['y ', h('input', { style: styles.input, value: coordY, onChange: (event) => setCoordY(String(event.target.value)), size: 7 })]),
            button({ key: 'apply', label: 'Apply coordinates', onClick: applyCoordinateForm, disabled: selection === null || busy }),
          ]),
        ]),
        h('div', { key: 'note', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Note for selected node'),
          h('textarea', {
            key: 'text',
            style: { ...styles.input, width: '100%', minHeight: '54px' },
            value: noteText,
            onChange: (event) => setNoteText(String(event.target.value)),
            maxLength: 4096,
          }),
          button({ key: 'save', label: 'Save note', onClick: saveNote, disabled: selection === null || busy }),
        ]),
        h('div', { key: 'annotation', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Annotation node (conceptual diagrams only)'),
          h('div', { key: 'row', style: styles.row }, [
            h('input', { key: 'label', style: styles.input, value: addLabel, onChange: (event) => setAddLabel(String(event.target.value)), placeholder: 'label', maxLength: 256 }),
            button({ key: 'add', label: 'Add annotation node', onClick: addAnnotationNode, disabled: busy || (selectedBaseSpec?.mode ?? 'conceptual') !== 'conceptual' }),
          ]),
          h('div', { key: 'rename', style: styles.row }, [
            h('input', { key: 'label', style: styles.input, value: annotationLabel, onChange: (event) => setAnnotationLabel(String(event.target.value)), placeholder: 'new label for selected annotation node', maxLength: 256 }),
            button({ key: 'set', label: 'Relabel', onClick: renameAnnotationNode, disabled: selection === null || busy }),
          ]),
        ]),
        h('div', { key: 'export', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Export (registered output ref; exclusive create)'),
          h('div', { key: 'row', style: styles.row }, [
            h('input', { key: 'out', style: styles.input, value: outputRef, onChange: (event) => setOutputRef(String(event.target.value)), placeholder: 'out-demo' }),
            button({ key: 'drawio', label: '.drawio', onClick: () => exportFormat('drawio'), disabled: busy }),
            button({ key: 'json', label: 'JSON', onClick: () => exportFormat('json'), disabled: busy }),
            button({ key: 'svg', label: 'SVG', onClick: () => exportFormat('svg'), disabled: busy }),
          ]),
          exportStatus === null
            ? null
            : h('div', { key: 'status', style: styles.ok }, `exported ${exportStatus.artifact_ref} | ${exportStatus.size_bytes} bytes | sha256 ${exportStatus.sha256.slice(0, 16)}`),
        ]),
        conflict === null ? null : renderConflict(),
        operationView === null ? null : h('div', { key: 'op', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, `Operation status: ${operationView.state}`),
          h('div', { key: 'm' }, operationView.message),
        ]),
      ]),
    ]);
  }

  function reopenFromActive() {
    const active = activeRef.current;
    if (active === null) return;
    openEntry({ ...active });
  }

  return h(
    'div',
    { style: styles.root, 'data-local-diagrams': 'panel' },
    h('div', { style: styles.bar }, [
      h('strong', { key: 'title' }, 'Local diagrams'),
      h('span', { key: 'mode', style: styles.muted }, session === null
        ? 'no document open'
        : `${view?.mode ?? 'diagram'} | ${view?.source_state ?? 'unknown'} | revision ${view?.generation ?? 0}`),
      ...(session === null
        ? []
        : [
            button({ key: 'save', label: 'Save', onClick: saveDocument, disabled: busy || saveStatus === 'saving', primary: true, title: 'Save with the exact expected version' }),
            button({ key: 'undo', label: 'Undo', onClick: () => applyEdit('undo', {}), disabled: busy }),
            button({ key: 'redo', label: 'Redo', onClick: () => applyEdit('redo', {}), disabled: busy }),
            button({ key: 'reload', label: 'Reopen', onClick: reopenFromActive, disabled: busy }),
            button({ key: 'close', label: 'Close', onClick: closeDocument, disabled: busy }),
          ]),
    ]),
    notice !== null ? message(notice.text, notice.kind === 'error') : null,
    session === null ? renderOpenForm() : renderEditor(),
  );
}

