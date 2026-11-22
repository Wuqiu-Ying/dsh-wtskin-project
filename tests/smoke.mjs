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
  let followupMessage;
  const agents = {
    get: () => ({
      inject: (text) => { injected.push(String(text)); },
      followup: (message) => {
        followed += 1;
        followupMessage = message;
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
  return { ctx, tools, commands, presets, injected, followedCount: () => followed, followupText: () => followupText, followupMessage: () => followupMessage };
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

function uniqueColors(file) {
  const outJson = path.join(os.tmpdir(), `wtskin-colors-${process.pid}-${Date.now()}.json`);
  const code = [
    'import sys, json',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB").resize((128, 128))',
    'json.dump(len(set(im.getdata())), open(sys.argv[2], "w"))',
  ].join('\n');
  execFileSync(python, ['-c', code, file, outJson], { stdio: 'inherit' });
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
  for (const toolName of ['dsh_wtskin_project', 'dsh_wtskin_layer', 'dsh_wtskin_export', 'dsh_wtskin_picker', 'dsh_wtskin_presets', 'dsh_wtskin_import', 'dsh_wtskin_install', 'dsh_wtskin_convert', 'dsh_wtskin_theme', 'dsh_wtskin_finalize']) {
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
  // Saving must not wake the model any more: the faces file is the handoff.
  assert(panel.followedCount() === 0, 'a panel save must not wake the model');
  const facesDoc = JSON.parse(await readFile(path.join(cwd, 'WTSP', 'Q-5L_霓虹夜航', 'faces.json'), 'utf8'));
  assert(facesDoc.faces.length === 1 && facesDoc.faces[0].id === 'wing_l', 'faces.json must mirror the saved face');
  const savedProject = JSON.parse(await readFile(path.join(cwd, 'WTSP', 'Q-5L_霓虹夜航', 'project.json'), 'utf8'));
  assert(savedProject.layers.length === 1 && savedProject.layers[0].id === 'wing_l', 'panel save missed the layer');
  assert(savedProject.layers[0].image === '', 'a panel-measured layer starts without art');

  const second = await panel.tools.get('dsh_wtskin_project').execute({
    action: 'create', vehicle: 'Q-5L', name: '霓虹夜航', data: { width: 512, height: 512 },
  });
  assert(second.includes('-2'), `a name collision must get a numeric suffix: ${second}`);

  // arbitrary polygons: 5 points, quadHeight sizing, colour and edge names survive
  const polyQuad = [[40, 40], [80, 40], [80, 80], [60, 90], [40, 80]];
  const polySaved = await save.handler({
    rawInput: JSON.stringify({
      dir: 'WTSP/Q-5L_霓虹夜航',
      faces: [{ id: 'wing_poly', quad: polyQuad, size: 'quadHeight', color: '#aabbcc', edgeNames: ['a', 'b', 'c', 'd', 'e'] }],
    }),
    agent: { id: 'a' },
  });
  assert(polySaved.kind === 'success', `polygon save failed: ${polySaved.text}`);
  const polyProject = JSON.parse(await readFile(path.join(cwd, 'WTSP', 'Q-5L_霓虹夜航', 'project.json'), 'utf8'));
  const polyLayer = polyProject.layers.find((layer) => layer.id === 'wing_poly');
  assert(polyLayer && polyLayer.quad.length === 5, 'polygon points were not stored');
  assert(polyLayer.color === '#aabbcc' && polyLayer.edgeNames.length === 5, 'polygon metadata missing');

  const flushed = await save.handler({
    rawInput: JSON.stringify({ dir: 'WTSP/Q-5L_霓虹夜航', faces: [], remove: [], flush: true }),
    agent: { id: 'a' },
  });
  assert(flushed.kind === 'success' && JSON.parse(flushed.text).facesPath.endsWith('faces.json'), 'flush must report the faces path');

  const deleted = await save.handler({
    rawInput: JSON.stringify({ dir: 'WTSP/Q-5L_霓虹夜航', faces: [], remove: ['wing_l'] }),
    agent: { id: 'a' },
  });
  assert(deleted.kind === 'success' && JSON.parse(deleted.text).removed.includes('wing_l'), 'delete must remove the face');
  const afterDelete = JSON.parse(await readFile(path.join(cwd, 'WTSP', 'Q-5L_霓虹夜航', 'project.json'), 'utf8'));
  assert(!afterDelete.layers.some((layer) => layer.id === 'wing_l'), 'deleted face still in project.json');
  assert(panel.followedCount() === 0, 'delete must not wake the model');

  const polyDir = path.join(dir, 'poly');
  await tools.get('dsh_wtskin_project').execute({
    dir: polyDir, action: 'create',
    data: { width: 256, height: 256, base: { fill: [10, 10, 10], edgeGlow: 0, dots: false }, output: { dir: 'out', textureName: 'poly_c', dds: false, preview: false, blk: false } },
  });
  await tools.get('dsh_wtskin_layer').execute({
    dir: polyDir, action: 'add',
    layer: { id: 'penta', image: charFile, quad: [[32, 32], [224, 32], [224, 224], [32, 224], [32, 128]], size: 'quadHeight' },
  });
  await tools.get('dsh_wtskin_export').execute({ dir: polyDir });
  const polyPng = path.join(polyDir, 'out', 'poly_c.png');
  const inside = pixel(polyPng, 128, 64);
  const outside = pixel(polyPng, 8, 8);
  assert(inside[0] > 200, `polygon should cover its interior: ${inside}`);
  assert(outside[0] < 40, `polygon should not cover the corner: ${outside}`);
  const cropDir = path.join(dir, 'cropbox');
  await tools.get('dsh_wtskin_project').execute({
    dir: cropDir, action: 'create',
    data: { width: 256, height: 256, base: { fill: [10, 10, 10], edgeGlow: 0, dots: false }, output: { dir: 'out', textureName: 'crop_c', dds: false, preview: false, blk: false } },
  });
  await tools.get('dsh_wtskin_layer').execute({
    dir: cropDir, action: 'add',
    layer: { id: 'pass', image: charFile, quad: [[64, 64], [192, 64], [192, 192], [64, 192]], size: 'crop' },
  });
  const cropOut = await tools.get('dsh_wtskin_export').execute({ dir: cropDir });
  assert(cropOut.includes('warnings: none'), `crop export should be clean: ${cropOut}`);
  let cropExists = true;
  try { await readFile(path.join(cropDir, 'out', 'crop_c.png')); } catch { cropExists = false; }
  assert(cropExists, 'crop export wrote no texture');

  const installDir = path.join(dir, 'install');
  await tools.get('dsh_wtskin_project').execute({
    dir: installDir, action: 'create', vehicle: 'q_5l',
    data: { width: 256, height: 256, base: { fill: [10, 10, 10], edgeGlow: 0, dots: false }, output: { dir: 'out', textureName: 'q_5l_c', dds: true, preview: false, blk: false } },
  });
  await tools.get('dsh_wtskin_layer').execute({
    dir: installDir, action: 'add',
    layer: { id: 'bg', image: charFile, quad: [[0, 0], [256, 0], [256, 256], [0, 256]], size: 'chord' },
  });
  await tools.get('dsh_wtskin_export').execute({ dir: installDir });
  const userskins = path.join(dir, 'UserSkins');
  const installed = JSON.parse(await tools.get('dsh_wtskin_install').execute({
    dir: installDir, userSkinsDir: userskins, folder: 'TestSkin',
  }));
  assert(installed.blk.endsWith('q_5l.blk'), `blk must be named after the vehicle model: ${installed.blk}`);
  const blkText = await readFile(installed.blk, 'utf8');
  assert(blkText.includes('from:t="q_5l_c*"') && blkText.includes('to:t="q_5l_c.dds"'), `blk entries wrong: ${blkText}`);
  await readFile(installed.dds);

  // TGA -> PNG conversion (the game ships TGA, editors prefer PNG)
  const tgaPath = path.join(dir, 'sample.tga');
  {
    const W = 4; const H = 4;
    const buf = Buffer.alloc(18 + W * H * 3);
    buf[2] = 2;                       // uncompressed true-colour
    buf.writeUInt16LE(W, 12);
    buf.writeUInt16LE(H, 14);
    buf[16] = 24;                     // 24 bpp
    for (let i = 0; i < W * H; i += 1) {
      const o = 18 + i * 3;
      buf[o] = 200; buf[o + 1] = 16; buf[o + 2] = 32;   // BGR
    }
    await writeFile(tgaPath, buf);
  }
  const conv = JSON.parse(await tools.get('dsh_wtskin_convert').execute({ input: tgaPath }));
  assert(conv.width === 4 && conv.height === 4, `convert dimensions: ${JSON.stringify(conv)}`);
  const pngHead = (await readFile(conv.output)).subarray(0, 4).toString('hex');
  assert(pngHead === '89504e47', `converted file is not a PNG: ${pngHead}`);

  // theme recolour + temporary cleanup
  const detailFile = path.join(dir, 'detail.png');
  {
    const code = [
      'import sys',
      'from PIL import Image',
      'import random',
      'random.seed(7)',
      'im = Image.new("RGB", (256, 256))',
      'px = im.load()',
      'for y in range(256):',
      '    for x in range(256):',
      '        base = int(30 + x * 0.7)',
      '        noise = int(random.random() * 50) if (x // 4 + y // 4) % 2 else 0',
      '        v = max(0, min(255, base + noise))',
      '        px[x, y] = (v, v, v)',
      'im.save(sys.argv[1])',
    ].join('\n');
    execFileSync(python, ['-c', code, detailFile], { stdio: 'inherit' });
  }
  const themeDir = path.join(dir, 'theme');
  await tools.get('dsh_wtskin_project').execute({
    dir: themeDir, action: 'create',
    data: { width: 256, height: 256, base: { image: detailFile, fill: [12, 24, 52], edgeGlow: 0, dots: false }, output: { dir: 'out', textureName: 'theme_c', dds: false, preview: false, blk: false } },
  });
  await tools.get('dsh_wtskin_layer').execute({
    dir: themeDir, action: 'add',
    layer: { id: 'bg', image: charFile, quad: [[0, 0], [256, 0], [256, 256], [0, 256]], size: 'chord' },
  });
  const themed = JSON.parse(await tools.get('dsh_wtskin_theme').execute({
    dir: themeDir, colors: [[8, 16, 40], [102, 204, 255]], source: detailFile, dropBaseLayer: true,
  }));
  assert(themed.palette.length === 2, 'theme palette missing');
  assert(themed.dropped.includes('bg'), `full-canvas layer should be dropped: ${JSON.stringify(themed)}`);
  const themedProject = JSON.parse(await readFile(path.join(themeDir, 'project.json'), 'utf8'));
  assert(themedProject.base.source === detailFile && themedProject.layers.length === 0, 'theme did not persist');
  await tools.get('dsh_wtskin_export').execute({ dir: themeDir });
  const themePng = path.join(themeDir, 'out', 'theme_c.png');
  const themedPixel = pixel(themePng, 128, 128);
  assert(themedPixel[2] > themedPixel[0] + 20, `recolour should be blue-dominant: ${themedPixel}`);
  const keepColors = uniqueColors(themePng);
  const flat = JSON.parse(await tools.get('dsh_wtskin_theme').execute({
    dir: themeDir, colors: [[8, 16, 40], [102, 204, 255]], detail: 'flat',
  }));
  assert(flat.detail === 'flat', 'flat detail should persist');
  await tools.get('dsh_wtskin_export').execute({ dir: themeDir });
  const flatColors = uniqueColors(themePng);
  assert(flatColors < keepColors / 2, `flat mode must smooth detail away (keep ${keepColors} vs flat ${flatColors})`);

  const tmpRefs = path.join(cwd, 'WTSP', 'temporary');
  await mkdir(tmpRefs, { recursive: true });
  await writeFile(path.join(tmpRefs, 'ref.bin'), 'x');
  const finalized = JSON.parse(await tools.get('dsh_wtskin_finalize').execute({ dir: cwd }));
  assert(finalized.removed.includes('ref.bin'), `finalize should report the removed file: ${JSON.stringify(finalized)}`);
  let tmpGone = false;
  try { await readFile(path.join(tmpRefs, 'ref.bin')); } catch { tmpGone = true; }
  assert(tmpGone, 'temporary folder should be cleared');

  // reference skin import: zip -> WTSP/temporary + blk/texture summary
  const refSrc = path.join(dir, 'refsrc');
  await mkdir(refSrc, { recursive: true });
  await writeFile(path.join(refSrc, 'test.blk'), 'name:t="user"\n\nreplace_tex{\n  from:t="x_c*"\n  to:t="x_c.dds"\n}\n');
  await writeFile(path.join(refSrc, 'x_c.dds'), 'DDS fake');
  const refZip = path.join(dir, 'ref.zip');
  execFileSync('tar', ['-a', '-c', '-f', refZip, '-C', refSrc, 'test.blk', 'x_c.dds'], { stdio: 'inherit' });
  const refOut = JSON.parse(await tools.get('dsh_wtskin_reference').execute({ file: refZip }));
  assert(refOut.results.length === 1, `reference import failed: ${JSON.stringify(refOut)}`);
  assert(String(refOut.results[0].blk || '').includes('replace_tex'), 'reference blk was not reported');
  assert((refOut.results[0].textures || []).some((t) => t.name === 'x_c.dds'), 'reference textures were not listed');

  console.log('WTSP + panel save + polygons ok');

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
