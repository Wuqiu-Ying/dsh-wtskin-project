/**
 * dsh-wtskin-project — War Thunder user-skin studio for DSH.
 *
 * Tools:
 *   dsh_wtskin_project  create / read / update a project
 *   dsh_wtskin_layer    add / update / remove / list quad-anchored layers
 *   dsh_wtskin_export   composite + write PNG / DDS / preview / .blk
 *   dsh_wtskin_presets  list built-in vehicle presets
 *   dsh_wtskin_measure  serve the quad picker and return its local URL
 *
 * The engine needs Pillow + numpy; point `pythonPath` at a Python that has them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { createMeasureServer } from './measure-server.js';

export const name = 'dsh-wtskin-project';
export const inject = ['tools', 'systemPrompt'];

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const DEFAULT_ENGINE = path.join(packageRoot, 'python', 'wt_skin.py');
const MEASURE_PAGE = path.join(packageRoot, 'assets', 'measure.html');
const PRESETS_FILE = path.join(packageRoot, 'presets', 'vehicles.json');

const DEFAULT_PROJECT = {
  name: 'wt-skin',
  width: 4096,
  height: 4096,
  quadScale: 1,
  base: {
    palette: [
      [0.0, [3, 6, 16]],
      [0.22, [9, 17, 42]],
      [0.5, [20, 41, 90]],
      [0.76, [46, 90, 168]],
      [1.0, [140, 200, 255]],
    ],
    contrast: 1,
    edgeGlow: 80,
    dots: true,
  },
  layers: [],
  output: {
    dir: 'out',
    textureName: 'skin_c',
    dds: true,
    preview: true,
    blk: true,
    blkName: 'skin.blk',
    blkEntries: [],
  },
};

function fail(message) {
  throw new Error(message);
}

function projectPath(dir) {
  return path.join(dir, 'project.json');
}

async function readProject(dir) {
  try {
    return JSON.parse(await fs.readFile(projectPath(dir), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') fail(`no project.json in ${dir}`);
    throw error;
  }
}

async function writeProject(dir, project) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(projectPath(dir), JSON.stringify(project, null, 2), 'utf8');
}

function isQuad(value) {
  return Array.isArray(value) && value.length === 4
    && value.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n))));
}

function normaliseLayer(input, id) {
  if (!input || typeof input !== 'object') fail('layer must be an object');
  if (!input.image) fail('layer.image is required');
  if (!isQuad(input.quad)) fail('layer.quad must be 4 [x,y] points');
  const layer = {
    id,
    image: String(input.image),
    quad: input.quad.map((p) => [Number(p[0]), Number(p[1])]),
    size: input.size ?? 'chord',
    factor: input.factor ?? 1,
  };
  for (const key of ['offset', 'rotate180', 'flip', 'clipLine', 'expand', 'opacity', 'aspect', 'height', 'quadScale']) {
    if (input[key] !== undefined) layer[key] = input[key];
  }
  return layer;
}

function resolvePython(config, override) {
  const candidates = [override, config.pythonPath, process.env.DSH_PYTHON].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return candidates[0] || 'python';
}

function runEngine(python, engine, projectFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [engine, 'export', projectFile], {
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`skin engine timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot start python (${python}): ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`skin engine failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ raw: stdout.trim() });
      }
    });
  });
}

export function apply(ctx, config = {}) {
  const timeoutMs = Number(config.timeoutMs ?? 180_000);
  let measureServer = null;

  ctx.effect(() => () => {
    measureServer?.then((server) => server.close()).catch(() => {});
    measureServer = null;
  });

  ctx.systemPrompt.section({
    name: 'tool:wt-skin',
    order: 160,
    text: [
      'War Thunder skin studio (dsh_wtskin_*): build user skins as a declarative project.',
      'Workflow: (1) dsh_wtskin_project action=create dir=... width/height, (2) dsh_wtskin_measure to open the quad picker, (3) dsh_wtskin_layer action=add with an image and the measured quad, (4) dsh_wtskin_export to composite and write PNG/DDS/preview/.blk.',
      'Quads are in texture pixels; when measured on a 1600 preview set quadScale=2.56 (4096/1600) and keep quads in 1600-space. The picker page writes its quad (already multiplied by the page scale) into the project with a per-layer quadScale, so do not double-scale it.',
      'Each layer is clipped to its quad, so art cannot leak onto other surfaces; use size "chord" (fit the panel chord), "quadHeight", "height" or "widthAdapt" (narrow root strips).',
      'Vehicles differ in blk entries and texture names — use dsh_wtskin_presets or read the vehicle blk from UserSkins. Export writes into the project output.dir; copy that folder into the game UserSkins directory.',
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
    description: 'Create, read or update a War Thunder skin project (project.json): canvas size, base livery, output settings. Layers are managed by dsh_wtskin_layer.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory (created on demand).' },
      action: { type: 'string', required: true, description: 'create | read | update' },
      data: { type: 'json', description: 'Object merged into the project (base, output, width, height, quadScale, name).' },
      force: { type: 'boolean', description: 'create: overwrite an existing project.json.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const file = projectPath(dir);
      if (args.action === 'read') return JSON.stringify(await readProject(dir), null, 2);
      if (args.action === 'create') {
        if (!args.force && existsSync(file)) fail(`project already exists: ${file} (pass force:true to overwrite)`);
        const project = structuredClone(DEFAULT_PROJECT);
        project.name = path.basename(dir);
        Object.assign(project, args.data ?? {});
        await writeProject(dir, project);
        return `created ${file}`;
      }
      if (args.action === 'update') {
        const project = await readProject(dir);
        for (const [key, value] of Object.entries(args.data ?? {})) {
          if (key === 'base' || key === 'output') project[key] = { ...project[key], ...value };
          else project[key] = value;
        }
        await writeProject(dir, project);
        return `updated ${file}`;
      }
      fail(`unknown action ${args.action}`);
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_layer',
    description: 'Add, update, remove or list layers of a skin project. A layer is an image anchored to a 4-point quad (texture pixels) with optional rotation, flip, offset, size mode and clipping line.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory.' },
      action: { type: 'string', required: true, description: 'add | update | remove | list' },
      id: { type: 'string', description: 'Layer id (required for update/remove).' },
      layer: { type: 'json', description: 'Layer object: {image, quad, size, factor, offset, rotate180, flip, clipLine, expand, opacity, quadScale}.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const project = await readProject(dir);
      project.layers = project.layers ?? [];
      if (args.action === 'list') {
        return JSON.stringify(project.layers.map((l) => ({ id: l.id, image: l.image, size: l.size, factor: l.factor })), null, 2);
      }
      if (args.action === 'add') {
        const id = args.id || `L${project.layers.length + 1}`;
        if (project.layers.some((l) => l.id === id)) fail(`layer id already exists: ${id}`);
        project.layers.push(normaliseLayer(args.layer, id));
        await writeProject(dir, project);
        return `added layer ${id} (total ${project.layers.length})`;
      }
      if (args.action === 'update') {
        if (!args.id) fail('id is required for update');
        const index = project.layers.findIndex((l) => l.id === args.id);
        if (index < 0) fail(`no layer ${args.id}`);
        project.layers[index] = normaliseLayer({ ...project.layers[index], ...(args.layer ?? {}) }, args.id);
        await writeProject(dir, project);
        return `updated layer ${args.id}`;
      }
      if (args.action === 'remove') {
        if (!args.id) fail('id is required for remove');
        const before = project.layers.length;
        project.layers = project.layers.filter((l) => l.id !== args.id);
        if (project.layers.length === before) fail(`no layer ${args.id}`);
        await writeProject(dir, project);
        return `removed layer ${args.id}`;
      }
      fail(`unknown action ${args.action}`);
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_export',
    description: 'Composite the project (base livery + layers) and write PNG, uncompressed DDS, preview and .blk. Returns the output paths. Copy the output folder into War Thunder/UserSkins to install.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory.' },
      pythonPath: { type: 'string', description: 'Override the Python interpreter (needs Pillow + numpy).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const project = await readProject(dir);
      const engine = config.enginePath || DEFAULT_ENGINE;
      if (!existsSync(engine)) fail(`engine not found: ${engine}`);
      const python = resolvePython(config, args.pythonPath);
      const result = await runEngine(python, engine, projectPath(dir), timeoutMs);
      return [
        `texture: ${result.png ?? '?'}`,
        `dds: ${result.dds ?? '(disabled)'}`,
        `preview: ${result.preview ?? '(disabled)'}`,
        `blk: ${result.blk ?? '(disabled)'}`,
        `layers: ${result.layers ?? project.layers.length}`,
        JSON.stringify(result),
      ].join('\n');
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_presets',
    description: 'List built-in vehicle presets (texture names and .blk entries) that can seed a skin project.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    async execute() {
      try {
        return await fs.readFile(PRESETS_FILE, 'utf8');
      } catch {
        return '[]';
      }
    },
  }));

  register(defineTool({
    name: 'dsh_wtskin_measure',
    description: 'Start the local quad picker (image-pixel-coords with a 4-point mode) and return its URL. Open the URL, load a texture preview, click 4 points, then "保存到工程" writes the quad into the project layer (or use 复制 and pass it to dsh_wtskin_layer).',
    parameters: {
      dir: { type: 'string', required: true, description: 'Project directory that receives the measured quad.' },
      id: { type: 'string', description: 'Layer id to create/update (default: measure).' },
      image: { type: 'string', description: 'Image path stored on the layer (optional).' },
      scale: { type: 'number', description: 'Multiplier applied to picked pixels before saving (default: project.quadScale, else 1).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    async execute(args) {
      const dir = path.resolve(args.dir);
      const project = await readProject(dir);
      const id = args.id || 'measure';
      const scale = Number.isFinite(Number(args.scale)) && Number(args.scale) > 0
        ? Number(args.scale)
        : Number(project.quadScale) || 1;
      if (!measureServer) {
        measureServer = createMeasureServer({ htmlPath: MEASURE_PAGE }).catch((error) => {
          measureServer = null;
          throw error;
        });
      }
      const server = await measureServer;
      const query = new URLSearchParams({ dir, id, scale: String(scale) });
      if (args.image) query.set('image', args.image);
      return [
        `measure page: ${server.url}/?${query.toString()}`,
        `saving into: ${dir} (layer "${id}", scale ×${scale})`,
        'Open that URL in the browser, load the texture image (drag & drop or Ctrl+V), pick 4 points in order, then 保存到工程 or 复制.',
      ].join('\n');
    },
  }));
}
