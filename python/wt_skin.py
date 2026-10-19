#!/usr/bin/env python3
"""War Thunder skin engine — base livery, quad-anchored layers, DDS export.

Driven by a project JSON (see README). Every command reads/writes files under
the project directory; no game install is required.

Commands:
  export <project.json>   composite base + layers, write PNG/DDS/preview/blk
  info   <project.json>   print a summary of the project
"""

import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

# ---------------------------------------------------------------- helpers


def _load_image(path):
    im = Image.open(path)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
    return im.convert("RGBA")


def _palette_stops(palette):
    """palette: [[t, [r,g,b]], ...] sorted by t in 0..1."""
    return [(float(t), tuple(int(c) for c in rgb)) for t, rgb in palette]


def _apply_palette(lum, stops):
    t = np.clip(lum, 0.0, 1.0)
    out = np.zeros(t.shape + (3,), np.float32)
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        m = (t >= t0) & (t <= t1)
        if not m.any():
            continue
        f = ((t[m] - t0) / (t1 - t0))[..., None]
        out[m] = np.array(c0, np.float32) * (1 - f) + np.array(c1, np.float32) * f
    return out / 255.0


def build_base(width, height, cfg):
    """Create the base livery.

    cfg:
      source      path to a texture (dds/png/jpg) used as the detail carrier
      palette     [[t,[r,g,b]], ...]   luminance -> colour ramp
      contrast    multiplier for the detail (default 1.0)
      edgeGlow    cyan edge glow strength 0..255 (0 disables)
      edgeColor   [r,g,b]
      dots        bool, faint dot grid
      fill        [r,g,b] flat colour when no source is given
    """
    if cfg.get("source"):
        src = _load_image(os.path.expandvars(cfg["source"])).convert("RGB")
        if src.size != (width, height):
            src = src.resize((width, height), Image.LANCZOS)
        arr = np.asarray(src).astype(np.float32) / 255.0
        lum = arr.mean(axis=2)
        stops = _palette_stops(cfg.get("palette") or [
            [0.00, [3, 6, 16]],
            [0.22, [9, 17, 42]],
            [0.50, [20, 41, 90]],
            [0.76, [46, 90, 168]],
            [1.00, [140, 200, 255]],
        ])
        col = _apply_palette(lum, stops)
        contrast = float(cfg.get("contrast", 1.0))
        col = np.clip(col * (0.72 + 0.55 * lum[..., None] * contrast), 0, 1)
        img = Image.fromarray((col * 255).astype(np.uint8)).convert("RGBA")
    else:
        fill = cfg.get("fill") or [12, 24, 52]
        img = Image.new("RGBA", (width, height), tuple(fill) + (255,))

    glow = int(cfg.get("edgeGlow", 0))
    if glow > 0:
        lp = np.asarray(img.convert("L")).astype(np.float32)
        gx = np.zeros_like(lp)
        gy = np.zeros_like(lp)
        gx[:, 1:-1] = lp[:, 2:] - lp[:, :-2]
        gy[1:-1, :] = lp[2:, :] - lp[:-2, :]
        mag = np.sqrt(gx * gx + gy * gy) / 170.0
        alpha = (np.clip(mag, 0, 1) * glow).astype(np.uint8)
        ec = cfg.get("edgeColor") or [80, 210, 255]
        layer = np.zeros((height, width, 4), np.uint8)
        layer[..., 0], layer[..., 1], layer[..., 2] = ec[0], ec[1], ec[2]
        layer[..., 3] = alpha
        img = Image.alpha_composite(img, Image.fromarray(layer, "RGBA"))

    if cfg.get("dots"):
        grid = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        d = ImageDraw.Draw(grid)
        step = max(24, width // 40)
        for y in range(0, height, step):
            for x in range(0, width, step):
                d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(140, 230, 255, 22))
        img = Image.alpha_composite(img, grid)

    return img


