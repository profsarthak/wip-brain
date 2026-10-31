import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const TYPES = ['domain', 'mechanism', 'source'];
const TYPE_LABEL = { domain: 'Domain', mechanism: 'Mechanism', source: 'Essay' };
const TYPE_PLURAL = { domain: 'Domains', mechanism: 'Mechanisms', source: 'Essays' };
const TYPE_NUM = { domain: '■', mechanism: '●', source: '◆' };
const REL = 2.4; // glyph size per cube-root of a note's weight
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad = (i) => `/${String(i).padStart(2, '0')}`;
const jitter = () => (Math.random() - 0.5) * 12;
const rgba = (hex, a) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${v >> 16}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
};

try {
  await main();
} catch (err) {
  console.error(err);
  $('#loading').classList.add('error');
  $('#loading span').textContent = `Couldn't start the diagram (${err.message}). It needs a browser with WebGL enabled.`;
}

async function main() {
  const data = await fetch('graph.json').then((r) => {
    if (!r.ok) throw new Error(`graph.json: HTTP ${r.status}`);
    return r.json();
  });

  // Colours come from the brand tokens in style.css, so the stylesheet stays the single source.
  const css = getComputedStyle(document.documentElement);
  const tok = (name) => css.getPropertyValue(`--${name}`).trim();
  const INK = tok('ink-900');
  const INK_SOFT = tok('ink-700');
  const MUTED = tok('ink-500');
  const PAPER = tok('paper');
  const ORANGE = tok('orange-500');
  const CAT = [1, 2, 3, 4, 5, 6].map((i) => tok(`cat-${i}`));

  // ---------- data ----------
  const nodes = data.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = data.links.map(([a, b]) => ({ source: byId.get(a), target: byId.get(b) }));
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  const linksOf = new Map(nodes.map((n) => [n, []]));
  for (const l of links) {
    adj.get(l.source).add(l.target);
    adj.get(l.target).add(l.source);
    linksOf.get(l.source).push(l);
    linksOf.get(l.target).push(l);
  }
  for (const n of nodes) n.deg = adj.get(n).size;

  const fieldOf = (n) => byId.get(n.domain)?.field;
  const catOf = (n) => CAT[fieldOf(n)] ?? MUTED;
  const issueLabel = (n) => (n.type === 'source' ? `Issue ${pad(n.issue)}` : `Since ${pad(n.issue)}`);
  const valOf = (n) => (n.type === 'domain' ? 30 + n.deg * 0.4 : n.type === 'source' ? 1.4 + n.deg * 0.3 : 0.7 + n.deg * 0.45);
  const sizeOf = (n) => 2 * REL * Math.cbrt(valOf(n)) * (n.type === 'domain' ? 1.15 : 1);

  const state = {
    issue: data.issues,
    types: { domain: true, mechanism: true, source: true },
    mode: '2d',
    colour: 'ink',
    hover: null,
    selected: null,
  };
  const hl = { focus: null, nodes: new Set(), links: new Set() };
  let visibleLinks = links;

  // Ink mode: everything is ink on paper and orange is the only emphasis. Fields mode: the brand's
  // categorical palette marks each field, so emphasis falls back to heavy ink.
  const accent = () => (state.colour === 'ink' ? ORANGE : INK);
  const fillOf = (n) => {
    if (n.type === 'source') return PAPER;
    if (state.colour === 'fields') return catOf(n);
    return n.type === 'domain' ? INK : INK_SOFT;
  };
  const mechEnd = (l) => (l.source.type === 'mechanism' ? l.source : l.target);
  const linkColor = (l) => {
    if (hl.links.has(l)) return accent();
    if (hl.focus) return rgba(INK, 0.035);
    return state.colour === 'fields' ? rgba(catOf(mechEnd(l)), 0.26) : rgba(INK, 0.13);
  };

  function visibleData() {
    const vis = nodes.filter((n) => n.issue <= state.issue && state.types[n.type]);
    const on = new Set(vis);
    for (const n of vis) {
      if (state.mode === '2d') { delete n.z; delete n.vz; }
      if (n.x === undefined) {
        // Newly revealed notes sprout next to a note that's already on the sheet.
        const anchor = [...adj.get(n)].find((m) => on.has(m) && m.x !== undefined);
        if (anchor) {
          n.x = anchor.x + jitter();
          n.y = anchor.y + jitter();
          if (state.mode === '3d') n.z = (anchor.z || 0) + jitter();
        }
      }
    }
    visibleLinks = links.filter((l) => on.has(l.source) && on.has(l.target));
    return { nodes: vis, links: visibleLinks };
  }
  const isVisible = (n) => n.issue <= state.issue && state.types[n.type];

  // A hidden domain's HTML label can outlive its 3D object (it showed up as doubled labels during
  // timeline playback), so sweep labels once the graph has digested each update. Domains with only
  // a handful of notes on the sheet get a faint label so early timeline frames aren't a pile of text.
  function syncLabels() {
    const on = new Set(Graph.graphData().nodes);
    for (const [n, el] of labelEls) {
      if (!on.has(n)) {
        el.remove();
        continue;
      }
      let live = 0;
      for (const m of adj.get(n)) if (on.has(m)) live++;
      el.classList.toggle('faint', live < 6);
    }
    paintNodes();
  }
  function updateGraph() {
    Graph.graphData(visibleData());
    for (const ms of [50, 400]) setTimeout(syncLabels, ms);
  }

  // ---------- glyphs ----------
  // Each note is a flat printed mark that always faces the viewer: ■ domain, ● mechanism, ◆ essay.
  // Textures are white fill + black stroke, so tinting a sprite recolours the fill and keeps the ink line.
  const glyphTexture = (type) => {
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d');
    const lw = type === 'source' ? 16 : type === 'domain' ? 9 : 11;
    const m = lw / 2 + 3;
    g.lineWidth = lw;
    g.lineJoin = 'miter';
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.beginPath();
    if (type === 'domain') g.rect(m, m, S - 2 * m, S - 2 * m);
    else if (type === 'source') {
      g.moveTo(S / 2, m);
      g.lineTo(S - m, S / 2);
      g.lineTo(S / 2, S - m);
      g.lineTo(m, S / 2);
      g.closePath();
    } else g.arc(S / 2, S / 2, S / 2 - m, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  };
  const textures = Object.fromEntries(TYPES.map((t) => [t, glyphTexture(t)]));
  const ORDER = { mechanism: 1, source: 2, domain: 3 };

  const labelEls = new Map();
  function nodeObject(n) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: textures[n.type], color: fillOf(n), transparent: true, depthWrite: false,
    }));
    const s = sizeOf(n);
    sprite.scale.set(s, s, 1);
    sprite.userData.size = s;
    sprite.renderOrder = ORDER[n.type];
    if (n.type === 'domain') {
      const el = document.createElement('div');
      el.className = 'dlabel';
      el.style.setProperty('--c', catOf(n));
      el.innerHTML = `<span><i></i>${esc(n.title)}</span>`;
      labelEls.get(n)?.remove();
      labelEls.set(n, el);
      sprite.add(new CSS2DObject(el));
    }
    return sprite;
  }

  function paintNodes() {
    for (const n of Graph.graphData().nodes) {
      const sprite = n.__threeObj;
      if (!sprite?.material) continue;
      const focus = n === hl.focus;
      sprite.material.color.set(focus && state.colour === 'ink' ? ORANGE : fillOf(n));
      sprite.material.opacity = hl.focus && !hl.nodes.has(n) ? 0.14 : 1;
      const s = sprite.userData.size * (focus ? 1.45 : 1);
      sprite.scale.set(s, s, 1);
    }
  }

  // ---------- scene ----------
  const Graph = new ForceGraph3D($('#graph'), { controlType: 'orbit', extraRenderers: [new CSS2DRenderer()] })
    .width(innerWidth)
    .height(innerHeight)
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .numDimensions(2)
    .nodeRelSize(REL)
    .nodeVal(valOf)
    .nodeThreeObject(nodeObject)
    .nodeLabel((n) => `<div class="tip"><span>${TYPE_NUM[n.type]} ${TYPE_LABEL[n.type]} · ${issueLabel(n)}</span>${esc(n.title)}</div>`)
    .linkColor(linkColor)
    .linkOpacity(1)
    .linkWidth((l) => (hl.links.has(l) ? 0.45 : 0))
    .linkDirectionalParticles((l) => (hl.links.has(l) ? 2 : 0))
    .linkDirectionalParticleWidth((l) => (hl.links.has(l) ? 1.8 : 1.2))
    .linkDirectionalParticleSpeed(0.005)
    .linkDirectionalParticleColor((l) => (hl.links.has(l) ? accent() : MUTED))
    .cooldownTime(15000)
    .onNodeHover((n) => {
      state.hover = n;
      $('#graph').style.cursor = n ? 'pointer' : '';
      refresh();
    })
    .onNodeClick((n) => select(n))
    .onBackgroundClick(() => select(null))
    .graphData(visibleData());

  $('#graph').addEventListener('pointerleave', () => {
    if (!state.hover) return;
    state.hover = null;
    refresh();
  });
  Graph.renderer().setPixelRatio(Math.min(devicePixelRatio, 2));

  function applyForces() {
    Graph.d3Force('charge').strength(state.mode === '3d' ? -48 : -32).distanceMax(500);
    Graph.d3Force('link').distance((l) => (l.source.type === 'domain' || l.target.type === 'domain' ? 70 : 30));
  }
  applyForces();

  const controls = Graph.controls();
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, autoRotate: false, autoRotateSpeed: 0.35 });
  function applyControls() {
    const flat = state.mode === '2d';
    controls.enableRotate = !flat;
    controls.screenSpacePanning = true;
    controls.mouseButtons.LEFT = flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.touches.ONE = flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }
  applyControls();
  Graph.cameraPosition({ x: 0, y: 0, z: 1400 }, { x: 0, y: 0, z: 0 });

  let touched = false;
  let lastTouch = 0;
  let idleTimer;
  controls.addEventListener('start', () => {
    touched = true;
    lastTouch = performance.now();
    controls.autoRotate = false;
    clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    idleTimer = setTimeout(() => {
      if (state.mode === '3d' && !state.selected && !reducedMotion) controls.autoRotate = true;
    }, 12000);
  });

  let fitted = false;
  Graph.onEngineStop(() => {
    if (!fitted && !touched && !state.selected) Graph.zoomToFit(1200, 40);
    fitted = true;
  });
  for (const ms of [2600, 6500]) setTimeout(() => !touched && !state.selected && Graph.zoomToFit(1500, 40), ms);

  // Fit now and once more after the layout has settled, unless the user grabs the camera meanwhile.
  function fitSoon() {
    const asked = performance.now();
    Graph.zoomToFit(1000, 40);
    setTimeout(() => lastTouch < asked && !state.selected && Graph.zoomToFit(1200, 40), 2600);
  }

  addEventListener('resize', () => Graph.width(innerWidth).height(innerHeight));

  // Ambient signal: small ink packets travel random connections while nothing is focused.
  if (!reducedMotion) {
    setInterval(() => {
      if (document.hidden || hl.focus || !visibleLinks.length) return;
      for (let k = 0; k < 2; k++) Graph.emitParticle(visibleLinks[(Math.random() * visibleLinks.length) | 0]);
    }, 220);
  }

  // ---------- status bar ----------
  const c = data.counts;
  $('#sb-counts').textContent = `N=${c.notes} · E=${c.links.toLocaleString()}`;
  const clock = () => {
    const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    $('#sb-time').textContent = `SYS.TIME ${t} · IST UTC+5:30`;
  };
  clock();
  setInterval(clock, 1000);
  const coord = (v) => `${v < 0 ? '−' : '+'}${String(Math.abs(Math.round(v))).padStart(4, '0')}`;
  let camQueued = false;
  const showCamera = () => {
    if (camQueued) return;
    camQueued = true;
    requestAnimationFrame(() => {
      camQueued = false;
      const p = Graph.cameraPosition();
      $('#sb-cam').textContent = `VIEW ${state.mode.toUpperCase()} · CAM X${coord(p.x)} Y${coord(p.y)} Z${coord(p.z)}`;
    });
  };
  controls.addEventListener('change', showCamera);
  showCamera();

  // ---------- highlight ----------
  let queued = false;
  function refresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const f = state.hover || state.selected;
      hl.focus = f;
      hl.nodes = new Set(f ? [f, ...adj.get(f)] : []);
      hl.links = new Set(f ? linksOf.get(f) : []);
      paintNodes();
      Graph.linkColor(Graph.linkColor())
        .linkWidth(Graph.linkWidth())
        .linkDirectionalParticles(Graph.linkDirectionalParticles());
      for (const [n, el] of labelEls) {
        el.classList.toggle('dim', !!f && !hl.nodes.has(n));
        el.classList.toggle('focus', n === f);
      }
      for (const b of document.querySelectorAll('#domains button')) b.classList.toggle('active', !!f && +b.dataset.id === f.id);
    });
  }

  // ---------- selection & camera ----------
  function select(n, { fly = true } = {}) {
    if (n) ensureVisible(n);
    state.selected = n;
    state.hover = null;
    renderPanel(n);
    refresh();
    history.replaceState(null, '', n ? `#${encodeURIComponent(n.title)}` : location.pathname + location.search);
    if (!n) return;
    controls.autoRotate = false;
    if (fly) flyTo(n);
  }

  function flyTo(n) {
    const go = () => {
      const spread = Math.max(40, ...[...adj.get(n)].filter((m) => m.x !== undefined)
        .map((m) => Math.hypot(m.x - n.x, m.y - n.y, (m.z || 0) - (n.z || 0))));
      const d = Math.min(Math.max(spread * 2.2, 180), 1400);
      if (state.mode === '2d') {
        Graph.cameraPosition({ x: n.x, y: n.y, z: d }, { x: n.x, y: n.y, z: 0 }, 1100);
      } else {
        const k = 1 + d / (Math.hypot(n.x, n.y, n.z) || 1);
        Graph.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, n, 1300);
      }
    };
    n.x === undefined ? setTimeout(go, 500) : go();
  }

  function ensureVisible(n) {
    if (isVisible(n)) return;
    state.types[n.type] = true;
    if (n.issue > state.issue) state.issue = data.issues;
    stopPlay();
    updateGraph();
    syncControls();
  }

  // ---------- 2D / 3D ----------
  function camDistance() {
    const p = Graph.cameraPosition();
    const t = controls.target;
    return Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    syncControls();
    applyControls();
    const d = camDistance();
    if (mode === '2d') {
      controls.autoRotate = false;
      Graph.cameraPosition({ x: 0, y: 0, z: Math.max(d, 700) }, { x: 0, y: 0, z: 0 }, 1000);
      // Press the brain flat over a second while the layout keeps running, then hand over to 2D.
      const squash = Graph.graphData().nodes.map((n) => [n, n.z || 0]);
      Graph.d3ReheatSimulation();
      const t0 = performance.now();
      const dur = reducedMotion ? 1 : 1000;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const ease = 1 - (1 - k) ** 3;
        for (const [n, z] of squash) n.fz = z * (1 - ease);
        if (k < 1) return requestAnimationFrame(step);
        for (const [n] of squash) delete n.fz;
        if (state.mode !== '2d') return;
        Graph.numDimensions(2);
        applyForces();
        if (!state.selected) fitSoon();
      };
      requestAnimationFrame(step);
    } else {
      // Start from a nearly flat sheet; repulsion lifts it into a 3D brain.
      for (const n of nodes) {
        n.z = (Math.random() - 0.5) * 6;
        n.vz = 0;
      }
      Graph.numDimensions(3);
      applyForces();
      const far = Math.max(d, 700);
      Graph.cameraPosition({ x: far * 0.55, y: far * 0.2, z: far * 0.8 }, { x: 0, y: 0, z: 0 }, 1200);
      if (!state.selected) setTimeout(fitSoon, 1300);
      controls.autoRotate = !reducedMotion && !state.selected;
    }
    showCamera();
  }

  function setColour(colour) {
    if (colour === state.colour) return;
    state.colour = colour;
    document.body.classList.toggle('fields', colour === 'fields');
    syncControls();
    refresh();
    if (state.selected) renderPanel(state.selected);
  }

  // ---------- timeline ----------
  const range = $('#issue');
  range.max = data.issues;
  $('#ticks').innerHTML = Array.from({ length: data.issues }, (_, i) => {
    const n = i + 1;
    const label = n === 1 || n === data.issues || n % 5 === 0 ? ` data-n="${String(n).padStart(2, '0')}"` : '';
    return `<i${label}></i>`;
  }).join('');
  const ticks = [...document.querySelectorAll('#ticks i')];
  let playTimer = null;

  function setIssue(i) {
    state.issue = i;
    updateGraph();
    if (state.selected && !isVisible(state.selected)) select(null);
    syncControls();
  }
  function startPlay() {
    if (state.issue >= data.issues) {
      if (!state.selected) Graph.zoomToFit(1000, 40);
      setIssue(1);
    }
    controls.autoRotate = !reducedMotion && state.mode === '3d' && !state.selected;
    playTimer = setInterval(() => (state.issue >= data.issues ? stopPlay() : setIssue(state.issue + 1)), 1200);
    syncControls();
  }
  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    syncControls();
  }

  function syncControls() {
    range.value = state.issue;
    ticks.forEach((t, i) => t.classList.toggle('on', i < state.issue));
    const shown = Graph.graphData().nodes.length;
    $('#tl-label').innerHTML = `<b>Issue ${String(state.issue).padStart(2, '0')}</b> / ${String(data.issues).padStart(2, '0')} · n=${shown}`;
    $('#play').classList.toggle('playing', !!playTimer);
    $('#play').setAttribute('aria-label', playTimer ? 'Pause' : 'Play the brain growing issue by issue');
    for (const b of document.querySelectorAll('#types button')) b.setAttribute('aria-pressed', String(state.types[b.dataset.type]));
    for (const b of document.querySelectorAll('#view button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
    for (const b of document.querySelectorAll('#colour button')) b.setAttribute('aria-pressed', String(b.dataset.colour === state.colour));
  }

  range.addEventListener('input', () => {
    const issue = +range.value; // read before stopPlay() re-syncs the slider
    stopPlay();
    setIssue(issue);
  });
  $('#play').addEventListener('click', () => (playTimer ? stopPlay() : startPlay()));
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('#colour').addEventListener('click', (e) => {
    const b = e.target.closest('[data-colour]');
    if (b) setColour(b.dataset.colour);
  });
  $('#fit').addEventListener('click', () => Graph.zoomToFit(900, 40));

  // ---------- title + index ----------
  $('#stats').textContent = `${c.notes} notes · ${c.links.toLocaleString()} links · issues 01–${String(data.issues).padStart(2, '0')}`;
  $('#updated').textContent = `Updated ${new Date(data.generated).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}.`;

  const glyph = (n) => `<i class="g ${n.type}" style="--c:${catOf(n)}"></i>`;
  $('#types').innerHTML = TYPES.map((t) => `
    <button data-type="${t}" aria-pressed="true">
      <b><i class="g ${t}"></i>${TYPE_PLURAL[t]}</b><span>n=${c[`${t}s`]}</span>
    </button>`).join('');
  $('#types').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    state.types[b.dataset.type] = !state.types[b.dataset.type];
    if (state.selected && !isVisible(state.selected)) select(null);
    updateGraph();
    syncControls();
  });

  const members = new Map();
  for (const n of nodes) if (n.type === 'mechanism') members.set(n.domain, (members.get(n.domain) || 0) + 1);
  const domainList = $('#domains');
  const fieldRows = [];
  for (let f = 0; f < data.fields; f++) {
    const ds = data.domainOrder.map((id) => byId.get(id)).filter((d) => d.field === f);
    if (!ds.length) continue; // fields keep their number across updates, so one can end up empty
    const total = ds.reduce((sum, d) => sum + (members.get(d.id) || 0), 0);
    fieldRows.push(`<li class="fhead" style="--c:${CAT[f]}"><i class="sw"></i>Field ${String(f + 1).padStart(2, '0')}<span>${ds.length} dom · n=${total}</span></li>`);
    for (const d of ds) {
      fieldRows.push(`<li><button data-id="${d.id}">${glyph(d)}<span>${esc(d.title)}</span><span class="count">${members.get(d.id) || 0}</span></button></li>`);
    }
  }
  domainList.innerHTML = fieldRows.join('');
  domainList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    select(byId.get(+b.dataset.id));
    setLegend(false);
  });
  domainList.addEventListener('mouseover', (e) => {
    const b = e.target.closest('[data-id]');
    state.hover = b ? byId.get(+b.dataset.id) : null;
    refresh();
  });
  domainList.addEventListener('mouseleave', () => {
    state.hover = null;
    refresh();
  });

  const setLegend = (open) => {
    document.body.classList.toggle('legend-open', open);
    $('#legend-toggle').setAttribute('aria-expanded', String(open));
  };
  $('#legend-toggle').addEventListener('click', () => setLegend(!document.body.classList.contains('legend-open')));

  // ---------- note card with its 2D local graph ----------
  const panel = $('#panel');

  // SVG versions of the three marks, so the figure reads like a plate from the same diagram.
  function mark(n, x, y, r, fill) {
    const f = (v) => v.toFixed(1);
    const sw = r > 6 ? 1.5 : 1;
    if (n.type === 'domain') return `<rect x="${f(x - r)}" y="${f(y - r)}" width="${f(2 * r)}" height="${f(2 * r)}" fill="${fill}" stroke="${INK}" stroke-width="${sw}"/>`;
    if (n.type === 'source') return `<path d="M${f(x)} ${f(y - r * 1.25)}L${f(x + r * 1.25)} ${f(y)}L${f(x)} ${f(y + r * 1.25)}L${f(x - r * 1.25)} ${f(y)}Z" fill="${fill}" stroke="${INK}" stroke-width="${sw}"/>`;
    return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}" stroke="${INK}" stroke-width="${sw}"/>`;
  }

  function egoGraph(n) {
    const nb = [...adj.get(n)].sort((a, b) =>
      TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || (fieldOf(a) ?? 9) - (fieldOf(b) ?? 9) || a.title.localeCompare(b.title));
    const S = 320;
    const C = S / 2;
    const R = 128;
    const pt = new Map(nb.map((m, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / nb.length;
      return [m, [C + R * Math.cos(a), C + R * Math.sin(a)]];
    }));
    const f = (v) => v.toFixed(1);
    let chords = '';
    let chordCount = 0;
    for (let i = 0; i < nb.length; i++) {
      for (let j = i + 1; j < nb.length; j++) {
        if (!adj.get(nb[i]).has(nb[j])) continue;
        const [x1, y1] = pt.get(nb[i]);
        const [x2, y2] = pt.get(nb[j]);
        const qx = C + ((x1 + x2) / 2 - C) * 0.3;
        const qy = C + ((y1 + y2) / 2 - C) * 0.3;
        chords += `<path data-a="${nb[i].id}" data-b="${nb[j].id}" d="M${f(x1)} ${f(y1)}Q${f(qx)} ${f(qy)} ${f(x2)} ${f(y2)}"/>`;
        chordCount++;
      }
    }
    const r = nb.length > 70 ? 2.4 : nb.length > 30 ? 3.2 : 4.4;
    const spokes = nb.map((m) => `<line x1="${C}" y1="${C}" x2="${f(pt.get(m)[0])}" y2="${f(pt.get(m)[1])}"/>`).join('');
    const marks = nb.map((m) => {
      const [x, y] = pt.get(m);
      const rr = m.type === 'domain' ? r * 1.3 : r;
      return `<g data-id="${m.id}">${mark(m, x, y, rr, fillOf(m))}<circle class="hit" cx="${f(x)}" cy="${f(y)}" r="${Math.max(rr + 3, 8)}"/></g>`;
    }).join('');
    const centre = state.colour === 'ink' ? ORANGE : fillOf(n);
    const svg = `
      <svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Local graph: ${nb.length} notes connected to ${esc(n.title)}" style="--accent:${accent()}">
        <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${INK}" stroke-opacity=".12" stroke-dasharray="2 4"/>
        <g class="chords">${chords}</g>
        <g class="spokes">${spokes}</g>
        ${mark(n, C, C, 9, centre)}
        <g class="marks">${marks}</g>
      </svg>`;
    const caption = `n=${nb.length} direct · ${chordCount} links among them`;
    return { svg, caption };
  }

  function renderPanel(n) {
    document.body.classList.toggle('panel-open', !!n);
    panel.classList.toggle('open', !!n);
    panel.inert = !n;
    if (!n) return;
    const nb = [...adj.get(n)];
    const groups = TYPES
      .map((t) => [t, nb.filter((m) => m.type === t).sort((a, b) => a.issue - b.issue || a.title.localeCompare(b.title))])
      .filter(([, g]) => g.length);
    const ego = egoGraph(n);
    const domains = (n.domains || []).map((id) => byId.get(id));
    const field = fieldOf(n);
    panel.innerHTML = `
      <div class="tab">◆ 03 — ${TYPE_LABEL[n.type]}</div>
      <button class="close btn" data-close aria-label="Close note">×</button>
      <div class="scroll">
        <div class="meta">
          <span class="eyebrow">${TYPE_NUM[n.type]} ${TYPE_LABEL[n.type]}</span>
          <span class="iss">${issueLabel(n)}${field !== undefined ? ` · Field ${String(field + 1).padStart(2, '0')}` : ''}</span>
        </div>
        <h2>${esc(n.title)}</h2>
        ${n.claim ? `<p class="claim">${esc(n.claim)}</p>` : ''}
        ${n.type === 'source' ? `<p class="byline">${esc(n.author || '')}${n.date ? ` · ${esc(n.date)}` : ''}</p>` : ''}
        ${n.url ? `<a class="essay" href="${esc(n.url)}" target="_blank" rel="noopener">Read the essay ↗</a>` : ''}
        ${domains.length ? `<div class="chips">${domains.map((d) => `<button class="chip" data-id="${d.id}">${glyph(d)}${esc(d.title)}</button>`).join('')}</div>` : ''}
        <h3>Fig. 01 — Local graph <span>2D</span></h3>
        <figure class="fig crop">
          ${ego.svg}
          <figcaption id="ego-caption" data-default="${esc(ego.caption)}">${esc(ego.caption)}</figcaption>
        </figure>
        <section class="conn">
          ${groups.map(([t, g]) => `
            <h3>${TYPE_PLURAL[t]} <span>n=${g.length}</span></h3>
            <ul>${g.map((m) => `<li><button data-id="${m.id}">${glyph(m)}<span>${esc(m.title)}</span><span class="iss">${pad(m.issue)}</span></button></li>`).join('')}</ul>`).join('')}
        </section>
      </div>`;
  }

  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return select(null);
    const b = e.target.closest('[data-id]');
    if (b) select(byId.get(+b.dataset.id));
  });
  // Hovering anything in the card lights the same note up in the big diagram.
  panel.addEventListener('mouseover', (e) => {
    const b = e.target.closest('[data-id]');
    const n = b ? byId.get(+b.dataset.id) : null;
    if (n === state.hover) return;
    state.hover = n;
    refresh();
    const svg = panel.querySelector('.fig svg');
    const cap = panel.querySelector('#ego-caption');
    if (!svg) return;
    svg.classList.toggle('hovering', !!n && !!b.closest('svg'));
    for (const p of svg.querySelectorAll('.chords path')) p.classList.toggle('on', !!n && (+p.dataset.a === n.id || +p.dataset.b === n.id));
    cap.innerHTML = n ? `<b>${esc(n.title)}</b>${TYPE_NUM[n.type]} ${TYPE_LABEL[n.type]} · ${issueLabel(n)}` : esc(cap.dataset.default);
  });
  panel.addEventListener('mouseleave', () => {
    state.hover = null;
    refresh();
  });

  // ---------- search ----------
  const input = $('#q');
  const list = $('#results');
  let results = [];
  let active = -1;

  function renderResults() {
    const open = !!input.value.trim();
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    list.innerHTML = results.length
      ? results.map((n, i) => `<li role="option" id="r${i}" aria-selected="${i === active}"><button tabindex="-1" data-id="${n.id}">${glyph(n)}<span>${esc(n.title)}</span><em>${TYPE_LABEL[n.type]}</em></button></li>`).join('')
      : '<li class="empty">No notes match — n=0</li>';
    if (active >= 0) input.setAttribute('aria-activedescendant', `r${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function choose(n) {
    input.value = '';
    results = [];
    renderResults();
    input.blur();
    select(n);
  }
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results = q
      ? nodes.map((n) => [n, n.title.toLowerCase().indexOf(q)]).filter(([, i]) => i >= 0)
        .sort((a, b) => (a[1] === 0 ? 0 : 1) - (b[1] === 0 ? 0 : 1) || TYPES.indexOf(a[0].type) - TYPES.indexOf(b[0].type) || a[0].title.length - b[0].title.length)
        .slice(0, 8).map(([n]) => n)
      : [];
    active = results.length ? 0 : -1;
    renderResults();
  });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderResults();
    } else if (e.key === 'Enter' && results[active]) {
      choose(results[active]);
    } else if (e.key === 'Escape') {
      input.value = '';
      results = [];
      renderResults();
      input.blur();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120));
  list.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    e.preventDefault();
    choose(byId.get(+b.dataset.id));
  });

  addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === '/') {
      e.preventDefault();
      input.focus();
    } else if (e.key === 'Escape') {
      select(null);
      setLegend(false);
    }
  });

  // ---------- deep links ----------
  const fromHash = () => {
    const title = decodeURIComponent(location.hash.slice(1));
    return title ? nodes.find((n) => n.title === title) : null;
  };
  addEventListener('hashchange', () => {
    const n = fromHash();
    if (n && n !== state.selected) select(n);
  });
  const initial = fromHash();
  if (initial) setTimeout(() => select(initial), 1800);

  syncControls();
  setTimeout(syncLabels, 400);
  requestAnimationFrame(() => $('#loading').classList.add('done'));
}
