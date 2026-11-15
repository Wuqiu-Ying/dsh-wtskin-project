#!/usr/bin/env python3
"""War Thunder skin engine (v2).

Driven by a project JSON. Coordinates in the project are FINAL texture pixels —
there is no scale factor anywhere in this file. That is the fix for v1's
double-scaled quads.

Commands:
  export <project.json>   composite base + layers, write PNG / DDS / preview /
                          debug overlay / normal map / blk, and print a report
  info   <project.json>   print a summary of the project
"""

import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

# ---------------------------------------------------------------- helpers


class ProjectError(Exception):
    """A project the engine refuses to render; the problems travel to the caller."""

    def __init__(self, problems):
        super().__init__("project has problems")
        self.problems = problems


def _load_image(path):
    im = Image.open(path)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
    return im.convert("RGBA")


def _palette_stops(palette):
    """palette: [[t, [r,g,b]], ...]; sorts and pins the ends to 0 and 1."""
    stops = [(float(t), tuple(int(c) for c in rgb)) for t, rgb in palette]
    stops.sort(key=lambda s: s[0])
    if not stops:
        stops = [(0.0, (0, 0, 0)), (1.0, (255, 255, 255))]
    return stops


def _apply_palette(lum, stops):
    """Map luminance to colour with linear interpolation.

    np.interp clamps outside the stop range, so a palette that does not cover
    0..1 no longer produces black bands (the v1 bug).
    """
    t = np.clip(lum, 0.0, 1.0)
    ts = np.array([s[0] for s in stops], np.float32)
    cols = np.array([s[1] for s in stops], np.float32)
    out = np.empty(t.shape + (3,), np.float32)
    for channel in range(3):
        out[..., channel] = np.interp(t, ts, cols[:, channel])
    return out / 255.0


def build_base(width, height, cfg):
    """Create the base livery (detail carrier recoloured through a palette)."""
    if cfg.get("source"):
        src = _load_image(os.path.expandvars(str(cfg["source"]))).convert("RGB")
        if src.size != (width, height):
            src = src.resize((width, height), Image.LANCZOS)
        arr = np.asarray(src).astype(np.float32) / 255.0
        lum = arr.mean(axis=2)
        col = _apply_palette(lum, _palette_stops(cfg.get("palette") or []))
        contrast = float(cfg.get("contrast", 1.0))
        col = np.clip(col * (0.72 + 0.55 * lum[..., None] * contrast), 0, 1)
        img = Image.fromarray((col * 255).astype(np.uint8)).convert("RGBA")
    else:
        fill = cfg.get("fill") or [12, 24, 52]
        img = Image.new("RGBA", (width, height), tuple(fill) + (255,))

    glow = int(cfg.get("edgeGlow", 0) or 0)
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