def _quad_geometry(quad):
    pts = [(float(x), float(y)) for x, y in quad]
    le = ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
    te = ((pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2)
    chord = math.hypot(le[0] - te[0], le[1] - te[1])
    centre = ((le[0] + te[0]) / 2, (le[1] + te[1]) / 2)
    return pts, chord, centre, (le, te)


def _place(img, layer, width, height, scale=1.0):
    src = _load_image(os.path.expandvars(layer["image"]))
    quad = [[float(x)*scale, float(y)*scale] for x, y in layer["quad"]]
    pts, chord, centre, _ = _quad_geometry(quad)
    if layer.get("flip"):
        src = src.transpose(Image.FLIP_LEFT_RIGHT)
    if layer.get("rotate180"):
        src = src.transpose(Image.ROTATE_180)

    size_mode = layer.get("size", "chord")
    factor = float(layer.get("factor", 1.0))
    if size_mode == "chord":
        h = chord * factor
    elif size_mode == "height":
        h = float(layer["height"]) * factor
    elif size_mode == "quadHeight":
        ys = [p[1] for p in pts]
        h = (max(ys) - min(ys)) * factor
    elif size_mode == "widthAdapt":
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        h = min(bw / float(layer.get("aspect", 0.62)), bh * 0.9) * factor
    else:
        raise ValueError(f"unknown size mode {size_mode!r}")
    h = max(4, int(round(h)))
    src = src.resize((max(1, int(src.width * h / src.height)), h), Image.LANCZOS)

    dx, dy = layer.get("offset", [0, 0])
    cx = centre[0] + float(dx)
    cy = centre[1] + float(dy)
    x0 = int(round(cx - src.width / 2))
    y0 = int(round(cy - src.height / 2))

    # polygon mask (optionally expanded outward from its centroid)
    expand = float(layer.get("expand", 0))
    mask = Image.new("L", (width, height), 0)
    md = ImageDraw.Draw(mask)
    if expand:
        cxp = sum(p[0] for p in pts) / 4
        cyp = sum(p[1] for p in pts) / 4
        ep = []
        for px, py in pts:
            vx, vy = px - cxp, py - cyp
            ln = math.hypot(vx, vy) or 1
            ep.append((px + vx / ln * expand, py + vy / ln * expand))
    else:
        ep = pts
    md.polygon(ep, fill=255)

    crop = mask.crop((x0, y0, x0 + src.width, y0 + src.height))

    line = layer.get("clipLine")
    if line:
        ax, ay = float(line[0][0])*scale, float(line[0][1])*scale
        bx, by = float(line[1][0])*scale, float(line[1][1])*scale
        ddx, ddy = bx - ax, by - ay
        xs = np.arange(x0, x0 + src.width)
        ys = np.arange(y0, y0 + src.height)
        X, Y = np.meshgrid(xs, ys)
        cross = ddx * (Y - ay) - ddy * (X - ax)
        ref = ddx * (cy - ay) - ddy * (cx - ax)
        keep = (cross <= 0) if ref <= 0 else (cross >= 0)
        crop = ImageChops.multiply(crop, Image.fromarray((keep * 255).astype(np.uint8)))

    alpha = ImageChops.multiply(src.getchannel("A"), crop)
    if layer.get("opacity") is not None:
        alpha = alpha.point(lambda v: int(v * float(layer["opacity"])))
    src.putalpha(alpha)
    return src, (x0, y0)


def render(project_path):
    project_path = os.path.abspath(project_path)
    base_dir = os.path.dirname(project_path)

    def resolve(p):
        if not p:
            return p
        p = os.path.expandvars(p)
        return p if os.path.isabs(p) else os.path.normpath(os.path.join(base_dir, p))

    cfg = json.load(open(project_path, encoding="utf-8"))
    width = int(cfg.get("width", 4096))
    height = int(cfg.get("height", 4096))
    base = cfg.get("base") or {}
    base["source"] = resolve(base.get("source"))
    img = build_base(width, height, base)

    qscale = float(cfg.get("quadScale", 1))
    skipped = []
    for layer in cfg.get("layers", []):
        layer = dict(layer)
        if not layer.get("image"):
            skipped.append(layer.get("id"))
            continue
        layer["image"] = resolve(layer.get("image"))
        layer_scale = float(layer.get("quadScale", qscale))
        piece, pos = _place(img, layer, width, height, layer_scale)
        img.alpha_composite(piece, pos)

    out = cfg.get("output") or {}
    outdir = resolve(out.get("dir") or "out")
    os.makedirs(outdir, exist_ok=True)

    name = out.get("textureName") or "skin_c"
    png_path = os.path.join(outdir, name + ".png")
    img.convert("RGB").save(png_path)
    result = {"project": project_path, "width": width, "height": height,
              "png": png_path, "layers": len(cfg.get("layers", [])) - len(skipped),
              "skipped": [x for x in skipped if x]}

    if out.get("preview"):
        prev = img.convert("RGB")
        prev.thumbnail((1600, 1600), Image.LANCZOS)
        prev_path = os.path.join(outdir, "preview.png")
        prev.save(prev_path)
        result["preview"] = prev_path

    if out.get("dds"):
        dds_path = os.path.join(outdir, name + ".dds")
        img.convert("RGBA").save(dds_path)
        result["dds"] = dds_path

    if out.get("blk"):
        blk_path = os.path.join(outdir, out.get("blkName") or "skin.blk")
        entries = out.get("blkEntries") or []
        lines = ['name:t="user"', ""]
        for entry in entries:
            lines += ["replace_tex{", f'  from:t="{entry["from"]}"',
                      f'  to:t="{entry["to"]}"', "}", ""]
        open(blk_path, "w", encoding="utf-8").write("\n".join(lines))
        result["blk"] = blk_path

    return result


def main(argv):
    if len(argv) < 3:
        print("usage: wt_skin.py export|info <project.json>", file=sys.stderr)
        return 2
    cmd, project = argv[1], argv[2]
    if cmd == "export":
        print(json.dumps(render(project), ensure_ascii=False))
        return 0
    if cmd == "info":
        cfg = json.load(open(project, encoding="utf-8"))
        print(json.dumps({
            "name": cfg.get("name"), "width": cfg.get("width"),
            "height": cfg.get("height"), "layers": len(cfg.get("layers", [])),
            "base": cfg.get("base", {}).get("source"),
        }, ensure_ascii=False))
        return 0
    print(f"unknown command {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
