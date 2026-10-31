/**
 * End-to-end smoke test for dsh-wtskin-project v2.
 *
 *   node tests/smoke.mjs [pythonPath]
 *
 * Covers: tool registration, project create, layer add, palette/quad handling,
 * export, pixel placement (catches the v1 double-scale bug), rotated point
 * order, v1→v2 migration, picker generation and the /wtskinp command.
 */
import { mkdtemp, mkdir, rm, readFile, access, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const python = process.argv[2] ?? process.env.DSH_PYTHON ?? 'python';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeContext({ browser = false, cwd } = {}) {
  const tools = new Map();
  const commands = [];
  const presets = [];
  const workingDirectory = { defaultDirectory: cwd ?? os.tmpdir() };
  const injected = [];
  let followed = 0;
  let followupText = '';
  const agents = {
    get: () => ({
      inject: (text) => { injected.push(String(text)); },
      followup: (message) => {
        followed += 1;
        followupText = String(message?.content?.[0]?.text ?? '');
      },
    }),
  };
  const ctx = {
    tools: {
      register: (definition) => { tools.set(definition.name, definition); },
      get: (toolName) => (browser && toolName === 'dsh_browser_open' ? { name: toolName } : undefined),
      schemas: () => (browser ? [{ name: 'dsh_browser_open' }] : []),
    },
    systemPrompt: { section: () => {} },
    logger: { warn: (...parts) => console.warn('[warn]', ...parts) },
    effect: (fn) => { fn(); return () => {}; },
    inject: (deps, callback) => {
      if (deps.includes('agentPresets')) {
        callback({
          agentPresets: {
            register: async (definition) => { presets.push(definition); return () => {}; },
            list: async () => presets.map((definition) => ({ id: definition.id, name: definition.name, order: definition.order })),
          },
          effect: (fn) => { fn(); return () => {}; },
        });
      }
    },
    get: (serviceName) => {
      if (serviceName === 'commands') {
        return { register: (definition) => { commands.push(definition); return () => {}; } };
      }
      if (serviceName === 'workingDirectory') return workingDirectory;
      if (serviceName === 'agents') return agents;
      return undefined;
    },
  };
  apply(ctx, { pythonPath: python });
  return { ctx, tools, commands, presets, injected, followedCount: () => followed, followupText: () => followupText };
}

function pixel(file, x, y) {
  const outJson = path.join(os.tmpdir(), `wtskin-px-${process.pid}-${Date.now()}.json`);
  const code = [
    'import sys, json',
    'from PIL import Image',
    'im = Image.open(sys.argv[1])',
    'json.dump(list(im.getpixel((int(sys.argv[2]), int(sys.argv[3])))[:3]), open(sys.argv[4], "w"))',
  ].join('\n');
  execFileSync(python, ['-c', code, file, String(x), String(y), outJson], { stdio: 'inherit' });
  const value = JSON.parse(readFileSync(outJson, 'utf8'));
  rmSync(outJson, { force: true });
  return value;
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'wtskin2-'));
const charFile = path.join(dir, 'char.png');
const QUAD = [[32, 32], [224, 32], [224, 96], [32, 96]];
const ROTATED = [[224, 96], [32, 96], [32, 32], [224, 32]];
const BOWTIE = [[32, 32], [224, 96], [224, 32], [32, 96]];

