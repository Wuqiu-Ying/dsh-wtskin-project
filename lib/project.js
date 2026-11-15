/**
 * project.json model for dsh-wtskin-project v2.
 *
 * One rule drives the whole format: every quad is stored in FINAL texture
 * pixels. There is no per-project or per-layer scale factor any more, which is
 * what made v1 scale quads twice (picker ×scale, engine ×quadScale again).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

export const SIZE_MODES = ['chord', 'quadHeight', 'height', 'widthAdapt', 'crop', 'cover'];

export const DEFAULT_PROJECT = {
  version: SCHEMA_VERSION,
  name: 'wt-skin',
  vehicle: '',
  width: 4096,
  height: 4096,
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
    normal: { enabled: false, strength: 3 },
  },
  notes: [],
};

export function projectFile(dir) {
  return path.join(dir, 'project.json');
}

export function newProject(dir, overrides = {}) {
  const project = structuredClone(DEFAULT_PROJECT);
  project.name = path.basename(dir) || 'wt-skin';
  if (overrides.vehicle) project.vehicle = String(overrides.vehicle);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'base' || key === 'output') project[key] = { ...project[key], ...value };
    else if (key !== 'version') project[key] = value;
  }
  return project;
}

export async function readProject(dir) {
  const file = projectFile(dir);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`no project.json in ${dir} (run dsh_wtskin_project action=create first)`);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`project.json is not valid JSON: ${error.message}`);
  }
  return migrate(parsed);
}

export async function writeProject(dir, project) {
  await fs.mkdir(dir, { recursive: true });
  const file = projectFile(dir);
  await fs.writeFile(file, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * v1 → v2.
 *
 * v1 wrote quads through the picker already multiplied by the page scale, and
 * then multiplied them again in the engine by `quadScale`. v1 quads are
 * therefore already final pixels: dropping the scale fields restores the
 * intended geometry instead of asking the user to re-measure.
 */
export function migrate(input) {
  const project = structuredClone(input);
  const notes = [];
  if (Number(project.version ?? 1) >= SCHEMA_VERSION) {
    project.version = SCHEMA_VERSION;
    return { project, notes };
  }

  if (project.quadScale !== undefined) {
    delete project.quadScale;
    notes.push('dropped project.quadScale: v2 quads are final texture pixels');
  }
  for (const layer of project.layers ?? []) {
    if (layer.quadScale !== undefined) {
      delete layer.quadScale;
      notes.push(`layer ${layer.id}: dropped quadScale (v1 stored scaled coordinates, so this restores the drawn position)`);
    }
  }
  project.version = SCHEMA_VERSION;
  if (!Array.isArray(project.notes)) project.notes = [];
  project.notes.push(`migrated from v1 at ${new Date().toISOString()}`);
  return { project, notes };
}

export function isPolygon(value) {
  return Array.isArray(value) && value.length >= 3 && value.length <= 64
    && value.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
}

/** Legacy name kept for callers that still describe a four-point panel. */
export function isQuad(value) {
  return Array.isArray(value) && value.length === 4 && isPolygon(value);
}

export function normaliseLayer(input, id) {
  if (!input || typeof input !== 'object') throw new Error('layer must be an object');
  if (!input.image) throw new Error(`layer ${id}: image is required`);
  if (!isPolygon(input.quad)) throw new Error(`layer ${id}: quad must be 3-64 [x,y] points`);
  const layer = {
    id,
    image: String(input.image),
    quad: input.quad.map((p) => [Number(p[0]), Number(p[1])]),
    size: input.size ?? 'chord',
    factor: input.factor ?? 1,
  };
  if (!SIZE_MODES.includes(layer.size)) {
    throw new Error(`layer ${id}: unknown size "${layer.size}" (expected ${SIZE_MODES.join(' | ')})`);
  }
  if (!(Number(layer.factor) > 0)) throw new Error(`layer ${id}: factor must be > 0`);
  for (const key of ['offset', 'rotate180', 'flip', 'clipLine', 'expand', 'opacity', 'aspect', 'height', 'note', 'edgeNames', 'color']) {
    if (input[key] !== undefined) layer[key] = input[key];
  }
  if (layer.size === 'height' && !(Number(layer.height) > 0)) {
    throw new Error(`layer ${id}: size "height" needs a positive "height" in pixels`);
  }
  if (layer.clipLine !== undefined) {
    const line = layer.clipLine;
    const ok = Array.isArray(line) && line.length === 2 && line.every(
      (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])),
    );
    if (!ok) throw new Error(`layer ${id}: clipLine must be 2 [x,y] points`);
    layer.clipLine = line.map((p) => [Number(p[0]), Number(p[1])]);
  }
  if (layer.opacity !== undefined && !(Number(layer.opacity) >= 0 && Number(layer.opacity) <= 1)) {
    throw new Error(`layer ${id}: opacity must be within 0..1`);
  }
  if (Array.isArray(layer.offset) && layer.offset.length === 2) {
    layer.offset = [Number(layer.offset[0]), Number(layer.offset[1])];
  }
  return layer;
}

export function validateProject(project) {
  const problems = [];
  const width = Number(project.width);
  const height = Number(project.height);
  if (!Number.isInteger(width) || width < 16) problems.push('width must be an integer ≥ 16');
  if (!Number.isInteger(height) || height < 16) problems.push('height must be an integer ≥ 16');
  const ids = new Set();
  for (const layer of project.layers ?? []) {
    if (!layer.id) problems.push('every layer needs an id');
    else if (ids.has(layer.id)) problems.push(`duplicate layer id ${layer.id}`);
    ids.add(layer.id);
    if (!layer.image) problems.push(`layer ${layer.id}: image is empty`);
    if (!isPolygon(layer.quad)) problems.push(`layer ${layer.id}: quad must be 3-64 [x,y] points`);
    if (!SIZE_MODES.includes(layer.size ?? 'chord')) problems.push(`layer ${layer.id}: unknown size ${layer.size}`);
    if (layer.quad && isPolygon(layer.quad)) {
      for (const [x, y] of layer.quad) {
        if (x < 0 || y < 0 || x > width || y > height) {
          problems.push(`layer ${layer.id}: quad point (${x},${y}) is outside the ${width}×${height} canvas`);
          break;
        }
      }
    }
  }
  const palette = project.base?.palette;
  if (palette !== undefined) {
    if (!Array.isArray(palette) || palette.length < 2) problems.push('base.palette needs at least two stops');
    else if (!palette.every((s) => Array.isArray(s) && Number.isFinite(Number(s[0])) && Array.isArray(s[1]) && s[1].length === 3)) {
      problems.push('base.palette stops must be [t, [r, g, b]]');
    }
  }
  return problems;
}

export function quadString(quad) {
  return `[[${quad.map((p) => `${p[0]},${p[1]}`).join('],[')}]]`;
}

export function describeLayers(project) {
  return (project.layers ?? []).map((layer) => ({
    id: layer.id,
    image: path.basename(layer.image ?? ''),
    size: layer.size ?? 'chord',
    factor: layer.factor ?? 1,
    quad: quadString(layer.quad ?? []),
  }));
}
