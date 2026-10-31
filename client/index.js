/**
 * Client half: the right-sidebar quad picker.
 *
 * Registered as a tab type through ctx.sidebarRightTabs and rendered in
 * `sidebar.right.pane.tab`. It reads the project through
 * ctx.remote.workspaceFiles and writes quads through the internal
 * `wtskin-save` command — no postMessage, no iframe.
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

    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    let openedOnce = false;

    function Panel() {
      const [sid, setSid] = React.useState(sessionId);
      const [projects, setProjects] = React.useState([]);
      const [dir, setDir] = React.useState('');
      const [project, setProject] = React.useState(null);
      const [image, setImage] = React.useState(null);
      const [points, setPoints] = React.useState([]);
      const [mode, setMode] = React.useState(false);
      const [faceName, setFaceName] = React.useState('face_1');
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const imageRef = React.useRef(null);
      const urlRef = React.useRef(null);
      const boxRef = React.useRef(null);

      const scale = project && image ? project.width / image.w : 1;

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

      const pickImage = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (file) useImage(file);
        });
        input.click();
      };

      const useImage = (file) => {
        if (!file || !String(file.type).startsWith('image/')) return;
        const url = URL.createObjectURL(file);
        const probe = new Image();
        probe.onload = () => {
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setImage({ url, w: probe.naturalWidth, h: probe.naturalHeight });
          setPoints([]);
          setMode(false);
          setStatus(`预览 ${probe.naturalWidth}×${probe.naturalHeight}，缩放 ×${(project ? project.width / probe.naturalWidth : 1).toFixed(2)}`);
        };
        probe.src = url;
      };

      const onPaste = (event) => {
        const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
        const item = items.find((entry) => entry.type.startsWith('image/'));
        if (!item) return;
        const file = item.getAsFile();
        if (!file) return;
        event.preventDefault();
        useImage(file);
      };

      const onDrop = (event) => {
        const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
        const file = files.find((entry) => entry.type.startsWith('image/'));
        if (!file) return;
        event.preventDefault();
        useImage(file);
      };

      const onClickImage = (event) => {
        if (!mode || !image) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.min(image.w - 1, Math.floor(((event.clientX - rect.left) / rect.width) * image.w));
        const y = Math.min(image.h - 1, Math.floor(((event.clientY - rect.top) / rect.height) * image.h));
        const next = points.length >= 4 ? [[x, y]] : [...points, [x, y]];
        setPoints(next);
        if (next.length === 4) { setMode(false); setStatus('4 点完成，命名后点「保存面」'); }
      };

      const save = async () => {
        const id = sessionId();
        if (!id || !dir || !project) return;
        if (points.length !== 4) { setStatus('先点满 4 个点'); return; }
        const name = faceName.trim() || 'face_1';
        const quad = points.map((point) => [Math.round(point[0] * scale), Math.round(point[1] * scale)]);
        setBusy(true);
        try {
          const line = `/wtskin-save ${JSON.stringify({ dir, faces: [{ id: name, quad }] })}`;
          const out = await api.remote.commands.execute(id, line, []);
          const result = out && out.result;
          if (!result || result.kind !== 'success') throw new Error((result && result.text) || '保存失败');
          const info = JSON.parse(result.text);
          setPoints([]);
          setStatus(`已保存 ${info.saved.join(', ')}（共 ${info.layers} 个面）`);
          await load(dir);
          const match = /^face_(\d+)$/.exec(name);
          setFaceName(match ? `face_${Number(match[1]) + 1}` : `${name}_2`);
        } catch (error) {
          setStatus(`保存失败：${String((error && error.message) || error)}`);
        } finally {
          setBusy(false);
        }
      };

      const layers = (project && project.layers) || [];
      const chord = points.length === 4 ? mid(points[0], points[1]) : null;
      const tail = points.length === 4 ? mid(points[2], points[3]) : null;

      return h('div', {
        onPaste, onDrop, onDragOver: (event) => event.preventDefault(),
        tabIndex: 0,
        style: {
          padding: '12px 14px', minHeight: '100%', boxSizing: 'border-box',
          color: C.text, font: '12.5px "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
          outline: 'none',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          h('strong', { style: { fontSize: '13px' } }, '涂装取点'),
          h('span', { style: { color: C.muted, fontSize: '11px' } }, 'v3'),
          h('button', { type: 'button', onClick: () => load(dir), style: { ...btn(false), marginLeft: 'auto' } }, '刷新'),
        ),

        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' } },
          h('select', {
            value: dir,
            onChange: (event) => load(event.target.value),
            style: {
              flex: 1, minWidth: 0, height: '28px', borderRadius: '6px',
              border: `1px solid ${C.border}`, background: C.panel2, color: C.text, font: 'inherit',
            },
          },
            projects.length === 0 ? h('option', { value: '' }, '还没有工程') : null,
            ...projects.map((item) => h('option', { key: item, value: item }, item.replace(/^WTSP\//, ''))),
          ),
          project ? h('span', { style: { color: C.muted } }, `${project.width}×${project.height}`) : null,
        ),

        project
          ? h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
            h('button', { type: 'button', onClick: pickImage, style: btn(false) }, image ? '换图片' : '选择图片'),
            h('button', {
              type: 'button',
              onClick: () => { setMode(!mode); setStatus(mode ? '' : '在图片上依次点 4 个角'); },
              disabled: !image,
              style: { ...btn(mode), opacity: image ? 1 : 0.45 },
            }, mode ? '框选中…' : '四点框选'),
            h('button', {
              type: 'button',
              onClick: () => setPoints(points.slice(0, -1)),
              disabled: !points.length,
              style: { ...btn(false), opacity: points.length ? 1 : 0.45 },
            }, '撤销'),
            h('button', {
              type: 'button',
              onClick: () => { setPoints([]); setStatus(''); },
              disabled: !points.length,
              style: { ...btn(false), opacity: points.length ? 1 : 0.45 },
            }, '清空'),
          )
          : null,

        image && project
          ? h('div', {
            ref: boxRef,
            onClick: onClickImage,
            style: {
              position: 'relative', width: '100%', lineHeight: 0, marginBottom: '8px',
              border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden',
              cursor: mode ? 'crosshair' : 'default', background: '#0b1526',
            },
          },
            h('img', {
              ref: imageRef,
              src: image.url,
              alt: '贴图预览',
              style: { display: 'block', width: '100%', height: 'auto', userSelect: 'none' },
            }),
            h('svg', {
              viewBox: `0 0 ${image.w} ${image.h}`,
              preserveAspectRatio: 'none',
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
            },
              points.length > 1 ? h('polygon', {
                points: points.map((point) => point.join(',')).join(' '),
                fill: 'rgba(34,211,238,.18)', stroke: '#22d3ee', strokeWidth: 2,
                vectorEffect: 'non-scaling-stroke',
              }) : null,
              chord && tail ? h('line', {
                x1: chord[0], y1: chord[1], x2: tail[0], y2: tail[1],
                stroke: '#f472b6', strokeWidth: 2, strokeDasharray: '8 5',
                vectorEffect: 'non-scaling-stroke',
              }) : null,
              chord && tail ? h('text', {
                x: (chord[0] + tail[0]) / 2 + image.w / 90,
                y: (chord[1] + tail[1]) / 2,
                fill: '#f9a8d4',
                style: { font: '12px ui-monospace,Consolas,monospace' },
              }, `弦 ${Math.round(Math.hypot(tail[0] - chord[0], tail[1] - chord[1]) * scale)} px`) : null,
              ...points.map((point, index) => h('g', { key: index },
                h('circle', {
                  cx: point[0], cy: point[1], r: Math.max(3, image.w / 160),
                  fill: '#f59e0b', stroke: '#111', vectorEffect: 'non-scaling-stroke',
                }),
                h('text', {
                  x: point[0] + image.w / 120, y: point[1] - image.w / 180,
                  fill: '#fff', style: { font: '12px ui-monospace,Consolas,monospace' },
                }, String(index + 1)),
              )),
            ),
          )
          : null,

        project
          ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' } },
            h('input', {
              value: faceName,
              onChange: (event) => setFaceName(event.target.value),
              placeholder: '面名，例如 wing_l',
              style: {
                flex: 1, minWidth: 0, height: '28px', padding: '0 8px', borderRadius: '6px',
                border: `1px solid ${C.border}`, background: C.panel2, color: C.text, font: 'inherit',
              },
            }),
            h('button', {
              type: 'button', onClick: save,
              disabled: busy || points.length !== 4,
              style: { ...btn(true), opacity: busy || points.length !== 4 ? 0.45 : 1 },
            }, busy ? '保存中…' : '保存面'),
          )
          : null,

        image && project
          ? h('div', { style: { color: C.muted, marginBottom: '6px' } },
            `预览 ${image.w}×${image.h} → ×${scale.toFixed(2)} → 画布 ${project.width}×${project.height}`)
          : null,

        h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: '6px' } },
          h('div', { style: { color: C.muted, marginBottom: '4px' } }, `已保存的面（${layers.length}）`),
          layers.length === 0
            ? h('div', { style: { color: C.muted } }, '还没有面')
            : layers.map((layer) => h('div', {
              key: layer.id,
              style: {
                display: 'flex', gap: '8px', padding: '3px 0',
                borderBottom: `1px dashed ${C.border}`,
                font: '11.5px ui-monospace,Consolas,monospace',
              },
            },
              h('span', { style: { color: C.brand } }, layer.id),
              h('span', { style: { color: C.muted, marginLeft: 'auto' } },
                layer.image ? '有立绘' : '待补立绘'),
            )),
        ),

        status
          ? h('div', {
            style: {
              marginTop: '8px', color: /失败|没有/.test(status) ? C.bad : C.ok,
              wordBreak: 'break-all', lineHeight: 1.5,
            },
          }, status)
          : null,

      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions',
        'remote', 'remote.workspaceFiles', 'remote.commands'],
      apply(ctx) {
        api = ctx;

        // Floating window over the frame: draggable by its header, resizable by
        // the native corner handle, and independent of the right sidebar (whose
        // tab never showed reliably). The pet widget proves this surface works.
        function FloatingPicker() {
          const [mode, setMode] = React.useState(undefined);
          const [open, setOpen] = React.useState(false);
          const [mini, setMini] = React.useState(false);
          const [dismissed, setDismissed] = React.useState(false);
          const [pos, setPos] = React.useState(null);
          const drag = React.useRef(null);
          const checkedSid = React.useRef(null);

          React.useEffect(() => {
            let stopped = false;
            const checkMode = async () => {
              if (stopped) return;
              const sid = sessionId();
              if (!sid || checkedSid.current === sid) return;
              checkedSid.current = sid;
              setOpen(false);
              setMini(false);
              setDismissed(false);
              let preset = null;
              try {
                const out = await api.remote.commands.execute(sid, '/wtskin-whoami', []);
                preset = JSON.parse((out && out.result && out.result.text) || '{}').preset || null;
              } catch { preset = null; }
              if (!stopped) setMode(preset);
            };
            const onFocus = () => { checkedSid.current = null; checkMode(); };
            checkMode();
            window.addEventListener('focus', onFocus);
            const timer = window.setInterval(checkMode, 3000);
            return () => {
              stopped = true;
              window.clearInterval(timer);
              window.removeEventListener('focus', onFocus);
            };
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

          // Strictly this mode: unknown or another preset renders nothing, and
          // nothing opens by itself — the edge tab is the only entry.
          if (mode !== 'wtskin' || dismissed) return null;

          const iconBtn = {
            border: 'none', background: 'transparent', color: C.muted,
            cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px',
          };

          if (!open) {
            return h('div', {
              style: {
                position: 'fixed', right: 0, top: '42%', zIndex: 60,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                padding: '4px 3px', borderRadius: '8px 0 0 8px',
                border: `1px solid ${C.border}`, borderRight: 'none',
                background: 'var(--dsw-alias-bg-overlay, #0f1a2d)',
                boxShadow: '0 6px 18px rgba(0,0,0,.25)',
              },
            },
              h('button', {
                type: 'button',
                onClick: () => setOpen(true),
                title: '打开涂装取点',
                style: {
                  border: 'none', background: 'transparent', color: C.brand, cursor: 'pointer',
                  writingMode: 'vertical-rl', padding: '6px 2px', letterSpacing: '2px',
                  font: '12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
                },
              }, '涂装取点'),
              h('button', {
                type: 'button', onClick: () => setDismissed(true), title: '隐藏',
                style: { ...iconBtn, fontSize: '12px', padding: '2px 4px' },
              }, '×'),
            );
          }

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
                position: 'fixed',
                left: pos ? pos.x : Math.max(24, window.innerWidth - 220),
                top: pos ? pos.y : 96,
                zIndex: 60, display: 'flex', alignItems: 'center', gap: '8px',
                padding: '6px 8px', borderRadius: '10px',
                background: 'var(--dsw-alias-bg-layer-1, #0f1a2d)',
                border: `1px solid ${C.border}`, boxShadow: '0 10px 24px rgba(0,0,0,.4)',
                cursor: 'move', userSelect: 'none',
                font: '12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
              },
            },
              h('span', { style: { color: C.brand, fontWeight: 700 } }, '涂装取点'),
              h('button', { type: 'button', onPointerDown: stop, onClick: () => setMini(false), title: '展开', style: iconBtn }, '▢'),
              h('button', {
                type: 'button', onPointerDown: stop, title: '关闭',
                onClick: () => { setMini(false); setOpen(false); }, style: iconBtn,
              }, '×'),
            );
          }

          const left = pos ? pos.x : Math.max(24, window.innerWidth - 470);
          const top = pos ? pos.y : 96;
          return h('div', {
            style: {
              position: 'fixed', left, top, zIndex: 60,
              width: '420px', height: '600px', minWidth: '320px', minHeight: '260px',
              resize: 'both', overflow: 'auto',
              background: 'var(--dsw-alias-bg-layer-1, #0f1a2d)',
              border: `1px solid ${C.border}`, borderRadius: '10px',
              boxShadow: '0 18px 40px rgba(0,0,0,.45)',
            },
          },
            h('div', {
              onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
              style: chrome,
            },
              h('span', { style: { color: C.brand, fontWeight: 700 } }, '涂装取点'),
              h('span', null, '拖动移动 · 右下角缩放'),
              h('button', { type: 'button', onPointerDown: stop, onClick: () => setMini(true), title: '最小化', style: { ...iconBtn, marginLeft: 'auto' } }, '—'),
              h('button', { type: 'button', onPointerDown: stop, onClick: () => setOpen(false), title: '关闭', style: iconBtn }, '×'),
            ),
            h(Panel),
          );
        }



        ctx.effect(() => ctx.slots.register({
          name: 'shell.overlay',
          id: 'wtskin-floating-picker',
          order: 40,
        }, FloatingPicker));
      },
    };
  },
});
