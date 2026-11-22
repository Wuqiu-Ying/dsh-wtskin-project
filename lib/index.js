/**
 * dsh-wtskin-project v2 — War Thunder user-skin studio.
 *
 * Tools:
 *   dsh_wtskin_project   create / read / update a project (schema v2)
 *   dsh_wtskin_layer     add / addMany / update / remove / move / list layers
 *   dsh_wtskin_export    composite, write PNG / DDS / preview / debug / normal / blk
 *   dsh_wtskin_picker    (re)generate the per-project quad picker page
 *   dsh_wtskin_presets   list built-in vehicle presets
 *
 * Command:
 *   /wtskinp [vehicle]   create a project + picker, then hand the workflow to
 *                        the model (browser capability is checked first)
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_PROJECT,
  SCHEMA_VERSION,
  describeLayers,
  isPolygon,
  isQuad,
  migrate,
  newProject,
  normaliseLayer,
  readProject,
  validateProject,
  writeProject,
} from './project.js';
import { ensureProjectDir } from './projects.js';
import { writePicker } from './picker.js';

/**
 * `@deepseek-ai/dsh-tools` is supplied by the host when the plugin is loaded by
 * the Harness. This profile has no resolvable copy, so the fallback must build
 * the model-facing JSON Schema itself — handing the parameter DSL through
 * unchanged made the provider reject the tool ("schema must be type object").
 */
function parametersToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const property = {};
    if (spec?.type && spec.type !== 'json') property.type = spec.type;
    if (spec?.description) property.description = spec.description;
    if (Array.isArray(spec?.enum)) property.enum = spec.enum;
    properties[key] = Object.keys(property).length ? property : {};
    if (spec?.required) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  defineTool = (definition) => ({
    ...definition,
    parameters: parametersToJsonSchema(definition.parameters),
  });
}

export const name = 'dsh-wtskin-project';
export const inject = ['tools', 'systemPrompt'];

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const DEFAULT_ENGINE = path.join(packageRoot, 'python', 'wt_skin.py');
const PRESETS_FILE = path.join(packageRoot, 'presets', 'vehicles.json');

const SETTINGS = {
  pythonPath: '',
  projectsDir: '',
  timeoutMs: 300_000,
};

const PRESET_ID = 'wtskin';

/**
 * Preset rows are either a real file inside this package (the mode prompt) or
 * the host's own copy of a shipped @deepseek-ai tool, found inside app.asar at
 * runtime. The plugin declares no host package versions: it must keep loading
 * when DSH upgrades, and a missing host module falls back instead of breaking
 * the boot.
 */
function presetPlugins() {
  const resources = process.resourcesPath || (process.execPath ? path.join(path.dirname(process.execPath), 'resources') : '');
  const shipped = (packageName) => {
    if (!resources) return `@deepseek-ai/${packageName}`;
    const file = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', packageName, 'lib', 'index.js');
    try {
      return existsSync(file) ? pathToFileURL(file).href : `@deepseek-ai/${packageName}`;
    } catch {
      return `@deepseek-ai/${packageName}`;
    }
  };
  return {
    root: resources,
    plugins: [
      { id: 'mode', name: pathToFileURL(path.join(packageRoot, 'preset', 'wtskin-mode.js')).href },
      { id: 'time-context', name: shipped('dsh-time-context') },
      { id: 'tool-fs', name: shipped('dsh-tool-fs') },
      { id: 'tool-ask-user', name: shipped('dsh-tool-ask-user') },
      { id: 'tool-todo', name: shipped('dsh-tool-todo'), config: { allowParallelInProgress: true } },
      { id: 'tool-web', name: shipped('dsh-tool-web'), config: { fetch: true, searchTimeoutMs: 60000 } },
    ],
  };
}

/** Ask the picker panel to come forward without stealing it at startup. */
async function markOpenRequest(cwd) {
  try {
    const root = path.join(cwd, 'WTSP');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.open'), String(Date.now()), 'utf8');
  } catch (error) {
    void error;
  }
}

