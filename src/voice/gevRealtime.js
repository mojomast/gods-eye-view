import { createLiveViewer } from '../app/webglRecovery.js';
import { toFunctionOutput } from '../tools/functions.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
export * from './realtimeController.js';

const ACTION_NAMES = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));

/**
 * Run app actions through `runner` and every other tool the catalog has
 * through the catalog. `loadCatalog` resolves the catalog when first needed.
 */
export function withToolCatalog(runner, loadCatalog) {
  if (typeof loadCatalog !== 'function') return runner;
  const runGevTool = async function runGevTool(name, args, options = {}) {
    if (ACTION_NAMES.has(name)) return runner(name, args, options);
    const catalog = await loadCatalog();
    if (!catalog?.get(name)) return runner(name, args, options);
    const result = await catalog.call(name, args ?? {}, {
      signal: options.signal,
    });
    return toFunctionOutput(name, result);
  };
  runGevTool.resetConversation = (...args) =>
    runner.resetConversation?.(...args);
  runGevTool.dispose = (...args) => runner.dispose?.(...args);
  runGevTool.rebindViewer = (...args) => runner.rebindViewer?.(...args);
  return runGevTool;
}

/** Compose the standalone action runner with the voice controls. */
export function initGevVoiceCommands(options) {
  const live = createLiveViewer(options.viewer);
  const viewer = live.proxy;
  const bound = { ...options, viewer };
  const cameraKey = () => cameraPoseKey(viewer);
  // Point-and-ask: the tracker and referents are shared by the runner (which
  // resolves 'pointer' and referent:n) and the controls (which snapshot the
  // pointer at turn start and clear both when the session ends).
  const pointerFor = (target) => {
    const canvas = target?.scene?.canvas || null;
    return canvas
      ? createPointerTracker({
          element: canvas,
          cameraKey,
          pick: createPointerPicker({
            viewer,
            dataManager: options.dataManager,
          }),
        })
      : null;
  };
  let pointer = pointerFor(viewer);
  const referents = createReferentRegistry();
  // The controller exists only after the runner, so its hooks bind late.
  const deixis = { pointer, referents, cameraKey };
  let commands;
  const runner = withToolCatalog(
    createGevActionRunner({
      ...bound,
      deixis,
      readVoicePanelOperation: () => commands?.captureVoicePanelOperation?.(),
    }),
    options.toolCatalog,
  );
  commands = createVoiceCommands({
    ...bound,
    pointer,
    referents,
    runner,
  });
  commands.rebindViewer = (next) => {
    live.slot.current = next;
    const canvas = next?.scene?.canvas || null;
    if (pointer?.retarget && canvas) pointer.retarget(canvas);
    else {
      pointer?.destroy?.();
      pointer = pointerFor(next);
      deixis.pointer = pointer;
      commands.pointer = pointer;
    }
    runner.rebindViewer?.();
  };
  deixis.imageFrame = () => commands.retainedImageFrame?.() || null;
  deixis.onPointerUsed = () => commands.announcePointer?.();
  const lifetime = commands.signal ?? commands.session?.signal;
  lifetime?.addEventListener('abort', () => pointer?.destroy(), { once: true });
  if (lifetime?.aborted) pointer?.destroy();
  return commands;
}