# ---------------------------------------------------------------- geometry


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _segments_cross(p1, p2, p3, p4):
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2 = orient(p3, p4, p1), orient(p3, p4, p2)
    d3, d4 = orient(p1, p2, p3), orient(p1, p2, p4)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def validate_polygon(points):
    """Check a 3+ point polygon without reordering it.

    Four-point panels keep the chord semantics (0-1 and 2-3 are the opposite
    edges). Larger polygons exist for triangular or irregular wings, where the
    chord is approximated by the bounding-box height.
    """
    pts = [(float(x), float(y)) for x, y in points]
    n = len(pts)
    if n < 3:
        raise ValueError("polygon needs at least 3 points")
    warnings = []
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        if math.hypot(b[0] - a[0], b[1] - a[1]) < 1:
            warnings.append(f"edge {i + 1}-{i + 2} has zero length")
    # Self-intersection: non-adjacent edges must not cross.
    for i in range(n):
        a1, a2 = pts[i], pts[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            b1, b2 = pts[j], pts[(j + 1) % n]
            if _segments_cross(a1, a2, b1, b2):
                warnings.append(f"edges {i + 1}-{i + 2} and {j + 1}-{j + 2} cross: the points are not in perimeter order")
    if n == 4:
        v01 = (pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
        v23 = (pts[3][0] - pts[2][0], pts[3][1] - pts[2][1])
        n01 = math.hypot(*v01) or 1
        n23 = math.hypot(*v23) or 1
        cos = (v01[0] * v23[0] + v01[1] * v23[1]) / (n01 * n23)
        if abs(cos) < 0.82:
            warnings.append("edges 1-2 and 3-4 are not parallel: points 3-4 are probably not the opposite edge")
    return pts, warnings


def polygon_geometry(pts):
    """Chord, centre and the two chord-edge midpoints."""
    if len(pts) == 4:
        return quad_geometry(pts)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    centre = (sum(xs) / len(pts), sum(ys) / len(pts))
    chord = max(ys) - min(ys)
    return chord, centre, None, None


def quad_geometry(pts):
    le = ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
    te = ((pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2)
    chord = math.hypot(le[0] - te[0], le[1] - te[1])
    centre = ((le[0] + te[0]) / 2, (le[1] + te[1]) / 2)
    return chord, centre, le, te


def _place(layer, width, height):
    """Composite one layer; returns (piece, position, stats)."""
    src = _load_image(os.path.expandvars(str(layer["image"])))
    pts, warnings = validate_polygon(layer["quad"])
    chord, centre, le, te = polygon_geometry(pts)

    if layer.get("flip"):
        src = src.transpose(Image.FLIP_LEFT_RIGHT)
    if layer.get("rotate180"):
        src = src.transpose(Image.ROTATE_180)

    size_mode = layer.get("size", "chord")
    factor = float(layer.get("factor", 1.0))

    if size_mode == "crop":
        # Pass-through: the image is a source texture and the quad selects the
        # region to copy 1:1 (no scaling). This keeps the original artwork at
        # its native resolution instead of shrinking a whole texture into the
        # face, which is what "chord" would do.
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bx0 = int(round(min(xs)))
        by0 = int(round(min(ys)))
        bw = max(4, int(round(max(xs) - min(xs))))
        bh = max(4, int(round(max(ys) - min(ys))))
        left = max(0, min(bx0, src.width - 1))
        top = max(0, min(by0, src.height - 1))
        box_w = min(bw, src.width - left)
        box_h = min(bh, src.height - top)
        src = src.crop((left, top, left + box_w, top + box_h)).resize((bw, bh), Image.LANCZOS)
        x0, y0 = bx0, by0
        target = src.height
    elif size_mode == "cover":
        # Fill the quad's bounding box: scale to cover, crop the overflow.
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bw = max(4, int(round(max(xs) - min(xs))))
        bh = max(4, int(round(max(ys) - min(ys))))
        scale = max(bw / src.width, bh / src.height)
        src = src.resize((max(1, int(round(src.width * scale))), max(1, int(round(src.height * scale)))), Image.LANCZOS)
        x0 = int(round((min(xs) + max(xs)) / 2 - src.width / 2))
        y0 = int(round((min(ys) + max(ys)) / 2 - src.height / 2))
        target = src.height
    else:
        if size_mode == "chord":
            target = chord * factor
        elif size_mode == "height":
            target = float(layer["height"]) * factor
        elif size_mode == "quadHeight":
            ys = [p[1] for p in pts]
            target = (max(ys) - min(ys)) * factor
        elif size_mode == "widthAdapt":
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            bw = max(xs) - min(xs)
            bh = max(ys) - min(ys)
            target = min(bw / float(layer.get("aspect", 0.62)), bh * 0.9) * factor
        else:
            raise ValueError(f"unknown size mode {size_mode!r}")

        target = max(4, int(round(target)))
        src = src.resize((max(1, int(round(src.width * target / src.height))), target), Image.LANCZOS)

        dx, dy = layer.get("offset", [0, 0])
        cx = centre[0] + float(dx)
        cy = centre[1] + float(dy)
        x0 = int(round(cx - src.width / 2))
        y0 = int(round(cy - src.height / 2))

    mask = Image.new("L", (width, height), 0)
    md = ImageDraw.Draw(mask)
    expand = float(layer.get("expand", 0) or 0)
    if expand:
        px = sum(p[0] for p in pts) / 4
        py = sum(p[1] for p in pts) / 4
        ep = []
        for x, y in pts:
            vx, vy = x - px, y - py
            ln = math.hypot(vx, vy) or 1
            ep.append((x + vx / ln * expand, y + vy / ln * expand))
    else:
        ep = pts
    md.polygon(ep, fill=255)

    crop = mask.crop((x0, y0, x0 + src.width, y0 + src.height))

    line = layer.get("clipLine")
    if line:
        ax, ay = float(line[0][0]), float(line[0][1])
        bx, by = float(line[1][0]), float(line[1][1])
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

    coverage = int((np.asarray(alpha) > 8).sum())
    stats = {
        "id": layer.get("id"),
        "chord": round(chord, 2),
        "targetHeight": target,
        "box": [x0, y0, src.width, src.height],
        "coveredPx": coverage,
        "warnings": warnings,
    }
    return src, (x0, y0), stats


# ---------------------------------------------------------------- normal map


def build_normal(img, strength):
    """Approximate tangent-space normal map from the composited luminance.

    This is a height-from-luminance guess, not authored geometry: it adds
    rivet/panel relief and keeps the file valid, but it cannot invent real
    surface detail that the source art does not have.
    """
    gray = img.convert("L").filter(ImageFilter.GaussianBlur(2))
    h = np.asarray(gray, np.float32) / 255.0
    dy, dx = np.gradient(h)
    scale = float(strength) * 12.0
    nx = -dx * scale
    ny = -dy * scale
    nz = np.ones_like(h)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / length, ny / length, nz / length
    rgb = np.stack([(nx * 0.5 + 0.5), (ny * 0.5 + 0.5), (nz * 0.5 + 0.5)], axis=-1) * 255.0
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


# ---------------------------------------------------------------- render


def render(project_path):
    project_path = os.path.abspath(project_path)
    base_dir = os.path.dirname(project_path)

    def resolve(p):
        if not p:
            return p
        p = os.path.expandvars(str(p))
        return p if os.path.isabs(p) else os.path.normpath(os.path.join(base_dir, p))

    with open(project_path, encoding="utf-8") as fh:
        cfg = json.load(fh)

    width = int(cfg.get("width", 4096))
    height = int(cfg.get("height", 4096))
    base_cfg = dict(cfg.get("base") or {})
    if base_cfg.get("source"):
        base_cfg["source"] = resolve(base_cfg["source"])
    img = build_base(width, height, base_cfg)

    out = cfg.get("output") or {}
    outdir = resolve(out.get("dir") or "out")
    name = out.get("textureName") or "skin_c"

    # Coverage is counted on a 1/8 grid: enough to report overlap, cheap at 4K.
    cov_w, cov_h = max(1, width // 8), max(1, height // 8)
    coverage = np.zeros((cov_h, cov_w), np.uint16)

    layers = cfg.get("layers") or []
    stats = []
    problems = []
    for index, raw_layer in enumerate(layers):
        layer = dict(raw_layer)
        label = layer.get("id") or f"#{index + 1}"
        if not layer.get("image"):
            problems.append(f"layer {label}: image is empty")
            continue
        layer["image"] = resolve(layer["image"])
        if not os.path.exists(layer["image"]):
            problems.append(f"layer {label}: image not found: {layer['image']}")
            continue
        try:
            piece, pos, info = _place(layer, width, height)
        except Exception as error:  # noqa: BLE001 - reported to the caller
            problems.append(f"layer {label}: {error}")
            continue
        img.alpha_composite(piece, pos)
        small = piece.getchannel("A").resize((cov_w, cov_h), Image.BILINEAR)
        coverage += (np.asarray(small) > 8).astype(np.uint16)
        stats.append(info)

    if problems:
        raise ProjectError(problems)

    os.makedirs(outdir, exist_ok=True)
    png_path = os.path.join(outdir, name + ".png")
    img.convert("RGB").save(png_path)

    result = {
        "project": project_path,
        "width": width,
        "height": height,
        "png": png_path,
        "layers": len(stats),
        "report": {
            "layers": stats,
            "paintedPx": int((coverage > 0).sum()) * 64,
            "overlapPx": int((coverage > 1).sum()) * 64,
        },
    }

    if out.get("preview", True):
        prev = img.convert("RGB")
        prev.thumbnail((1600, 1600), Image.LANCZOS)
        prev_path = os.path.join(outdir, "preview.png")
        prev.save(prev_path)
        result["preview"] = prev_path

        overlay = prev.copy()
        draw = ImageDraw.Draw(overlay)
        scale = overlay.width / float(width)
        for layer in layers:
            pts = layer.get("quad")
            if not pts:
                continue
            poly = [(p[0] * scale, p[1] * scale) for p in pts]
            draw.line(poly + [poly[0]], fill=(34, 211, 238), width=2)
            for i, (x, y) in enumerate(poly):
                draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(245, 158, 11))
                draw.text((x + 5, y - 12), f"{layer.get('id', '?')}·{i + 1}", fill=(255, 255, 255))
        debug_path = os.path.join(outdir, "_preview_quads.png")
        overlay.save(debug_path)
        result["debugPreview"] = debug_path

    if out.get("dds", True):
        dds_path = os.path.join(outdir, name + ".dds")
        img.convert("RGBA").save(dds_path)
        result["dds"] = dds_path

    normal_cfg = out.get("normal") or {}
    if normal_cfg.get("enabled"):
        normal = build_normal(img.convert("RGB"), normal_cfg.get("strength", 3))
        normal_png = os.path.join(outdir, name + "_n.png")
        normal.save(normal_png)
        result["normalPng"] = normal_png
        if out.get("dds", True):
            normal_dds = os.path.join(outdir, name + "_n.dds")
            normal.convert("RGBA").save(normal_dds)
            result["normalDds"] = normal_dds

    if out.get("blk", True):
        blk_path = os.path.join(outdir, out.get("blkName") or "skin.blk")
        entries = [dict(e) for e in (out.get("blkEntries") or [])]
        if normal_cfg.get("enabled"):
            wanted = f"{name}_n.dds"
            if not any(str(e.get("to", "")).endswith("_n.dds") for e in entries):
                entries.append({"from": f"{name}_n*", "to": wanted})
        lines = ['name:t="user"', ""]
        for entry in entries:
            lines += ["replace_tex{", f'  from:t="{entry["from"]}"', f'  to:t="{entry["to"]}"', "}", ""]
        with open(blk_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
        result["blk"] = blk_path

    return result


def main(argv):
    if len(argv) < 3:
        print("usage: wt_skin.py export|info <project.json> [--out <result.json>]", file=sys.stderr)
        return 2

    cmd, project = argv[1], argv[2]
    out_path = None
    if len(argv) >= 5 and argv[3] == "--out":
        out_path = argv[4]

    status = 0
    try:
        if cmd == "export":
            payload = render(project)
        elif cmd == "info":
            with open(project, encoding="utf-8") as fh:
                cfg = json.load(fh)
            payload = {
                "name": cfg.get("name"),
                "version": cfg.get("version"),
                "width": cfg.get("width"),
                "height": cfg.get("height"),
                "layers": len(cfg.get("layers", [])),
                "base": (cfg.get("base") or {}).get("source"),
            }
        else:
            payload = {"error": f"unknown command {cmd!r}"}
            status = 2
    except ProjectError as error:
        payload = {"error": str(error), "problems": error.problems}
        status = 1
    except Exception as error:  # noqa: BLE001 - the message is the diagnosis
        payload = {"error": f"{type(error).__name__}: {error}"}
        status = 1

    text = json.dumps(payload, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        print(text)
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