/** Debug channel: the preset roster is Host-only, so leave the outcome on disk. */
async function writePresetStatus(value) {
  try {
    await fs.writeFile(
      path.join(packageRoot, '.preset-status.json'),
      JSON.stringify({ ...value, at: value.at ?? new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (error) {
    void error;
  }
}

/**
 * The session's own working directory. `defaultDirectory` is the process
 * default (the profile directory under `dsh web`), which is NOT the workspace a
 * Session runs in — using it dropped WTSP into the profile.
 */
async function sessionCwd(ctx, agent, signal) {
  try {
    const wd = ctx.get?.('workingDirectory');
    if (wd?.ensure && agent) return await wd.ensure(agent, signal);
    return wd?.defaultDirectory ?? process.cwd();
  } catch {
    return ctx.get?.('workingDirectory')?.defaultDirectory ?? process.cwd();
  }
}

function settings(config = {}) {
  return {
    pythonPath: config.pythonPath ?? SETTINGS.pythonPath,
    projectsDir: config.projectsDir ?? SETTINGS.projectsDir,
    timeoutMs: Number(config.timeoutMs ?? SETTINGS.timeoutMs) || SETTINGS.timeoutMs,
  };
}

function resolvePython(config, override) {
  const candidates = [override, config.pythonPath, process.env.DSH_PYTHON].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] || 'python';
}

/**
 * The engine writes its result to a file and the child gets `stdio: 'ignore'`:
 * piped stdout is refused in some confined runtimes and would break export.
 */
function runEngineArgs(python, engine, args, timeoutMs) {
  const outFile = path.join(os.tmpdir(), `wtskin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(python, [engine, ...args, '--out', outFile], {
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
    });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      fs.rm(outFile, { force: true }).catch(() => {});
      reject(new Error(`skin engine timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const settle = (code, spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.readFile(outFile, 'utf8').then((text) => {
        let payload = null;
        try { payload = JSON.parse(text); } catch { payload = null; }
        fs.rm(outFile, { force: true }).catch(() => {});
        if (spawnError) {
          reject(new Error(`cannot start python (${python}): ${spawnError.message}`));
          return;
        }
        if (code !== 0) {
          const detail = payload?.problems?.length ? payload.problems.join('; ') : payload?.error ?? `exit ${code}`;
          reject(new Error(`skin engine failed: ${detail}`));
          return;
        }
        if (!payload) {
          reject(new Error('skin engine produced no result'));
          return;
        }
        resolve(payload);
      }).catch((error) => reject(new Error(`cannot read engine result: ${error.message}`)));
    };

    child.on('error', (error) => settle(1, error));
    child.on('exit', (code) => settle(code ?? 1));
  });
}

function runEngine(python, engine, projectFile, timeoutMs) {
  return runEngineArgs(python, engine, ['export', projectFile], timeoutMs);
}

async function loadPresets() {
  try {
    return JSON.parse(await fs.readFile(PRESETS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function slug(value, fallback) {
  const text = String(value || '').trim().toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return text || fallback;
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function assertNoProblems(project) {
  const problems = validateProject(project);
  if (problems.length) {
    throw new Error(`project is not exportable:\n- ${problems.join('\n- ')}`);
  }
}

async function saveAndRefresh(dir, project, { refreshPicker = true } = {}) {
  assertNoProblems(project);
  const file = await writeProject(dir, project);
  let picker = null;
  if (refreshPicker) {
    try {
      picker = await writePicker(dir, project);
    } catch (error) {
      picker = null;
      void error;
    }
  }
  return { file, picker };
}

export function apply(ctx, config = {}) {
  const cfg = settings(config);
  const cwd = () => ctx.get?.("workingDirectory")?.defaultDirectory ?? process.cwd();

  // The YAML row for an agent preset is accepted by the loader here but never
  // reaches the Web roster; registering through the service is the path other
  // profile bundles use. ctx.get is empty at activation, so the registration
  // waits for the service with ctx.inject. The outcome lands in the package
  // directory so a silent failure can be read back instead of guessed at.
  const registerPreset = (presets, effect, logger) => {
    const { root, plugins } = presetPlugins();
    const dumpRoster = async () => {
      const readBroken = (value) => {
        if (value === undefined) return undefined;
        if (typeof value === 'string') return value;
        if (value && typeof value.message === 'string') return value.message;
        try { return JSON.stringify(value); } catch { return String(value); }
      };
      try {
        const list = await presets.list();
        return (list ?? []).map((entry) => ({
          id: entry.id,
          name: entry.name,
          order: entry.order,
          keys: Object.keys(entry),
          broken: readBroken(entry.broken),
        }));
      } catch (error) {
        return { rosterError: String((error && (error.message || error)) || error) };
      }
    };
    effect(() => {
      let dispose = null;
      let disposed = false;
      Promise.resolve(presets.register({
        id: PRESET_ID,
        name: '战雷画涂装模式',
        description: '与 AI 一起做战争雷霆载具涂装：查资料、量 UV、放立绘、导出 DDS + blk。',
        order: 10,
        plugins,
      }))
        .then(async (fn) => {
          if (disposed) Promise.resolve(fn && fn()).catch(() => {});
          else dispose = fn;
          void writePresetStatus({
            ok: true,
            id: PRESET_ID,
            plugins: plugins.length,
            root,
            entry: plugins[0].name,
            roster: await dumpRoster(),
          });
        })
        .catch((error) => {
          const message = String((error && error.message) || error);
          logger?.warn?.(`dsh-wtskin-project: preset registration failed: ${message}`);
          void writePresetStatus({ ok: false, id: PRESET_ID, error: message, root, entry: plugins[0].name });
        });
      return () => {
        disposed = true;
        if (typeof dispose === 'function') Promise.resolve(dispose()).catch(() => {});
      };
    });
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], (inner) => {
      registerPreset(inner.agentPresets, inner.effect.bind(inner), ctx.logger);
    });
    void writePresetStatus({ ok: null, waiting: 'agentPresets', at: new Date().toISOString() });
  } else {
    void writePresetStatus({ ok: false, error: 'ctx.inject is not available' });
  }

  ctx.systemPrompt?.section?.({
    name: 'tool:wt-skin',
    order: 160,
    text: [
      'War Thunder skin studio (dsh_wtskin_*): build a user skin as a declarative project inside <cwd>/WTSP/<vehicle>_<name>.',
      'This mode has a floating picker panel ("涂装取点") opened by /wtspwds or dsh_wtskin_picker. The user measures panels there; each save writes the quad straight into project.json (layers start with an empty image).',
      'Every quad is in FINAL texture pixels — never scale it again; the panel already multiplies the preview coordinates once.',
      'A quad is one panel: points 1-2 are one edge, 3-4 the opposite edge, the chord runs between their midpoints. The panel draws that chord, so the user sees what the engine will use.',
      'After the user attaches art, update the layer with image=<path>; then dsh_wtskin_export and call read_image on out/preview.png and out/_preview_quads.png to check the result yourself.',
      'Export writes a per-layer report (chord, covered pixels, overlap, warnings) — use it instead of guessing.',
      'Vehicles differ in blk entries and texture names — seed a project with dsh_wtskin_project preset=<id> or read the vehicle blk from UserSkins.',
      'Before the user creates a template in-game, tell them to DISABLE the vehicle\'s custom skin first: with a custom skin enabled, War Thunder writes a flat grey albedo and a green normal map, which cannot be used for measuring or colouring.',
    ].join(' '),
  });

  const register = (definition) => {
    try {
      ctx.tools.register(definition);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wtskin-project: cannot register ${definition.name}: ${String(error)}`);
    }
  };

  register(defineTool({
    name: 'dsh_wtskin_project',
    description: 'Create, read or update a War Thunder skin project (project.json, schema v2): canvas, vehicle preset, base livery, output settings. Creating also writes the picker page.',
    parameters: {
      dir: { type: 'string', description: 'Project directory. create: omit to derive <cwd>/WTSP/<vehicle>_<name>. read/update: required.' },
      action: { type: 'string', required: true, description: 'create | read | update' },
      data: { type: 'json', description: 'Object merged into the project (width, height, base, output, vehicle, name, notes).' },
      preset: { type: 'string', description: 'create: seed from a built-in vehicle preset id (see dsh_wtskin_presets).' },
      vehicle: { type: 'string', description: 'create: vehicle name used for the WTSP subdirectory.' },
      name: { type: 'string', description: 'create: skin name used for the WTSP subdirectory (the model asks the user for it).' },
      force: { type: 'boolean', description: 'create: overwrite an existing project.json.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: cfg.timeoutMs,
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec?.agent, exec?.signal);
      const data = args.data ?? {};
      let dir = args.dir ? path.resolve(args.dir) : '';
      const markActive = async (target) => {
        try {
          const active = path.relative(cwd, target).split(path.sep).join('/');
          if (active.startsWith('WTSP/')) {
            await fs.mkdir(path.join(cwd, 'WTSP'), { recursive: true });
            await fs.writeFile(path.join(cwd, 'WTSP', '.active'), active, 'utf8');
          }
        } catch { /* best effort */ }
      };
      if (args.action === 'read') {
        if (!dir) throw new Error('dir is required for read');
        const { project, notes } = await readProject(dir);
        return JSON.stringify({ ...project, _migration: notes, _problems: validateProject(project) }, null, 2);
      }

      if (args.action === 'create') {
        let preset = null;
        if (args.preset) {
          const presets = await loadPresets();
          preset = presets.find((p) => p.id === args.preset);
          if (!preset) {
            throw new Error(`unknown preset "${args.preset}" (available: ${presets.map((p) => p.id).join(', ')})`);
          }
        }
        if (!dir) {
          const allocated = await ensureProjectDir(cwd, {
            vehicle: args.vehicle ?? data.vehicle ?? preset?.id ?? '',
            name: args.name ?? data.name ?? '',
          });
          dir = allocated.dir;
        }
        const file = path.join(dir, 'project.json');
        if (!args.force && existsSync(file)) {
          throw new Error(`project already exists: ${file} (pass force:true to overwrite)`);
        }
        let project = newProject(dir);
        const vehicleName = args.vehicle ?? data.vehicle;
        if (vehicleName) project.vehicle = String(vehicleName).trim();
        let presetNote = '';
        if (preset) {
          project.vehicle = preset.id;
          project.output = {
            ...project.output,
            textureName: preset.textureName || project.output.textureName,
            blkName: preset.blkName || project.output.blkName,
            blkEntries: preset.blkEntries ?? [],
          };
          presetNote = `\npreset: ${preset.id} (${preset.name}) → ${project.output.textureName}, blk ${project.output.blkName}`;
        }
        for (const [key, value] of Object.entries(data)) {
          if (key === 'base' || key === 'output') project[key] = { ...project[key], ...value };
          else project[key] = value;
        }
        project.version = SCHEMA_VERSION;
        const { file: saved, picker } = await saveAndRefresh(dir, project);
        await markActive(dir);
        return [
          `created ${saved}${presetNote}`,
          picker ? `picker: ${picker}` : '',
          `canvas ${project.width}×${project.height}, layers ${project.layers?.length ?? 0}`,
          `panel: 右侧栏「涂装取点」已经可以保存这个工程的四边形`,
        ].filter(Boolean).join('\n');
      }

      if (args.action === 'update') {
        const { project, notes } = await readProject(dir);
        for (const [key, value] of Object.entries(args.data ?? {})) {
          if (key === 'base' || key === 'output') project[key] = { ...project[key], ...value };
          else project[key] = value;
        }
        if (notes.length) project.notes = [...(project.notes ?? []), ...notes];
        const { file } = await saveAndRefresh(dir, project);
        await markActive(dir);
        return `updated ${file}`;
      }

      throw new Error(`unknown action ${args.action}`);
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_layer',
    description: 'Manage layers of a skin project. A layer is an image anchored to a 4-point quad in final texture pixels, with optional flip, 180° rotation, offset, size mode and clip line. action=addMany takes the block the picker prints.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory.' },
      action: { type: 'string', required: true, description: 'add | addMany | update | remove | move | list' },
      id: { type: 'string', description: 'Layer id (update/remove/move).' },
      layer: { type: 'json', description: 'Layer object: {id, image, quad, size, factor, offset, rotate180, flip, clipLine, expand, opacity, height, aspect}.' },
      layers: { type: 'json', description: 'addMany: array of layer objects (each needs id, image, quad).' },
      index: { type: 'number', description: 'move: target position, 0 = bottom-most. Omit to move one step up (positive) or down (negative) via "by".' },
      by: { type: 'number', description: 'move: relative steps, e.g. 1 paints it above the current next layer.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: cfg.timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const { project } = await readProject(dir);
      project.layers = project.layers ?? [];

      if (args.action === 'list') {
        return JSON.stringify(describeLayers(project), null, 2);
      }

      if (args.action === 'add' || args.action === 'addMany') {
        const incoming = args.action === 'addMany' ? (args.layers ?? []) : [args.layer];
        if (!Array.isArray(incoming) || !incoming.length) throw new Error('nothing to add');
        const ids = new Set(project.layers.map((l) => l.id));
        const added = [];
        for (const raw of incoming) {
          const id = raw?.id || (args.action === 'add' ? args.id : undefined) || `L${project.layers.length + added.length + 1}`;
          if (ids.has(id)) throw new Error(`layer id already exists: ${id}`);
          project.layers.push(normaliseLayer(raw, id));
          ids.add(id);
          added.push(id);
        }
        const { picker } = await saveAndRefresh(dir, project);
        return `added ${added.join(', ')} (total ${project.layers.length})${picker ? `\npicker refreshed: ${picker}` : ''}`;
      }

      if (args.action === 'update') {
        if (!args.id) throw new Error('id is required for update');
        const index = project.layers.findIndex((l) => l.id === args.id);
        if (index < 0) throw new Error(`no layer ${args.id}`);
        project.layers[index] = normaliseLayer({ ...project.layers[index], ...(args.layer ?? {}) }, args.id);
        await saveAndRefresh(dir, project);
        return `updated layer ${args.id}`;
      }

      if (args.action === 'remove') {
        if (!args.id) throw new Error('id is required for remove');
        const before = project.layers.length;
        project.layers = project.layers.filter((l) => l.id !== args.id);
        if (project.layers.length === before) throw new Error(`no layer ${args.id}`);
        await saveAndRefresh(dir, project);
        return `removed layer ${args.id} (remaining ${project.layers.length})`;
      }

      if (args.action === 'move') {
        if (!args.id) throw new Error('id is required for move');
        const from = project.layers.findIndex((l) => l.id === args.id);
        if (from < 0) throw new Error(`no layer ${args.id}`);
        const to = args.index !== undefined
          ? Math.max(0, Math.min(project.layers.length - 1, Number(args.index)))
          : Math.max(0, Math.min(project.layers.length - 1, from + Number(args.by ?? 1)));
        const [moved] = project.layers.splice(from, 1);
        project.layers.splice(to, 0, moved);
        await saveAndRefresh(dir, project);
        return `moved ${args.id} to index ${to} (order: ${project.layers.map((l) => l.id).join(' < ')})`;
      }

      throw new Error(`unknown action ${args.action}`);
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_export',
    description: 'Composite base livery + layers and write PNG, uncompressed DDS, 1600 preview, quad debug overlay, optional normal map and .blk. Returns paths and a per-layer report. Open the previews with read_image to self-check.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory.' },
      pythonPath: { type: 'string', description: 'Override the Python interpreter (needs Pillow + numpy).' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: cfg.timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const { project } = await readProject(dir);
      assertNoProblems(project);
      const engine = config.enginePath || DEFAULT_ENGINE;
      if (!existsSync(engine)) throw new Error(`engine not found: ${engine}`);
      const python = resolvePython(config, args.pythonPath);
      const result = await runEngine(python, engine, path.join(dir, 'project.json'), cfg.timeoutMs);
      const report = result.report ?? {};
      const warnings = (report.layers ?? []).flatMap((l) => (l.warnings ?? []).map((w) => `${l.id}: ${w}`));
      return [
        `texture: ${result.png ?? '?'}`,
        `dds: ${result.dds ?? '(disabled)'}`,
        `preview: ${result.preview ?? '(disabled)'}`,
        `debug overlay: ${result.debugPreview ?? '(disabled)'}`,
        `normal: ${result.normalDds ?? result.normalPng ?? '(disabled)'}`,
        `blk: ${result.blk ?? '(disabled)'}`,
        `layers: ${result.layers ?? 0}`,
        warnings.length ? `warnings:\n- ${warnings.join('\n- ')}` : 'warnings: none',
        `report: ${JSON.stringify(report)}`,
        'next: read_image the preview and the debug overlay to verify placement.',
      ].join('\n');
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_picker',
    description: 'Open the measuring panel for a project: refreshes picker.html and raises the floating 涂装取点 window for the user (this is the model-side trigger). Call it when the user should measure panels.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: cfg.timeoutMs,
    async execute(args, exec) {
      const dir = path.resolve(args.dir);
      const { project } = await readProject(dir);
      const file = await writePicker(dir, project);
      const cwd = await sessionCwd(ctx, exec?.agent, exec?.signal);
      await markOpenRequest(cwd);
      // Tell the panel which project this session is working on; without it the
      // picker defaults to the most recently modified project, which can be a
      // stale one from an earlier experiment.
      try {
        const active = path.relative(cwd, dir).split(path.sep).join('/');
        await fs.writeFile(path.join(cwd, 'WTSP', '.active'), active, 'utf8');
      } catch { /* best effort */ }
      return [
        `picker: ${file}`,
        `canvas: ${project.width}×${project.height}`,
        `known faces: ${(project.layers ?? []).map((l) => l.id).join(', ') || '(none)'}`,
        'Open picker.html from the right-hand file preview, switch 四点框选, click 4 corners per panel in the order 前缘1, 前缘2, 后缘1, 后缘2, then 添加面 and finally 复制全部.',
      ].join('\n');
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_presets',
    description: 'List built-in vehicle presets (texture names and .blk entries) that can seed a skin project.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: cfg.timeoutMs,
    async execute() {
      const presets = await loadPresets();
      return JSON.stringify(presets, null, 2);
    },
  }));

  // ------------------------------------------------- commands

  const hasBrowserControl = () => {
    try {
      if (ctx.get?.('browserUse')) return true;
      for (const name of ['dsh_browser_open', 'browser_open', 'dsh_browser_navigate']) {
        if (ctx.tools?.get?.(name)) return true;
      }
      const schemas = ctx.tools?.schemas?.() ?? [];
      return schemas.some((schema) => String(schema?.name ?? '').startsWith('dsh_browser_'));
    } catch {
      return false;
    }
  };

  const wakeAgent = (agentRef, text) => {
    try {
      const agent = ctx.get?.("agents")?.get?.(agentRef.id);
      if (!agent) return false;
      // followup takes an identified UserMessage (id + role + content + source).
      // A partial {content, source} object is spliced into the inbox verbatim,
      // committed as a user/message without an id or role, which the provider
      // rejects (422 missing field `role`) and the log then fails to restore.
      if (typeof agent.followup === 'function') {
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        });
        return true;
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wtskin-project: cannot wake the agent: ${String(error)}`);
    }
    return false;
  };

  const commands = ctx.get?.('commands');
  if (commands?.register) {
    ctx.effect(() => commands.register({
      name: 'wtskinp',
      description: '开始一份战争雷霆载具涂装：先问载具与命名，再建档并进入取点流程',
      input: { hint: '[载具] [涂装名]（可留空，留空时会先问你）' },
      async handler(invocation) {
        if (!hasBrowserControl()) {
          return {
            kind: 'error',
            text: [
              '需要先安装能让 DeepSeek 控制浏览器的插件：要用它搜索载具资料。',
              '装好并启用后重启 DSH，再输入 /wtskinp。',
              '也可以跳过资料搜索，直接让模型用 dsh_wtskin_project 建档。',
            ].join('\n'),
          };
        }

        const raw = String(invocation.rawInput ?? '').trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        const vehicle = parts[0] ?? '';
        const skinName = parts.slice(1).join(' ');
        const cwd = await sessionCwd(ctx, invocation.agent, invocation.signal);

        let dir = '';
        let createdNote = '';
        if (vehicle && skinName) {
          try {
            const allocated = await ensureProjectDir(cwd, { vehicle, name: skinName });
            dir = allocated.dir;
            const project = newProject(dir);
            project.vehicle = vehicle;
            project.notes = [`started by /wtskinp at ${new Date().toISOString()}`];
            await writeProject(dir, project);
            createdNote = `工程已创建：${dir}`;
          } catch (error) {
            return { kind: 'error', text: `建档失败：${String((error && error.message) || error)}` };
          }
        }

        const prompt = dir
          ? [
            '【WTSkin 工程已就绪】',
            createdNote,
            '1. 用 web_search / web_fetch 查这个载具的公开资料（国别、定位、常见配色风格、游戏内贴图名），写进 project.json 的 notes；',
            '2. 告诉用户用 /wtspwds 打开「涂装取点」浮窗量面；',
            '3. 用户量完面后按面名用 dsh_wtskin_layer action=update 补 image；',
            '4. dsh_wtskin_export 后用 read_image 看 out/preview.png 与 out/_preview_quads.png 自检。',
          ].join('\n')
          : [
            '【WTSkin 开始】',
            '首轮先用 ask_user_question 一次问清两件事：',
            '1) 要做哪个载具（给 3-4 个常见机型选项，也允许自定义）；',
            '2) 这个涂装叫什么名字（用户没说就让他给一个主题词）。',
            '拿到后调用 dsh_wtskin_project action=create vehicle=<载具> name=<名字>，目录会自动落在 WTSP/<载具>_<名字>。',
            '然后查资料、请用户用 /wtspwds 打开浮窗量面，再导出并用 read_image 自检。',
          ].join('\n');

        const woke = wakeAgent(invocation.agent, prompt);
        return {
          kind: 'success',
          text: [
            createdNote || '已进入涂装流程，先把载具与涂装名问清楚。',
            woke ? '已把后续步骤交给模型。' : '请直接告诉我载具和涂装名。',
          ].filter(Boolean).join('\n'),
        };
      },
    }));

    // Opening the picker is deliberate: this command and dsh_wtskin_picker are
    // the only two triggers. Both write WTSP/.open and the panel polls it.
    ctx.effect(() => commands.register({
      name: 'wtspwds',
      description: '打开涂装取点面板',
      handler: async (invocation) => {
        try {
          const cwd = await sessionCwd(ctx, invocation.agent, invocation.signal);
          await markOpenRequest(cwd);
          return { kind: 'success', text: '涂装取点面板已打开' };
        } catch (error) {
          return { kind: 'error', text: String((error && error.message) || error) };
        }
      },
    }));

    // Panel bridge. The client half has no file-write Remote, so saving goes
    // through this host command; it is listed in the / menu by design.
    ctx.effect(() => commands.register({
      name: 'wtskin-save',
      description: '（内部）涂装取点面板保存 / 删除面，请勿手动调用',
      handler: async (invocation) => {
        try {
          const raw = String(invocation.rawInput ?? '').trim();
          if (!raw) throw new Error('empty payload');
          const payload = JSON.parse(raw);
          if (!payload?.dir) throw new Error('dir is required');
          const base = await sessionCwd(ctx, invocation.agent, invocation.signal);
          const requested = String(payload.dir);
          const dir = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested);
          const faces = Array.isArray(payload.faces) ? payload.faces : [];
          const remove = Array.isArray(payload.remove) ? payload.remove.map(String) : [];
          if (!faces.length && !remove.length && !payload.flush) throw new Error('no faces');

          const { project } = await readProject(dir);
          project.layers = project.layers ?? [];
          project.version = SCHEMA_VERSION;
          const saved = [];
          for (const face of faces) {
            const quad = face?.quad;
            if (!isPolygon(quad)) throw new Error(`face ${face?.id ?? '?'}: quad must be 3-64 [x,y] points`);
            const id = String(face.id || '').trim() || `face_${project.layers.length + 1}`;
            const clean = quad.map((p) => [Number(p[0]), Number(p[1])]);
            const index = project.layers.findIndex((layer) => layer.id === id);
            if (index >= 0) {
              project.layers[index] = {
                ...project.layers[index],
                quad: clean,
                ...(face.size ? { size: String(face.size) } : {}),
                ...(Array.isArray(face.edgeNames) ? { edgeNames: face.edgeNames.map(String) } : {}),
                ...(face.color ? { color: String(face.color) } : {}),
                ...(face.rotate180 !== undefined ? { rotate180: Boolean(face.rotate180) } : {}),
                ...(face.factor !== undefined ? { factor: Number(face.factor) || 1 } : {}),
              };
            } else {
              project.layers.push({
                id,
                image: '',
                quad: clean,
                size: clean.length === 4 ? 'chord' : 'quadHeight',
                factor: face.factor !== undefined ? (Number(face.factor) || 1) : 1,
                ...(face.rotate180 ? { rotate180: true } : {}),
                ...(Array.isArray(face.edgeNames) ? { edgeNames: face.edgeNames } : {}),
                ...(face.color ? { color: String(face.color) } : {}),
              });
            }
            saved.push(id);
          }
          const removed = [];
          for (const id of remove) {
            const before = project.layers.length;
            project.layers = project.layers.filter((layer) => layer.id !== id);
            if (project.layers.length !== before) removed.push(id);
          }
          await writeProject(dir, project);
          if (payload.state && typeof payload.state === 'object') {
            try {
              await fs.writeFile(
                path.join(dir, 'panel-state.json'),
                JSON.stringify({ ...payload.state, at: new Date().toISOString() }, null, 2),
                'utf8',
              );
            } catch { /* state is a convenience, never fatal */ }
          }
          // The faces file is the handoff: the user uploads it themselves, so a
          // save never wakes the model (each wake costs a full model turn).
          const facesPath = path.join(dir, 'faces.json');
          const facesDoc = {
            version: 1,
            dir,
            updatedAt: new Date().toISOString(),
            faces: project.layers.map((layer) => ({
              id: layer.id,
              points: layer.quad,
              size: layer.size,
              color: layer.color || null,
              edgeNames: layer.edgeNames || [],
              image: layer.image || '',
            })),
          };
          await fs.writeFile(facesPath, JSON.stringify(facesDoc, null, 2), 'utf8');
          return {
            kind: 'success',
            // The panel applies this object directly instead of re-reading the
            // file, so the face list refreshes immediately.
            text: JSON.stringify({
              ok: true, dir, saved, removed, layers: project.layers.length, facesPath, project,
            }),
          };
        } catch (error) {
          return { kind: 'error', text: String((error && error.message) || error) };
        }
      },
    }));

    // Theme recolour: the airframe itself must carry the theme, not only the art.
    ctx.effect(() => ctx.tools.register({
      name: 'dsh_wtskin_theme',
      description: 'Set the skin theme colours: the engine recolours the original texture through a gradient palette (base.source), so the whole airframe takes the theme instead of a few pasted images.',
      parameters: {
        dir: { type: 'string', required: true, description: 'Project directory.' },
        colors: { type: 'json', description: 'Ordered [[r,g,b],...] from shadow to highlight (2-6 stops, 0-255).', required: true },
        source: { type: 'string', description: 'Original texture path; defaults to base.source or base.image.' },
        contrast: { type: 'number', description: 'Detail contrast multiplier, default 1 (keep mode).' },
        detail: { type: 'string', description: 'keep = preserve rivets/panel lines (mechanical look, default); flat = smooth them away into flat colour bands (painterly look).' },
        mode: { type: 'string', description: 'gradient (default) maps luminance through the palette; tint multiplies the original colours by the theme colour so whites stay light and detail survives.' },
        levels: { type: 'json', description: 'Luminance normalisation percentiles, e.g. [0.01, 0.99] (default). Keeps a bright template from turning entirely into the light hue.' },
        edgeGlow: { type: 'number', description: 'Edge glow strength after the theme is applied; defaults to 0 (the texture already has detail).' },
        highlight: { type: 'boolean', description: 'Append a near-white palette stop when the palette has none (default true).' },
        dropBaseLayer: { type: 'boolean', description: 'Remove a full-canvas layer that would cover the recoloured base (default true).' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: cfg.timeoutMs,
      async execute(args) {
        const dir = path.resolve(args.dir);
        const { project } = await readProject(dir);
        const colors = Array.isArray(args.colors) ? args.colors : [];
        if (colors.length < 2 || colors.length > 6) throw new Error('colors needs 2-6 [r,g,b] stops');
        for (const color of colors) {
          if (!Array.isArray(color) || color.length !== 3 || color.some((v) => !Number.isFinite(Number(v)))) {
            throw new Error(`bad colour stop: ${JSON.stringify(color)}`);
          }
        }
        const source = String(args.source || project.base?.source || project.base?.image || '').trim();
        if (!source) throw new Error('no source texture: pass source (the game TGA) or set base.image first');
        const palette = colors.map((color, index) => [index / (colors.length - 1), color.map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))))]);
        if (args.highlight !== false) {
          const last = palette[palette.length - 1][1];
          if (Math.max(...last) < 235) palette.push([1, [244, 246, 250]]);
        }
        const mode = String(args.mode || project.base?.mode || 'gradient').toLowerCase();
        if (!['gradient', 'tint'].includes(mode)) throw new Error(`mode must be gradient or tint, got ${args.mode}`);
        let levels = Array.isArray(args.levels) ? args.levels.map(Number) : (project.base?.levels || [0.01, 0.99]);
        if (!Array.isArray(levels) || levels.length !== 2 || !(levels[0] >= 0 && levels[0] < levels[1] && levels[1] <= 1)) {
          levels = [0.01, 0.99];
        }
        const detail = String(args.detail || project.base?.detail || 'keep').toLowerCase();
        if (!['keep', 'flat'].includes(detail)) throw new Error(`detail must be keep or flat, got ${args.detail}`);
        project.base = {
          ...(project.base || {}),
          source,
          palette,
          detail,
          mode,
          levels,
          // Edge glow was added for procedural bases; on a real texture it only
          // washes the airframe in the accent colour.
          edgeGlow: Number.isFinite(Number(args.edgeGlow)) ? Number(args.edgeGlow) : 0,
        };
        if (Number.isFinite(Number(args.contrast))) project.base.contrast = Number(args.contrast);
        const dropped = [];
        if (args.dropBaseLayer !== false) {
          const w = Number(project.width) || 0;
          const h = Number(project.height) || 0;
          project.layers = (project.layers || []).filter((layer) => {
            const quad = layer.quad || [];
            if (quad.length < 4) return true;
            const xs = quad.map((p) => Number(p[0]));
            const ys = quad.map((p) => Number(p[1]));
            const covers = Math.min(...xs) <= 1 && Math.min(...ys) <= 1 && Math.max(...xs) >= w - 2 && Math.max(...ys) >= h - 2;
            if (covers) { dropped.push(layer.id); return false; }
            return true;
          });
        }
        await writeProject(dir, project);
        return JSON.stringify({ ok: true, source, palette, detail, mode, levels, dropped, layers: project.layers.length }, null, 2);
      },
    }));

    // Project finished: drop the throwaway reference skins.
    ctx.effect(() => ctx.tools.register({
      name: 'dsh_wtskin_finalize',
      description: 'Call when the user confirms the project is done: clears WTSP/temporary (downloaded reference skins) and reports what was removed.',
      parameters: {
        dir: { type: 'string', description: 'Workspace root holding WTSP/. Defaults to the session workspace.' },
        keep: { type: 'boolean', description: 'Keep temporary files (dry run) instead of deleting.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: cfg.timeoutMs,
      async execute(args, exec) {
        const cwd = args.dir ? path.resolve(args.dir) : await sessionCwd(ctx, exec?.agent, exec?.signal);
        const tmp = path.join(cwd, 'WTSP', 'temporary');
        let entries = [];
        try { entries = await fs.readdir(tmp); } catch { entries = []; }
        if (!args.keep) await fs.rm(tmp, { recursive: true, force: true });
        return JSON.stringify({ ok: true, temporary: tmp, removed: entries, kept: Boolean(args.keep) }, null, 2);
      },
    }));

    // Reference skins from WT Live: study material, never installed.
    const systemProxy = () => {
      const env = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (env) return env;
      try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true });
        const match = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (!match) return '';
        const raw = match[1].includes('=') ? (match[1].split(';').find(Boolean) || '').split('=').pop() : match[1];
        return raw ? (raw.startsWith('http') ? raw : `http://${raw}`) : '';
      } catch {
        return '';
      }
    };
    const extractZip = (zip, dest) => new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xf', zip, '-C', dest], { windowsHide: true, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
    const walkFiles = async (root) => {
      const out = [];
      const walk = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else out.push({ path: full, size: (await fs.stat(full)).size });
        }
      };
      await walk(root);
      return out;
    };

    ctx.effect(() => ctx.tools.register({
      name: 'dsh_wtskin_reference',
      description: 'Download a reference skin from WT Live into WTSP/temporary (or import a zip the user downloaded) and report its blk and textures so you can study composition, colours and panel layout. Never installs it into the game; dsh_wtskin_finalize clears it later.',
      parameters: {
        tags: { type: 'string', description: 'WT Live hashtag, e.g. "#q_5l", "#f-104g", "#anime".' },
        max: { type: 'number', description: 'How many posts to fetch (1-3, default 2).' },
        file: { type: 'string', description: 'Import an already-downloaded .zip instead of searching.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: cfg.timeoutMs,
      async execute(args, exec) {
        const cwd = await sessionCwd(ctx, exec?.agent, exec?.signal);
        const tempRoot = path.join(cwd, 'WTSP', 'temporary');
        await fs.mkdir(tempRoot, { recursive: true });
        let entries;
        if (args.file) {
          const file = path.isAbsolute(args.file) ? args.file : path.resolve(cwd, args.file);
          if (!existsSync(file)) throw new Error(`file not found: ${file}`);
          entries = [{ id: path.basename(file).replace(/\.[^.]+$/, ''), zip: file }];
        } else if (args.tags) {
          const script = path.join(packageRoot, 'tools', 'fetch_reference.mjs');
          if (!existsSync(script)) throw new Error('tools/fetch_reference.mjs is missing from the package');
          const proxy = systemProxy();
          const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
          if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; }
          const stdout = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [script, String(args.tags), String(args.max ?? 2), tempRoot], { windowsHide: true, env });
            let output = '';
            let errorText = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errorText += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => (code === 0
              ? resolve(output)
              : reject(new Error(`WT Live fetch failed (exit ${code}): ${errorText.slice(-500) || 'no output'}`))));
          });
          entries = JSON.parse(stdout.trim().split('\n').pop());
        } else {
          throw new Error('pass tags (WT Live hashtag) or file (zip path)');
        }
        const results = [];
        for (const entry of entries) {
          if (entry.error) { results.push(entry); continue; }
          const dest = path.join(tempRoot, String(entry.id));
          await fs.mkdir(dest, { recursive: true });
          try {
            await extractZip(entry.zip, dest);
          } catch (error) {
            results.push({ ...entry, error: `extract failed: ${error.message}` });
            continue;
          }
          const files = await walkFiles(dest);
          const blkFile = files.find((file) => file.path.toLowerCase().endsWith('.blk'));
          results.push({
            id: entry.id,
            author: entry.author ?? null,
            downloads: entry.downloads ?? null,
            description: entry.description ?? null,
            directory: dest,
            files: files.map((file) => path.relative(dest, file.path)).slice(0, 40),
            blk: blkFile ? (await fs.readFile(blkFile.path, 'utf8')).slice(0, 2000) : null,
            textures: files
              .filter((file) => /\.(dds|tga|png)$/i.test(file.path))
              .map((file) => ({ name: path.basename(file.path), size: file.size })),
          });
        }
        return JSON.stringify({ temporary: tempRoot, results }, null, 2);
      },
    }));

    // Quick format conversion: the game hands out TGA, editors prefer PNG.
    ctx.effect(() => ctx.tools.register({
      name: 'dsh_wtskin_convert',
      description: 'Convert a texture (TGA / DDS / PNG / JPG) to PNG. Use it when the user asks to turn a game TGA into an editable PNG.',
      parameters: {
        input: { type: 'string', required: true, description: 'Source image path; relative paths resolve against the session workspace.' },
        output: { type: 'string', description: 'PNG output path. Defaults to the source name with .png beside it.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: cfg.timeoutMs,
      async execute(args, exec) {
        const cwd = await sessionCwd(ctx, exec?.agent, exec?.signal);
        const input = path.isAbsolute(args.input) ? args.input : path.resolve(cwd, args.input);
        if (!existsSync(input)) throw new Error(`input not found: ${input}`);
        const output = args.output
          ? (path.isAbsolute(args.output) ? args.output : path.resolve(cwd, args.output))
          : input.replace(/\.[^./\\]+$/, '') + '.png';
        const engine = config.enginePath || DEFAULT_ENGINE;
        if (!existsSync(engine)) throw new Error(`engine not found: ${engine}`);
        const python = resolvePython(config);
        const result = await runEngineArgs(python, engine, ['convert', input, output], cfg.timeoutMs);
        return JSON.stringify(result, null, 2);
      },
    }));

    // Last mile: copy the export into War Thunder/UserSkins with the .blk named
    // after the vehicle model, which is the only thing the game looks for.
    ctx.effect(() => ctx.tools.register({
      name: 'dsh_wtskin_install',
      description: 'Install an exported skin into War Thunder/UserSkins: copies the DDS and writes <vehicle>.blk next to it so the game recognises it.',
      parameters: {
        dir: { type: 'string', required: true, description: 'Project directory (must be exported first).' },
        userSkinsDir: { type: 'string', description: 'Absolute path to War Thunder/UserSkins. Defaults to the detected Steam install.' },
        folder: { type: 'string', description: 'Folder name inside UserSkins. Defaults to the project folder name.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: cfg.timeoutMs,
      async execute(args) {
        const dir = path.resolve(args.dir);
        const { project } = await readProject(dir);
        const model = String(project.vehicle || '').trim();
        if (!model) throw new Error('project.vehicle is empty; set the vehicle model name first');
        const outDir = path.join(dir, project.output?.dir || 'out');
        const textureName = String(project.output?.textureName || '').trim();
        if (!textureName) throw new Error('project.output.textureName is empty');
        const ddsSrc = path.join(outDir, `${textureName}.dds`);
        if (!existsSync(ddsSrc)) throw new Error(`no ${textureName}.dds in ${outDir}; run dsh_wtskin_export first`);
        const ddsName = path.basename(ddsSrc);

        const candidates = [
          args.userSkinsDir,
          cfg.userSkinsDir,
          'E:/SteamLibrary/steamapps/common/War Thunder/UserSkins',
          'D:/SteamLibrary/steamapps/common/War Thunder/UserSkins',
          'C:/Program Files (x86)/Steam/steamapps/common/War Thunder/UserSkins',
        ].filter(Boolean);
        const root = candidates.find((candidate) => existsSync(candidate));
        if (!root) throw new Error('UserSkins not found; pass userSkinsDir explicitly');

        const folder = String(args.folder || path.basename(dir)).replace(/[\\/:*?"<>|]/g, '_');
        const target = path.join(root, folder);
        await fs.mkdir(target, { recursive: true });
        await fs.copyFile(ddsSrc, path.join(target, ddsName));

        const entries = Array.isArray(project.output?.blkEntries) && project.output.blkEntries.length
          ? project.output.blkEntries.map((entry) => ({ from: String(entry.from), to: ddsName }))
          : [{ from: `${model}_c*`, to: ddsName }];
        const blkName = `${model}.blk`;
        const body = [`name:t="user"`, ''];
        for (const entry of entries) {
          body.push('replace_tex{', `  from:t="${entry.from}"`, `  to:t="${entry.to}"`, '}', '');
        }
        const blkPath = path.join(target, blkName);
        await fs.writeFile(blkPath, `${body.join('\n')}\n`, 'utf8');
        return JSON.stringify({ ok: true, target, blk: blkPath, dds: path.join(target, ddsName), model, entries }, null, 2);
      },
    }));

    // Model-side import of the handoff file the user uploads into the chat.
    ctx.effect(() => ctx.tools.register({
      name: 'dsh_wtskin_import',
      description: 'Import a faces.json exported by the 涂装取点 panel (user uploads it in the chat). Adds or updates the polygon faces of a project.',
      parameters: {
        dir: { type: 'string', required: true, description: 'Project directory.' },
        file: { type: 'string', required: true, description: 'Path to the uploaded faces.json.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: cfg.timeoutMs,
      async execute(args) {
        const dir = path.resolve(args.dir);
        const raw = await fs.readFile(path.resolve(args.file), 'utf8');
        const data = JSON.parse(raw);
        const faces = Array.isArray(data) ? data : (Array.isArray(data.faces) ? data.faces : []);
        if (!faces.length) throw new Error('faces.json contains no faces');
        const { project } = await readProject(dir);
        project.layers = project.layers ?? [];
        const added = [];
        const updated = [];
        for (const face of faces) {
          const quad = face.points || face.quad;
          if (!isPolygon(quad)) throw new Error(`face ${face.id ?? '?'}: points must be 3-64 [x,y] pairs`);
          const id = String(face.id || `face_${project.layers.length + 1}`).trim();
          const clean = quad.map((p) => [Number(p[0]), Number(p[1])]);
          const index = project.layers.findIndex((layer) => layer.id === id);
          const patch = {
            quad: clean,
            size: face.size || (clean.length === 4 ? 'chord' : 'quadHeight'),
            ...(Array.isArray(face.edgeNames) ? { edgeNames: face.edgeNames.map(String) } : {}),
            ...(face.color ? { color: String(face.color) } : {}),
            ...(face.image ? { image: String(face.image) } : {}),
          };
          if (index >= 0) {
            project.layers[index] = { ...project.layers[index], ...patch };
            updated.push(id);
          } else {
            project.layers.push({ id, image: '', factor: 1, ...patch });
            added.push(id);
          }
        }
        await writeProject(dir, project);
        // Must be a plain string: the tool declares a string output schema and
        // returning a content array makes the host reject the result.
        return `Imported ${faces.length} face(s): ${added.length} added, ${updated.length} updated. Project now has ${project.layers.length} face(s); faces without art keep an empty image.`;
      },
    }));
  }
}
