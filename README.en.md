# dsh-wtskin-project

**War Thunder user-skin studio**, packaged as a DSH plugin. It turns the workflow
"measure UV → place art per panel → composite → export DDS + .blk" into model-callable
tools, and ships a 4-point quad picker.

[中文](README.md) | English

## Tools

| Tool | Purpose |
| --- | --- |
| `dsh_wtskin_project` | Create / read / update `project.json` (canvas size, base livery, output settings) |
| `dsh_wtskin_layer` | Add / update / remove / list layers: image + 4-point quad + rotation / flip / offset / clip line |
| `dsh_wtskin_export` | Composite the base and every layer into PNG, DDS, preview and `.blk` |
| `dsh_wtskin_presets` | List built-in vehicle presets (texture names and `.blk` entries) |
| `dsh_wtskin_measure` | Start the local quad picker (4-point mode) and return its URL |

## Quad picker

`dsh_wtskin_measure` starts a single-page local server on `127.0.0.1` (random port) and
serves the bundled `assets/measure.html` (an extension of `image-pixel-coords.html`):

- drop or paste a texture preview
- click **四点框选** (4-point mode), then click four corners in order; the quad is drawn live
- the **scale ×** field defaults to the project's `quadScale` (e.g. `2.56` for a 1600 preview)
- **保存到工程** (save to project) writes the quad straight into the given layer of
  `project.json` — the layer carries its own `quadScale`, so it will not be scaled twice
- **复制** (copy) emits `[[x,y],[x,y],[x,y],[x,y]]` for `dsh_wtskin_layer`

The page is plain JavaScript and needs no network access.

## Quick start

```text
dsh_wtskin_project  dir=D:/skins/q5l action=create data={"quadScale":2.56,"width":4096,"height":4096}
dsh_wtskin_measure  dir=D:/skins/q5l id=wing_u scale=2.56
# open the returned URL, pick 4 points, then "保存到工程"
dsh_wtskin_layer    dir=D:/skins/q5l action=update id=wing_u layer={"image":"p8.png","size":"chord","factor":1.3,"rotate180":true}
dsh_wtskin_export   dir=D:/skins/q5l
```

### Size modes

- `chord` — scale by the distance between the quad's leading- and trailing-edge midpoints (most common)
- `quadHeight` — scale by the quad's bounding-box height
- `height` — explicit pixel height
- `widthAdapt` — for narrow root strips: fit the width and keep a margin

### Layer fields

```json
{
  "image": "path/to/character.png",
  "quad": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]],
  "quadScale": 1,
  "size": "chord",
  "factor": 1.2,
  "offset": [0, -40],
  "rotate180": true,
  "flip": false,
  "clipLine": [[x0,y0],[x1,y1]],
  "expand": 8,
  "opacity": 1
}
```

The first two points are the leading edge; the last two are the trailing edge — the engine
uses them for chord length and centre. `quadScale` is the layer's own coordinate scale and
overrides the project-level setting.

## Install

```bash
# with the dsh CLI
dsh plugin --profile desktop add link:D:/path/to/dsh-wtskin-project

# without it
node install.mjs --profile desktop
```

Then restart DSH (tools register at startup). To uninstall, delete
`profiles/<profile>/node_modules/dsh-wtskin-project` and the matching patch row.

## Python runtime

The engine needs Python 3 with Pillow and numpy. DSH ships a suitable runtime:

```
C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
```

Resolution order: call argument `pythonPath` → plugin config `pythonPath` → env
`DSH_PYTHON` → `python`. Pinning it once in the plugin config is recommended:

```yaml
- id: dsh-wtskin-project
  name: dsh-wtskin-project
  config:
    pythonPath: C:/Users/you/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
```

## Output

```
out/
├── q_5l_c.png       composited texture (4096)
├── q_5l_c.dds       32-bit uncompressed DDS (~64MB)
├── preview.png      1600 preview
└── q_5l.blk         guide file
```

Copy the whole `out` folder into `War Thunder/UserSkins/`.

## How it works

1. **Base livery** — reads an existing texture as the detail carrier (rivets, panel lines),
   maps its luminance onto a custom colour ramp, optionally adds an edge glow and a dot grid.
2. **Layers** — an affine transform (rotate → scale → translate to the quad centre), then an
   alpha mask clipped to the quad; an optional half-plane clip along a line.
3. **Export** — Pillow writes a 32-bit uncompressed DDS (BGRA) and generates the `.blk`.

## Known limitations

- No automatic UV measurement: quads are measured by hand with the picker.
- DDS is uncompressed (~64MB at 4K); re-save as DXT5 with Photoshop + the NVIDIA DDS plugin
  if that is too heavy.
- Normal maps (`_n`) are not generated.

## License

MIT. Copyright of user assets (character art, etc.) remains with the user.
