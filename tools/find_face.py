"""Locate the UV island around a seed point and fit a polygon / rotated box.

Method: Sobel edge barrier + edge-bounded flood fill + convex hull + rotating
calipers minimum-area rectangle. Coordinates are returned in canvas pixels
(texture pixels * canvas/texture ratio).
"""
import sys, json, math
import numpy as np
from PIL import Image
from collections import deque


def sobel(gray):
    gx = np.zeros_like(gray, dtype=np.float32)
    gy = np.zeros_like(gray, dtype=np.float32)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    return np.hypot(gx, gy)


def flood(bright, barrier, seed, cap):
    h, w = bright.shape
    sx, sy = seed
    if not (0 <= sx < w and 0 <= sy < h) or barrier[sy, sx]:
        return None
    seen = np.zeros((h, w), dtype=bool)
    q = deque([(sy, sx)])
    seen[sy, sx] = True
    pts = []
    while q and len(pts) < cap:
        y, x = q.popleft()
        pts.append((x, y))
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and not barrier[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return pts


def convex_hull(points):
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts
    def cross(o, a, b):
        return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def min_area_rect(hull):
    best = None
    n = len(hull)
    for i in range(n):
        x1, y1 = hull[i]
        x2, y2 = hull[(i+1) % n]
        ex, ey = x2-x1, y2-y1
        ln = math.hypot(ex, ey) or 1
        ux, uy = ex/ln, ey/ln
        vx, vy = -uy, ux
        us = [p[0]*ux + p[1]*uy for p in hull]
        vs = [p[0]*vx + p[1]*vy for p in hull]
        u0, u1 = min(us), max(us)
        v0, v1 = min(vs), max(vs)
        area = (u1-u0)*(v1-v0)
        if best is None or area < best[0]:
            corners = []
            for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1)):
                corners.append((u*ux + v*vx, u*uy + v*vy))
            best = (area, corners)
    return best


def main():
    texture, seed_x, seed_y, canvas = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    im = Image.open(texture).convert('RGB')
    W, H = im.size
    gray = np.asarray(im.convert('L')).astype(np.float32)
    grad = sobel(gray)
    barrier = grad > 14.0
    sx, sy = int(seed_x * W / canvas), int(seed_y * H / canvas)
    # nudge to a bright pixel if the seed landed on a dark line
    bright = np.asarray(im.convert('L')).astype(np.int16) > 120
    if barrier[sy, sx] or not bright[sy, sx]:
        best = None
        for rad in range(1, 60):
            for dy in range(-rad, rad+1):
                for dx in range(-rad, rad+1):
                    ny, nx = sy+dy, sx+dx
                    if 0 <= ny < H and 0 <= nx < W and bright[ny, nx] and not barrier[ny, nx]:
                        best = (nx, ny)
                        break
                if best: break
            if best: break
        if best: sx, sy = best
    pts = flood(bright, barrier, (sx, sy), 2_000_000)
    if not pts:
        print(json.dumps({'error': 'no region from seed', 'seed': [sx, sy]}))
        return
    hull = convex_hull(pts)
    area, corners = min_area_rect(hull)
    k = canvas / W
    corners = [[round(x * k), round(y * k)] for x, y in corners]
    xs = [p[0] for p in corners]; ys = [p[1] for p in corners]
    print(json.dumps({
        'texture': [W, H], 'canvas': canvas, 'seed_px': [sx, sy],
        'island_px': len(pts),
        'rect_canvas': corners,
        'bbox_canvas': [min(xs), min(ys), max(xs)-min(xs), max(ys)-min(ys)],
        'aspect': round(math.dist(corners[0], corners[1]) / max(1, math.dist(corners[1], corners[2])), 2),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