try {
  execFileSync(python, ['-c', [
    'import sys',
    'from PIL import Image',
    'Image.new("RGBA", (32, 32), (255, 0, 0, 255)).save(sys.argv[1])',
  ].join('\n'), charFile], { stdio: 'inherit' });

  // ---------------------------------------------------------------- tools
  const { tools, commands, presets } = makeContext();
  for (const toolName of ['dsh_wtskin_project', 'dsh_wtskin_layer', 'dsh_wtskin_export', 'dsh_wtskin_picker', 'dsh_wtskin_presets']) {
    assert(tools.has(toolName), `missing tool ${toolName}`);
  }
  assert(commands.some((c) => c.name === 'wtskin-save'), 'missing the internal wtskin-save command');
  await new Promise((resolve) => setImmediate(resolve));
  assert(presets.length === 1, 'the mode preset was not registered');
  assert(presets[0].id === 'wtskin' && presets[0].plugins.length === 6, 'preset declaration is incomplete');
  assert(presets[0].name === '战雷画涂装模式', 'preset display name is wrong');
  const exportDef = tools.get('dsh_wtskin_export');
  assert(exportDef.parameters && exportDef.parameters.type === 'object', 'tool parameters must be a JSON Schema object');
  assert(exportDef.parameters.properties.dir, 'parameters must survive the schema conversion');
  console.log('tools + panel bridge ok');

  // ---------------------------------------------------------------- project
  const project = tools.get('dsh_wtskin_project');
  const created = await project.execute({
    dir,
    action: 'create',
    data: {
      width: 256,
      height: 256,
      base: { fill: [10, 10, 10], edgeGlow: 0, dots: false },
      output: { dir: 'out', textureName: 'probe_c', dds: false, preview: true, blk: false },
    },
  });
  assert(created.includes('created'), 'project create did not report success');
  await access(path.join(dir, 'picker.html'));
  assert(created.includes('picker:'), 'create should also write the picker');

  await tools.get('dsh_wtskin_layer').execute({
    dir,
    action: 'add',
    layer: { id: 'wing_l', image: charFile, quad: QUAD, size: 'chord' },
  });

  // ---------------------------------------------------------------- export
  const exportText = await tools.get('dsh_wtskin_export').execute({ dir });
  assert(exportText.includes('preview:'), 'export did not report a preview');
  const png = path.join(dir, 'out', 'probe_c.png');
  await access(png);
  await access(path.join(dir, 'out', '_preview_quads.png'));

  const centre = pixel(png, 128, 64);
  const corner = pixel(png, 8, 8);
  assert(centre[0] > 200 && centre[1] < 60, `layer not centred where expected: ${centre}`);
  assert(corner[0] < 40, `base should stay dark at the corner: ${corner}`);
  console.log('export + pixel placement ok', centre, corner);

  // ---------------------------------------------------------------- rotation
  // Starting at a different corner in perimeter order must not change the image:
  // points 3-4 are still the opposite edge, so the chord is the same.
  await tools.get('dsh_wtskin_layer').execute({ dir, action: 'update', id: 'wing_l', layer: { quad: ROTATED } });
  await tools.get('dsh_wtskin_export').execute({ dir });
  const png2 = path.join(dir, 'out', 'probe_c.png');
  const hashRotated = createHash('sha256').update(await readFile(png2)).digest('hex');
  await tools.get('dsh_wtskin_layer').execute({ dir, action: 'update', id: 'wing_l', layer: { quad: QUAD } });
  await tools.get('dsh_wtskin_export').execute({ dir });
  const hashNormal = createHash('sha256').update(await readFile(png2)).digest('hex');
  assert(hashRotated === hashNormal, 'perimeter order must not depend on the starting corner');

  await tools.get('dsh_wtskin_layer').execute({ dir, action: 'update', id: 'wing_l', layer: { quad: BOWTIE } });
  const bowtieText = await tools.get('dsh_wtskin_export').execute({ dir });
  assert(/cross/.test(bowtieText), 'a self-intersecting quad must be reported');
  await tools.get('dsh_wtskin_layer').execute({ dir, action: 'update', id: 'wing_l', layer: { quad: QUAD } });
  console.log('quad validation ok');

  // ---------------------------------------------------------------- normal map
  await tools.get('dsh_wtskin_project').execute({ dir, action: 'update', data: { output: { normal: { enabled: true, strength: 2 } } } });
  const normalText = await tools.get('dsh_wtskin_export').execute({ dir });
  assert(normalText.includes('normal:'), 'normal map was not reported');
  await access(path.join(dir, 'out', 'probe_c_n.png'));
  console.log('normal map ok');

  // ---------------------------------------------------------------- picker
  const pickerHtml = await readFile(path.join(dir, 'picker.html'), 'utf8');
  assert(pickerHtml.includes('wing_l'), 'picker should list the project faces');
  assert(!pickerHtml.includes('__WTSKIN_CONFIG__'), 'picker config was not injected');
  console.log('picker ok');

  // ---------------------------------------------------------------- migration
  const v1Dir = path.join(dir, 'v1');
  await mkdir(v1Dir, { recursive: true });
  await writeFile(path.join(v1Dir, 'project.json'), JSON.stringify({
    version: 1,
    width: 1024,
    height: 1024,
    quadScale: 2.56,
    layers: [{ id: 'a', image: 'char.png', quad: [[10, 10], [20, 10], [20, 20], [10, 20]], quadScale: 2.56 }],
  }, null, 2), { encoding: 'utf8' });
  const readBack = JSON.parse(await tools.get('dsh_wtskin_project').execute({ dir: v1Dir, action: 'read' }));
  assert(readBack._migration.length > 0, 'v1 project should report migration notes');
  assert(readBack.layers[0].quadScale === undefined, 'v1 layer quadScale must be dropped');
  assert(readBack.quadScale === undefined, 'v1 project quadScale must be dropped');
  console.log('v1 migration ok');

  // ---------------------------------------------------------------- WTSP + panel save
  const cwd = path.join(dir, 'cwd');
  await mkdir(cwd, { recursive: true });
  const panel = makeContext({ cwd });

  const createdWtsp = await panel.tools.get('dsh_wtskin_project').execute({
    action: 'create', vehicle: 'Q-5L', name: '霓虹夜航', data: { width: 512, height: 512 },
  });
  assert(createdWtsp.includes('WTSP'), `project should land in WTSP: ${createdWtsp}`);
  assert(createdWtsp.includes('Q-5L_霓虹夜航'), `directory should be vehicle_name: ${createdWtsp}`);

  const save = panel.commands.find((command) => command.name === 'wtskin-save');
  const saved = await save.handler({
    rawInput: JSON.stringify({
      dir: 'WTSP/Q-5L_霓虹夜航',
      faces: [{ id: 'wing_l', quad: [[10, 10], [50, 10], [50, 40], [10, 40]] }],
    }),
    agent: { id: 'a' },
  });
  assert(saved.kind === 'success', `panel save failed: ${saved.text}`);
  assert(panel.followedCount() === 1, 'the wake must call followup once');
  assert(panel.followupText().includes('面板刚保存'), 'the wake must carry the save summary');
  const savedProject = JSON.parse(await readFile(path.join(cwd, 'WTSP', 'Q-5L_霓虹夜航', 'project.json'), 'utf8'));
  assert(savedProject.layers.length === 1 && savedProject.layers[0].id === 'wing_l', 'panel save missed the layer');
  assert(savedProject.layers[0].image === '', 'a panel-measured layer starts without art');

  const second = await panel.tools.get('dsh_wtskin_project').execute({
    action: 'create', vehicle: 'Q-5L', name: '霓虹夜航', data: { width: 512, height: 512 },
  });
  assert(second.includes('-2'), `a name collision must get a numeric suffix: ${second}`);
  console.log('WTSP + panel save ok');

  // ---------------------------------------------------------------- /wtskinp
  const noBrowser = makeContext({ cwd });
  const refused = await noBrowser.commands.find((command) => command.name === 'wtskinp').handler({
    rawInput: '', agent: { id: 'a' }, attachments: [], signal: new AbortController().signal,
  });
  assert(refused.kind === 'error' && /浏览器/.test(refused.text), 'wtskinp must refuse without browser control');

  const withBrowser = makeContext({ cwd, browser: true });
  const started = await withBrowser.commands.find((command) => command.name === 'wtskinp').handler({
    rawInput: '苏-27 海天', agent: { id: 'a' }, attachments: [], signal: new AbortController().signal,
  });
  assert(started.kind === 'success' && /工程已创建/.test(started.text), `wtskinp failed: ${started.text}`);
  await access(path.join(cwd, 'WTSP', '苏-27_海天', 'project.json'));

  const bare = await withBrowser.commands.find((command) => command.name === 'wtskinp').handler({
    rawInput: '', agent: { id: 'a' }, attachments: [], signal: new AbortController().signal,
  });
  assert(bare.kind === 'success' && /先/.test(bare.text), 'wtskinp without args should ask first');
  console.log('/wtskinp ok');

  console.log('\nall checks passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
