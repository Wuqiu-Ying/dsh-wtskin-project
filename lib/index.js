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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROJECT,
  SCHEMA_VERSION,
  describeLayers,
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

const PRESET_PERSONA = [
  '你在「战雷画涂装模式」下工作，用户要做战争雷霆的自定义载具涂装。',
  '',
  '首轮回复必须一次问清两件事，用 ask_user_question 一次问两个问题：',
  '1) 要做哪个载具（给出 3-4 个常见机型作为选项，也允许自定义输入）；',
  '2) 这个涂装叫什么名字（用户直接说了就用他说过的，不再重复问）。',
  '同时说明：搜索载具资料需要浏览器插件，没有就提示用户安装。',
  '',
  '之后按这个顺序推进：',
  '- 用 web_search / web_fetch 查该载具的公开资料（国别、定位、常见配色风格、游戏内贴图名），把要点写进工程 notes；',
  '- 用 dsh_wtskin_project action=create + vehicle + name 建档（目录会自动落在 WTSP/<载具>_<名称>）；',
  '- 告诉用户右栏「涂装取点」面板已经可以用了；',
  '- 用户量完面后，根据面名把立绘用 dsh_wtskin_layer action=update 补上 image；',
  '- dsh_wtskin_export 之后必须用 read_image 看 out/preview.png 与 out/_preview_quads.png 自检，再迭代。',
  '',
  '工程的四边形坐标都是最终贴图像素，不要再乘任何缩放。',
].join('\n');

const PRESET_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: PRESET_PERSONA } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
];

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
function runEngine(python, engine, projectFile, timeoutMs) {
  const outFile = path.join(os.tmpdir(), `wtskin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(python, [engine, 'export', projectFile, '--out', outFile], {
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
      }).catch((error) => {
        fs.rm(outFile, { force: true }).catch(() => {});
        reject(spawnError
          ? new Error(`cannot start python (${python}): ${spawnError.message}`)
          : new Error(`skin engine failed and left no result: ${error.message}`));
      });
    };

    child.on('error', (error) => settle(null, error));
    child.on('close', (code) => settle(code));
  });
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
    effect(() => {
      let dispose = null;
      let disposed = false;
      Promise.resolve(presets.register({
        id: PRESET_ID,
        name: '战雷画涂装模式',
        description: '与 AI 一起做战争雷霆载具涂装：查资料、量 UV、放立绘、导出 DDS + blk。',
        order: 10,
        plugins: PRESET_PLUGINS,
      }))
        .then((fn) => {
          if (disposed) Promise.resolve(fn && fn()).catch(() => {});
          else dispose = fn;
          void writePresetStatus({ ok: true, id: PRESET_ID, plugins: PRESET_PLUGINS.length });
        })
        .catch((error) => {
          const message = String((error && error.message) || error);
          logger?.warn?.(`dsh-wtskin-project: preset registration failed: ${message}`);
          void writePresetStatus({ ok: false, id: PRESET_ID, error: message });
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
      'This mode has a right-sidebar picker panel ("涂装取点"). The user measures panels there; each save writes the quad straight into project.json (layers start with an empty image).',
      'Every quad is in FINAL texture pixels — never scale it again; the panel already multiplies the preview coordinates once.',
      'A quad is one panel: points 1-2 are one edge, 3-4 the opposite edge, the chord runs between their midpoints. The panel draws that chord, so the user sees what the engine will use.',
      'After the user attaches art, update the layer with image=<path>; then dsh_wtskin_export and call read_image on out/preview.png and out/_preview_quads.png to check the result yourself.',
      'Export writes a per-layer report (chord, covered pixels, overlap, warnings) — use it instead of guessing.',
      'Vehicles differ in blk entries and texture names — seed a project with dsh_wtskin_project preset=<id> or read the vehicle blk from UserSkins.',
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
    async execute(args) {
      const cwd = ctx.get?.("workingDirectory")?.defaultDirectory ?? process.cwd();
      const data = args.data ?? {};
      let dir = args.dir ? path.resolve(args.dir) : '';
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
        await markOpenRequest(cwd);
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
    description: 'Generate or refresh the quad picker page (picker.html) for a project and return its path. The user opens it in the DSH file preview, picks 4 points per panel, then uses 复制全部.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: cfg.timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const { project } = await readProject(dir);
      const file = await writePicker(dir, project);
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
      if (typeof agent.inject === 'function') agent.inject(text);
      if (typeof agent.followup === 'function') {
        agent.followup();
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
        const cwd = ctx.get?.("workingDirectory")?.defaultDirectory ?? process.cwd();

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
            await markOpenRequest(cwd);
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
            '2. 告诉用户右栏「涂装取点」面板已经可以用，让用户在面板里量面；',
            '3. 用户量完面后按面名用 dsh_wtskin_layer action=update 补 image；',
            '4. dsh_wtskin_export 后用 read_image 看 out/preview.png 与 out/_preview_quads.png 自检。',
          ].join('\n')
          : [
            '【WTSkin 开始】',
            '首轮先用 ask_user_question 一次问清两件事：',
            '1) 要做哪个载具（给 3-4 个常见机型选项，也允许自定义）；',
            '2) 这个涂装叫什么名字（用户没说就让他给一个主题词）。',
            '拿到后调用 dsh_wtskin_project action=create vehicle=<载具> name=<名字>，目录会自动落在 WTSP/<载具>_<名字>。',
            '然后查资料、请用户在右栏「涂装取点」面板量面，再导出并用 read_image 自检。',
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

    // Panel bridge. The client half has no file-write Remote, so saving goes
    // through this host command; it is listed in the / menu by design.
    ctx.effect(() => commands.register({
      name: 'wtskin-save',
      description: '（内部）涂装取点面板保存四边形，请勿手动调用',
      handler: async (invocation) => {
        try {
          const raw = String(invocation.rawInput ?? '').trim();
          if (!raw) throw new Error('empty payload');
          const payload = JSON.parse(raw);
          if (!payload?.dir) throw new Error('dir is required');
          const base = ctx.get?.("workingDirectory")?.defaultDirectory ?? process.cwd();
          const requested = String(payload.dir);
          const dir = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested);
          const faces = Array.isArray(payload.faces) ? payload.faces : [];
          if (!faces.length) throw new Error('no faces');

          const { project } = await readProject(dir);
          project.layers = project.layers ?? [];
          project.version = SCHEMA_VERSION;
          const saved = [];
          for (const face of faces) {
            const quad = face?.quad;
            if (!isQuad(quad)) throw new Error(`face ${face?.id ?? '?'}: quad must be 4 [x,y] points`);
            const id = String(face.id || '').trim() || `face_${project.layers.length + 1}`;
            const clean = quad.map((p) => [Number(p[0]), Number(p[1])]);
            const index = project.layers.findIndex((layer) => layer.id === id);
            if (index >= 0) {
              project.layers[index] = { ...project.layers[index], quad: clean };
            } else {
              project.layers.push({ id, image: '', quad: clean, size: 'chord', factor: 1 });
            }
            saved.push(id);
          }
          await writeProject(dir, project);
          return {
            kind: 'success',
            text: JSON.stringify({ ok: true, dir, saved, layers: project.layers.length }),
          };
        } catch (error) {
          return { kind: 'error', text: String((error && error.message) || error) };
        }
      },
    }));
  }
}
