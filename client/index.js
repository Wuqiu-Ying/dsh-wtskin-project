/**
 * Client half: the floating polygon picker.
 *
 * Interaction model:
 *   left click empty image   add a point
 *   drag a point             move it (cursor = four-way arrow)
 *   right click a point      delete it
 *   wheel                    zoom the view around the cursor
 *   middle drag              pan the view
 *   click a saved face       enter its edit mode (its points reappear)
 *
 * Faces are 3..64 point polygons. Edges carry their own colours and names;
 * a saved face keeps its outline but hides its points until edited again.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wtskin-project',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ID = 'dsh-wtskin-project/picker';
    const KIND = 'wtskin-picker';
    let api = null;

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8eef8)',
      muted: 'var(--dsw-alias-label-secondary, #93a4bd)',
      border: 'var(--dsw-alias-border-l1, rgba(148,163,184,.22))',
      panel: 'var(--dsw-alias-bg-layer-1, #0f1a2d)',
      panel2: 'var(--dsw-alias-bg-layer-2, #142138)',
      brand: 'var(--dsw-alias-brand-primary, #22d3ee)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      bad: 'var(--dsw-alias-state-error-primary, #ef4444)',
    };

    const EDGE_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#60a5fa', '#fbbf24', '#fb7185'];
    const FACE_COLORS = ['#0ea5e9', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#ec4899'];
    const DEFAULT_EDGE_NAMES = ['机翼前缘', '机身侧', '翼尖侧', '机翼后缘'];

    const edgeColor = (i) => EDGE_COLORS[i % EDGE_COLORS.length];
    const edgeName = (names, i) => names[i] || DEFAULT_EDGE_NAMES[i] || `边 ${i + 1}`;

    const sessionId = () => {
      try {
        const mounted = api.sidebarRight.mounted;
        const value = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : null;
        return typeof value === 'string' ? value : (value && (value.session || value.id)) || null;
      } catch {
        return null;
      }
    };

    /** Remote calls answer {ok, value}; reading the wrapper as the payload was
     *  why the panel saw no projects and the marker read back as 0. */
    const unwrap = (answered) => {
      if (answered && typeof answered === 'object' && 'ok' in answered) {
        if (!answered.ok) throw new Error(answered.error?.message || answered.error?.code || 'remote call failed');
        return answered.value;
      }
      return answered;
    };

    const listDirs = async (sid, dir) => {
      const listing = unwrap(await api.remote.workspaceFiles.list(sid, dir, new AbortController().signal));
      return (listing.entries || []).filter((entry) => entry.type === 'directory').map((entry) => `${dir}/${entry.name}`);
    };

    const readProject = async (sid, dir) => {
      const file = unwrap(await api.remote.workspaceFiles.read(sid, `${dir}/project.json`, {}, new AbortController().signal));
      return JSON.parse(file.text);
    };

    /**
     * War Thunder copies texture previews as TGA, which <img> cannot decode.
     * Handles uncompressed and RLE true-colour (24/32 bit) and grayscale.
     */
    function decodeTga(buffer) {
      const view = new DataView(buffer);
      const u8 = new Uint8Array(buffer);
      const idLength = view.getUint8(0);
      const colorMapType = view.getUint8(1);
      const imageType = view.getUint8(2);
      if (colorMapType !== 0) throw new Error('TGA 调色板格式暂不支持');
      const width = view.getUint16(12, true);
      const height = view.getUint16(14, true);
      const bpp = view.getUint8(16);
      const descriptor = view.getUint8(17);
      if (!width || !height) throw new Error('TGA 尺寸无效');
      const bytesPerPixel = bpp / 8;
      if (![1, 3, 4].includes(bytesPerPixel)) throw new Error(`TGA 位深不支持：${bpp}`);
      const topOrigin = (descriptor & 0x20) !== 0;
      const out = new Uint8ClampedArray(width * height * 4);
      let p = 18 + idLength;

      const put = (index, r, g, b, a) => {
        const x = index % width;
        const y = Math.floor(index / width);
        const row = topOrigin ? y : height - 1 - y;
        const dst = (row * width + x) * 4;
        out[dst] = r; out[dst + 1] = g; out[dst + 2] = b; out[dst + 3] = a;
      };
      const readPixel = () => {
        let r = 0; let g = 0; let b = 0; let a = 255;
        if (bytesPerPixel === 4) { b = u8[p]; g = u8[p + 1]; r = u8[p + 2]; a = u8[p + 3]; }
        else if (bytesPerPixel === 3) { b = u8[p]; g = u8[p + 1]; r = u8[p + 2]; }
        else { r = g = b = u8[p]; }
        p += bytesPerPixel;
        return [r, g, b, a];
      };

      const total = width * height;
      let i = 0;
      if (imageType === 2 || imageType === 3) {
        while (i < total) { const [r, g, b, a] = readPixel(); put(i++, r, g, b, a); }
      } else if (imageType === 10 || imageType === 11) {
        while (i < total) {
          const header = u8[p];
          p += 1;
          const count = (header & 0x7f) + 1;
          if (header & 0x80) {
            const [r, g, b, a] = readPixel();
            for (let n = 0; n < count && i < total; n += 1) put(i++, r, g, b, a);
          } else {
            for (let n = 0; n < count && i < total; n += 1) {
              const [r, g, b, a] = readPixel();
              put(i++, r, g, b, a);
            }
          }
        }
      } else {
        throw new Error(`TGA 类型不支持：${imageType}`);
      }
      return { width, height, data: out };
    }

    const isImageFile = (file) => {
      const type = String((file && file.type) || '');
      const name = String((file && file.name) || '');
      return type.startsWith('image/') || /\.tga$/i.test(name) || /tga/i.test(type);
    };

    const btn = (primary) => ({
      height: '28px',
      padding: '0 10px',
      borderRadius: '6px',
      border: `1px solid ${primary ? C.brand : C.border}`,
      background: primary ? C.brand : 'transparent',
      color: primary ? '#04121f' : C.text,
      font: '12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
      cursor: 'pointer',
    });

    function Panel() {
      const [sid, setSid] = React.useState(sessionId);
      const [projects, setProjects] = React.useState([]);
      const [dir, setDir] = React.useState('');
      const [project, setProject] = React.useState(null);
      const [image, setImage] = React.useState(null);
      const [view, setView] = React.useState({ scale: 1, tx: 0, ty: 0 });
      const [points, setPoints] = React.useState([]);
      const [names, setNames] = React.useState([]);
      const [editing, setEditing] = React.useState(null); // { id, color } | null
      const [faceName, setFaceName] = React.useState('face_1');
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [renaming, setRenaming] = React.useState(-1);

      const frameRef = React.useRef(null);
      const innerRef = React.useRef(null);
      const urlRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const movedRef = React.useRef(false);

      const layers = (project && project.layers) || [];
      const faceColorOf = (layer, index) => layer.color || FACE_COLORS[index % FACE_COLORS.length];

      const load = React.useCallback(async (preferred) => {
        const id = sessionId();
        setSid(id);
        if (!id) { setStatus('没有选中的会话'); return; }
        try {
          const dirs = await listDirs(id, 'WTSP');
          setProjects(dirs);
          const next = preferred || dirs[0] || '';
          setDir(next);
          if (!next) { setProject(null); setStatus('WTSP 里还没有工程，先让模型建档'); return; }
          setProject(await readProject(id, next));
          setStatus('');
        } catch (error) {
          const message = String((error && error.message) || error);
          setStatus(message.includes('not-found') ? 'WTSP 里还没有工程，先让模型建档' : `读取失败：${message}`);
        }
      }, [dir]);

      React.useEffect(() => { load(); }, [load]);
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          const id = sessionId();
          if (id !== sid) { setSid(id); load(); }
        }, 2000);
        return () => window.clearInterval(timer);
      }, [sid, load]);

      // ---- view ------------------------------------------------------------
      const fitView = React.useCallback(() => {
        const frame = frameRef.current;
        if (!frame || !image) return;
        const scale = Math.min(frame.clientWidth / image.w, frame.clientHeight / image.h, 1);
        setView({
          scale,
          tx: (frame.clientWidth - image.w * scale) / 2,
          ty: (frame.clientHeight - image.h * scale) / 2,
        });
      }, [image]);

      React.useEffect(() => { fitView(); }, [fitView]);

      React.useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return () => {};
        const onWheel = (event) => {
          if (!image) return;
          event.preventDefault();
          const rect = frame.getBoundingClientRect();
          const cx = event.clientX - rect.left;
          const cy = event.clientY - rect.top;
          setView((v) => {
            const next = Math.min(12, Math.max(0.05, v.scale * (event.deltaY < 0 ? 1.12 : 0.89)));
            const k = next / v.scale;
            return { scale: next, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
          });
        };
        frame.addEventListener('wheel', onWheel, { passive: false });
        return () => frame.removeEventListener('wheel', onWheel);
      }, [image]);

      const toImage = (event) => {
        const inner = innerRef.current;
        if (!inner) return null;
        const rect = inner.getBoundingClientRect();
        const x = (event.clientX - rect.left) / view.scale;
        const y = (event.clientY - rect.top) / view.scale;
        if (!image || x < 0 || y < 0 || x > image.w || y > image.h) return null;
        return { x, y };
      };

      const onFramePointerDown = (event) => {
        if (event.button === 1) {
          event.preventDefault();
          dragRef.current = { type: 'pan', startX: event.clientX, startY: event.clientY, tx: view.tx, ty: view.ty };
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        }
      };

      const onFramePointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.type !== 'pan') return;
        setView((v) => ({ ...v, tx: drag.tx + (event.clientX - drag.startX), ty: drag.ty + (event.clientY - drag.startY) }));
      };

      const onFramePointerUp = () => { dragRef.current = null; };

      const startPointDrag = (index) => (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        movedRef.current = false;
        dragRef.current = { type: 'point', index };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      };

      const onPointPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.type !== 'point') return;
        const p = toImage(event);
        if (!p) return;
        movedRef.current = true;
        setPoints((list) => list.map((old, i) => (i === drag.index ? p : old)));
      };

      const onPointPointerUp = (event) => {
        if (dragRef.current && dragRef.current.type === 'point') {
          event.stopPropagation();
          dragRef.current = null;
        }
      };

      const addPoint = (event) => {
        if (dragRef.current) return;
        const p = toImage(event);
        if (!p) return;
        setPoints((list) => [...list, p]);
        setNames((list) => (list.length >= points.length + 1 ? list : [...list, edgeName(list, points.length)]));
        setStatus('');
      };

      const removePoint = (index) => (event) => {
        event.preventDefault();
        event.stopPropagation();
        setPoints((list) => list.filter((_, i) => i !== index));
        setNames((list) => list.filter((_, i) => i !== index));
      };

      // ---- faces -----------------------------------------------------------
      const startNewFace = () => {
        setEditing(null);
        setPoints([]);
        setNames([]);
        setFaceName(`face_${layers.length + 1}`);
        setStatus('');
      };

      const editFace = (layer, index) => {
        if (!layer) return;
        const quad = (layer.quad || []).map(([x, y]) => ({ x: Number(x), y: Number(y) }));
        setEditing({ id: layer.id, color: faceColorOf(layer, index) });
        setPoints(quad);
        setNames(Array.isArray(layer.edgeNames) ? layer.edgeNames.slice() : []);
        setFaceName(layer.id);
        setStatus(`编辑 ${layer.id}`);
      };

      const save = async () => {
        const id = sessionId();
        if (!id || !dir || !project) return;
        if (points.length < 3) { setStatus('至少需要 3 个点'); return; }
        const name = (faceName.trim() || 'face_1');
        const quad = points.map((p) => [Math.round(p.x), Math.round(p.y)]);
        const color = editing?.color || FACE_COLORS[layers.length % FACE_COLORS.length];
        const edgeNames = quad.map((_, i) => edgeName(names, i));
        setBusy(true);
        try {
          const line = `/wtskin-save ${JSON.stringify({
            dir,
            faces: [{ id: name, quad, size: quad.length === 4 ? 'chord' : 'quadHeight', color, edgeNames }],
          })}`;
          const out = await api.remote.commands.execute(id, line, []);
          const result = out && out.result;
          if (!result || result.kind !== 'success') throw new Error((result && result.text) || '保存失败');
          const info = JSON.parse(result.text);
          setStatus(`已保存 ${info.saved.join(', ')}（共 ${info.layers} 个面）`);
          setEditing(null);
          setPoints([]);
          setNames([]);
          await load(dir);
        } catch (error) {
          setStatus(`保存失败：${String((error && error.message) || error)}`);
        } finally {
          setBusy(false);
        }
      };

      // ---- image -----------------------------------------------------------
      const pickImage = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,.tga';
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (file) useImage(file);
        });
        input.click();
      };

      const applyImage = (url, w, hgt) => {
        if (urlRef.current && urlRef.current.startsWith('blob:')) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setImage({ url, w, h: hgt });
        setPoints([]);
        setNames([]);
        setEditing(null);
        setStatus(`预览 ${w}×${hgt}，缩放 ×${(project ? project.width / w : 1).toFixed(2)}`);
      };

      const useImage = async (file) => {
        if (!file) return;
        if (!isImageFile(file)) { setStatus(`不支持的文件类型：${file.type || file.name || '未知'}`); return; }
        const name = String(file.name || '');
        try {
          if (/\.tga$/i.test(name) || /tga/i.test(String(file.type || ''))) {
            const decoded = decodeTga(await file.arrayBuffer());
            const canvas = document.createElement('canvas');
            canvas.width = decoded.width;
            canvas.height = decoded.height;
            canvas.getContext('2d').putImageData(new ImageData(decoded.data, decoded.width, decoded.height), 0, 0);
            applyImage(canvas.toDataURL('image/png'), decoded.width, decoded.height);
            setStatus(`TGA 已解码 ${decoded.width}×${decoded.height}`);
            return;
          }
          const url = URL.createObjectURL(file);
          const probe = new Image();
          probe.onload = () => applyImage(url, probe.naturalWidth, probe.naturalHeight);
          probe.onerror = () => { URL.revokeObjectURL(url); setStatus(`图片解码失败：${name}`); };
          probe.src = url;
        } catch (error) {
          setStatus(`读取失败：${String((error && error.message) || error)}`);
        }
      };

      const onPaste = (event) => {
        const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
        const item = items.find((entry) => entry.type.startsWith('image/') || /tga/i.test(entry.type));
        if (!item) return;
        const file = item.getAsFile();
        if (!file) return;
        event.preventDefault();
        useImage(file);
      };

      const onDrop = (event) => {
        const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
        const file = files.find((entry) => isImageFile(entry));
        if (!file) return;
        event.preventDefault();
        useImage(file);
      };

      // ---- render ----------------------------------------------------------
      const nameOf = (i) => edgeName(names, i);
      const pointR = 6 / view.scale;
      const stroke = 2 / view.scale;

      const facePolys = layers.map((layer, index) => ({
        id: layer.id,
        index,
        color: faceColorOf(layer, index),
        points: (layer.quad || []).map(([x, y]) => ({ x: Number(x), y: Number(y) })),
        active: editing ? editing.id === layer.id : false,
      }));

      return h('div', {
        onPaste, onDrop, onDragOver: (event) => event.preventDefault(), tabIndex: 0,
        style: { padding: '10px 12px', color: C.text, font: '12.5px "Segoe UI","Microsoft YaHei",system-ui,sans-serif', outline: 'none' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          h('strong', { style: { fontSize: '13px' } }, '涂装取点'),
          h('span', { style: { color: C.muted, fontSize: '11px' } }, editing ? `编辑 ${editing.id}` : '新建面'),
          h('button', { type: 'button', onClick: () => load(dir), style: { ...btn(false), marginLeft: 'auto' } }, '刷新'),
        ),

        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' } },
          h('select', {
            value: dir,
            onChange: (event) => load(event.target.value),
            style: { flex: 1, minWidth: 0, height: '28px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.panel2, color: C.text, font: 'inherit' },
          },
            projects.length === 0 ? h('option', { value: '' }, '还没有工程') : null,
            ...projects.map((item) => h('option', { key: item, value: item }, item.replace(/^WTSP\//, ''))),
          ),
          project ? h('span', { key: 'size', style: { color: C.muted } }, `${project.width}×${project.height}`) : null,
        ),

        project ? h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: pickImage, style: btn(false) }, image ? '换图片' : '选择图片'),
          h('button', { type: 'button', onClick: startNewFace, style: btn(false) }, '新建面'),
          h('button', { type: 'button', onClick: () => { setPoints([]); setNames([]); setStatus(''); }, style: btn(false) }, '清空点'),
          h('span', { style: { marginLeft: 'auto', color: C.muted, alignSelf: 'center' } }, `${points.length} 点`),
        ) : null,

        image && project
          ? h('div', {
            ref: frameRef,
            onPointerDown: onFramePointerDown,
            onPointerMove: onFramePointerMove,
            onPointerUp: onFramePointerUp,
            onPointerCancel: onFramePointerUp,
            onContextMenu: (event) => event.preventDefault(),
            style: {
              position: 'relative', overflow: 'hidden', height: '340px', marginBottom: '6px',
              border: `1px solid ${C.border}`, borderRadius: '8px', background: '#0b1526',
            },
          },
            h('div', {
              ref: innerRef,
              style: {
                position: 'absolute', left: 0, top: 0, width: image.w, height: image.h,
                transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
              },
            },
              h('img', {
                src: image.url, alt: '贴图预览', draggable: false,
                onClick: addPoint,
                onContextMenu: (event) => event.preventDefault(),
                style: { display: 'block', width: image.w, height: image.h, userSelect: 'none' },
              }),
              h('svg', {
                viewBox: `0 0 ${image.w} ${image.h}`, width: image.w, height: image.h,
                style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' },
              },
                ...facePolys.map((face) => h('polygon', {
                  key: `f-${face.id}`,
                  points: face.points.map((p) => `${p.x},${p.y}`).join(' '),
                  fill: face.active ? 'rgba(255,255,255,.05)' : 'transparent',
                  stroke: face.color,
                  strokeWidth: face.active ? stroke * 1.6 : stroke,
                  strokeDasharray: face.active ? '' : `${6 / view.scale} ${4 / view.scale}`,
                  style: { pointerEvents: 'auto', cursor: 'pointer' },
                  onClick: (event) => { event.stopPropagation(); editFace(layers[face.index], face.index); },
                })),
                ...Array.from({ length: points.length }, (_, i) => {
                  const a = points[i];
                  const b = points[(i + 1) % points.length];
                  if (!a || !b || points.length < 2) return null;
                  return h('line', {
                    key: `e-${i}`,
                    x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                    stroke: edgeColor(i), strokeWidth: stroke,
                  });
                }),
                ...points.map((p, i) => h('circle', {
                  key: `p-${i}`,
                  cx: p.x, cy: p.y, r: pointR,
                  fill: edgeColor(i), stroke: '#111', strokeWidth: stroke / 2,
                  style: { pointerEvents: 'auto', cursor: 'move' },
                  onPointerDown: startPointDrag(i),
                  onPointerMove: onPointPointerMove,
                  onPointerUp: onPointPointerUp,
                  onContextMenu: removePoint(i),
                })),
              ),
            ),
            h('div', { style: { position: 'absolute', right: '6px', bottom: '4px', color: 'rgba(226,232,240,.75)', font: '10.5px ui-monospace,Consolas,monospace', pointerEvents: 'none' } }, `×${view.scale.toFixed(2)} · 滚轮缩放 / 中键平移`),
          )
          : null,

        image && project && points.length > 0
          ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '4px 10px', marginBottom: '8px' } },
            ...Array.from({ length: points.length }, (_, i) => h('div', { key: `n-${i}`, style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('svg', { width: 18, height: 12 }, h('line', { x1: 1, y1: 6, x2: 17, y2: 6, stroke: edgeColor(i), strokeWidth: 3 })),
              renaming === i
                ? h('input', {
                  autoFocus: true, defaultValue: nameOf(i),
                  onBlur: (event) => {
                    const value = event.target.value;
                    setNames((list) => { const next = list.slice(); next[i] = value || nameOf(i); return next; });
                    setRenaming(-1);
                  },
                  onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
                  style: { flex: 1, minWidth: 0, height: '22px', padding: '0 4px', borderRadius: '4px', border: `1px solid ${C.border}`, background: C.panel2, color: C.text, font: 'inherit' },
                })
                : h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, nameOf(i)),
              h('button', { type: 'button', onClick: () => setRenaming(i), style: { ...btn(false), height: '20px', padding: '0 5px', fontSize: '10.5px' } }, '编辑'),
            )),
          )
          : null,

        project
          ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' } },
            h('input', {
              value: faceName,
              onChange: (event) => setFaceName(event.target.value),
              placeholder: '面名，例如 wing_l',
              style: { flex: 1, minWidth: 0, height: '28px', padding: '0 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.panel2, color: C.text, font: 'inherit' },
            }),
            h('button', {
              type: 'button', onClick: save, disabled: busy || points.length < 3,
              style: {
                height: '28px', padding: '0 14px', borderRadius: '6px',
                border: '1px solid #111', background: '#fff', color: '#111',
                font: '12.5px "Segoe UI","Microsoft YaHei",system-ui,sans-serif', fontWeight: 600,
                cursor: busy || points.length < 3 ? 'not-allowed' : 'pointer',
                opacity: busy || points.length < 3 ? 0.5 : 1,
              },
            }, busy ? '保存中…' : '确认'),
          )
          : null,

        image && project
          ? h('div', { style: { color: C.muted, marginBottom: '6px' } },
            `预览 ${image.w}×${image.h} → ×${(project.width / image.w).toFixed(2)} → 画布 ${project.width}×${project.height}`)
          : null,

        h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: '6px' } },
          h('div', { style: { color: C.muted, marginBottom: '4px' } }, `已保存的面（${layers.length}）`),
          layers.length === 0
            ? h('div', { style: { color: C.muted } }, '还没有面')
            : layers.map((layer, index) => {
              const color = faceColorOf(layer, index);
              const active = editing ? editing.id === layer.id : false;
              return h('div', { key: layer.id, style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', borderBottom: `1px dashed ${C.border}` } },
                h('button', {
                  type: 'button',
                  onClick: () => editFace(layer, index),
                  style: {
                    flex: 1, textAlign: 'left', padding: '3px 6px', borderRadius: '5px',
                    border: `1px solid ${active ? color : C.border}`, background: active ? 'rgba(148,163,184,.12)' : 'transparent',
                    color: C.text, cursor: 'pointer', font: '11.5px ui-monospace,Consolas,monospace',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  },
                }, layer.id),
                h('span', { style: { width: '18px', height: '12px', background: color, border: '1px solid rgba(0,0,0,.35)', borderRadius: '2px' } }),
                h('span', { style: { color: C.muted, fontSize: '10.5px' } }, `${(layer.quad || []).length} 点`),
              );
            }),
        ),

        status
          ? h('div', { style: { marginTop: '8px', color: /失败|没有|不支持/.test(status) ? C.bad : C.ok, wordBreak: 'break-all', lineHeight: 1.5 } }, status)
          : null,
      );
    }

    function FloatingPicker() {
      const [open, setOpen] = React.useState(false);
      const [mini, setMini] = React.useState(false);
      const [pos, setPos] = React.useState(() => {
        try {
          const raw = localStorage.getItem('wtskin.panel.pos');
          const parsed = raw ? JSON.parse(raw) : null;
          if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
        } catch { /* ignore */ }
        return null;
      });
      const drag = React.useRef(null);
      const lastStamp = React.useRef(0);

      React.useEffect(() => {
        if (!pos) return;
        try { localStorage.setItem('wtskin.panel.pos', JSON.stringify(pos)); } catch { /* ignore */ }
      }, [pos]);

      // The only two triggers write WTSP/.open: the /wtspwds command and the
      // dsh_wtskin_picker tool. Reading the marker is silent — no command is
      // executed here, so nothing is appended to the session log.
      React.useEffect(() => {
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          const sid = sessionId();
          if (!sid) return;
          try {
            const file = unwrap(await api.remote.workspaceFiles.read(sid, 'WTSP/.open', {}, new AbortController().signal));
            const stamp = Number(String(file.text || '').trim());
            if (!Number.isFinite(stamp) || stamp === lastStamp.current) return;
            if (Math.abs(Date.now() - stamp) > 120_000) return;
            lastStamp.current = stamp;
            setOpen(true);
            setMini(false);
          } catch { /* the marker does not exist until a trigger runs */ }
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => { stopped = true; window.clearInterval(timer); };
      }, []);

      const startDrag = (event) => {
        const target = event.target;
        if (target && target.closest && target.closest('button')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      };
      const moveDrag = (event) => {
        if (!drag.current) return;
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 120, event.clientX - drag.current.dx)),
          y: Math.max(0, Math.min(window.innerHeight - 48, event.clientY - drag.current.dy)),
        });
      };
      const endDrag = () => { drag.current = null; };
      const stop = (event) => { event.stopPropagation(); };

      if (!open) return null;

      const iconBtn = {
        border: 'none', background: 'transparent', color: C.muted,
        cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px',
      };
      const chrome = {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '6px 10px', borderBottom: `1px solid ${C.border}`,
        cursor: 'move', userSelect: 'none',
        font: '12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif', color: C.muted,
      };

      if (mini) {
        return h('div', {
          onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
          style: {
            position: 'fixed', left: pos ? pos.x : Math.max(24, window.innerWidth - 220), top: pos ? pos.y : 96,
            zIndex: 60, display: 'flex', alignItems: 'center', gap: '8px',
            padding: '6px 8px', borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-1, #0f1a2d)', border: `1px solid ${C.border}`,
            boxShadow: '0 10px 24px rgba(0,0,0,.4)', cursor: 'move', userSelect: 'none',
            font: '12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
          },
        },
          h('span', { style: { color: C.brand, fontWeight: 700 } }, '涂装取点'),
          h('button', { type: 'button', onPointerDown: stop, onClick: () => setMini(false), title: '展开', style: iconBtn }, '▢'),
          h('button', { type: 'button', onPointerDown: stop, onClick: () => setOpen(false), title: '关闭', style: iconBtn }, '×'),
        );
      }

      return h('div', {
        style: {
          position: 'fixed', left: pos ? pos.x : Math.max(24, window.innerWidth - 470), top: pos ? pos.y : 96, zIndex: 60,
          width: '440px', height: '660px', minWidth: '340px', minHeight: '300px',
          resize: 'both', overflow: 'auto',
          background: 'var(--dsw-alias-bg-layer-1, #0f1a2d)', border: `1px solid ${C.border}`,
          borderRadius: '10px', boxShadow: '0 18px 40px rgba(0,0,0,.45)',
        },
      },
        h('div', { onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, style: chrome },
          h('span', { style: { color: C.brand, fontWeight: 700 } }, '涂装取点'),
          h('span', null, '拖动移动 · 右下角缩放'),
          h('button', { type: 'button', onPointerDown: stop, onClick: () => setMini(true), title: '最小化', style: { ...iconBtn, marginLeft: 'auto' } }, '—'),
          h('button', { type: 'button', onPointerDown: stop, onClick: () => setOpen(false), title: '关闭', style: iconBtn }, '×'),
        ),
        h(Panel),
      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions',
        'remote', 'remote.workspaceFiles', 'remote.commands'],
      apply(ctx) {
        api = ctx;
        ctx.effect(() => ctx.slots.register({
          name: 'shell.overlay',
          id: 'wtskin-floating-picker',
          order: 40,
        }, FloatingPicker));
      },
    };
  },
});
