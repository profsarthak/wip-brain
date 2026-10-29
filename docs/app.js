import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const TYPES = ['domain', 'mechanism', 'source'];
const TYPE_LABEL = { domain: 'Domain', mechanism: 'Mechanism', source: 'Essay' };
const TYPE_PLURAL = { domain: 'Domains', mechanism: 'Mechanisms', source: 'Essays' };
// [saturation, lightness] per note type: domains glow hardest, essays read as pale "inputs".
const TONE = { domain: [88, 70], mechanism: [74, 60], source: [38, 86] };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hsl = (h, s, l) => `hsl(${h}, ${s}%, ${l}%)`;
const jitter = () => (Math.random() - 0.5) * 12;

try {
  await main();
} catch (err) {
  console.error(err);
  $('#loading').classList.add('error');
  $('#loading span').textContent = `Couldn't start the visualisation (${err.message}). It needs a browser with WebGL enabled.`;
}

async function main() {
  const data = await fetch('graph.json').then((r) => {
    if (!r.ok) throw new Error(`graph.json: HTTP ${r.status}`);
    return r.json();
  });

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

  const hues = new Map(data.domainOrder.map((id, i) => [id, Math.round((205 + (i * 360) / data.domainOrder.length) % 360)]));
  const hueOf = (n) => hues.get(n.domain) ?? 40;
  const colorOf = (n) => hsl(hueOf(n), ...TONE[n.type]);
  const linkHue = (l) => hueOf(l.source.type === 'mechanism' ? l.source : l.target);
  const issueLabel = (n) => (n.type === 'source' ? `Issue ${n.issue}` : `Since issue ${n.issue}`);
  const valOf = (n) => (n.type === 'domain' ? 30 + n.deg * 0.4 : n.type === 'source' ? 1.4 + n.deg * 0.3 : 0.7 + n.deg * 0.45);

  const state = { issue: data.issues, types: { domain: true, mechanism: true, source: true }, mode: '3d', hover: null, selected: null };
  const hl = { focus: null, nodes: new Set(), links: new Set() };
  let visibleLinks = links;

  function visibleData() {
    const vis = nodes.filter((n) => n.issue <= state.issue && state.types[n.type]);
    const on = new Set(vis);
    for (const n of vis) {
      if (state.mode === '2d') { delete n.z; delete n.vz; }
      if (n.x === undefined) {
        // Newly revealed notes sprout next to a note that's already on screen.
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

  // A hidden domain's HTML label can outlive its 3D object (it showed up as doubled labels during
  // timeline playback), so sweep labels once the graph has digested each update. Domains with only
  // a handful of notes on screen get a faint label so early timeline frames aren't a pile of text.
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
  }
  function updateGraph() {
    Graph.graphData(visibleData());
    for (const ms of [50, 400]) setTimeout(syncLabels, ms);
  }
  const isVisible = (n) => n.issue <= state.issue && state.types[n.type];

  // ---------- scene ----------
  const labelEls = new Map();
  const domainLabel = (n) => {
    if (n.type !== 'domain') return null;
    const el = document.createElement('div');
    el.className = 'dlabel';
    el.style.setProperty('--c', colorOf(n));
    el.innerHTML = `<span>${esc(n.title)}</span>`;
    labelEls.get(n)?.remove();
    labelEls.set(n, el);
    return new CSS2DObject(el);
  };
  const nodeColor = (n) => {
    if (n === hl.focus) return hsl(hueOf(n), 95, 86);
    if (hl.focus && !hl.nodes.has(n)) return hsl(hueOf(n), 18, 14);
    return colorOf(n);
  };
  const linkColor = (l) => {
    if (hl.links.has(l)) return hsl(linkHue(l), 85, 74);
    return hl.focus ? hsl(linkHue(l), 15, 8) : hsl(linkHue(l), 45, 30);
  };

  const Graph = new ForceGraph3D($('#graph'), { controlType: 'orbit', extraRenderers: [new CSS2DRenderer()] })
    .width(innerWidth)
    .height(innerHeight)
    .backgroundColor('#05060a')
    .showNavInfo(false)
    .nodeRelSize(2.4)
    .nodeVal(valOf)
    .nodeResolution(12)
    .nodeOpacity(0.95)
    .nodeColor(nodeColor)
    .nodeLabel((n) => `<div class="tip"><span style="color:${colorOf(n)}">${TYPE_LABEL[n.type]} · ${issueLabel(n)}</span>${esc(n.title)}</div>`)
    .nodeThreeObjectExtend(true)
    .nodeThreeObject(domainLabel)
    .linkColor(linkColor)
    .linkOpacity(0.55)
    .linkWidth((l) => (hl.links.has(l) ? 0.6 : 0))
    .linkDirectionalParticles((l) => (hl.links.has(l) ? 2 : 0))
    .linkDirectionalParticleWidth(1.5)
    .linkDirectionalParticleSpeed(0.007)
    .linkDirectionalParticleColor((l) => hsl(linkHue(l), 90, 82))
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
  Graph.renderer().setPixelRatio(Math.min(devicePixelRatio, 1.75));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.95, 0.4, 0.1);
  Graph.postProcessingComposer().addPass(bloom);

  function applyForces() {
    Graph.d3Force('charge').strength(state.mode === '3d' ? -48 : -32).distanceMax(500);
    Graph.d3Force('link').distance((l) => (l.source.type === 'domain' || l.target.type === 'domain' ? 70 : 30));
  }
  applyForces();

  const controls = Graph.controls();
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, autoRotate: !reducedMotion, autoRotateSpeed: 0.35 });
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

  addEventListener('resize', () => {
    Graph.width(innerWidth).height(innerHeight);
    bloom.setSize(innerWidth, innerHeight);
  });

  // Ambient "neural firing": sparks run along random visible connections while nothing is focused.
  if (!reducedMotion) {
    setInterval(() => {
      if (document.hidden || hl.focus || !visibleLinks.length) return;
      for (let k = 0; k < 3; k++) Graph.emitParticle(visibleLinks[(Math.random() * visibleLinks.length) | 0]);
    }, 160);
  }

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
      Graph.nodeColor(Graph.nodeColor())
        .linkColor(Graph.linkColor())
        .linkWidth(Graph.linkWidth())
        .linkDirectionalParticles(Graph.linkDirectionalParticles());
      for (const [n, el] of labelEls) el.classList.toggle('dim', !!f && !hl.nodes.has(n));
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
    const d = camDistance();
    if (mode === '2d') {
      controls.autoRotate = false;
      controls.enableRotate = false;
      controls.screenSpacePanning = true;
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.PAN;
      Graph.cameraPosition({ x: 0, y: 0, z: Math.max(d, 700) }, { x: 0, y: 0, z: 0 }, 1000);
      // Squash z to 0 over a second while the layout keeps running, then hand over to a 2D simulation.
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
      controls.enableRotate = true;
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      // Start from a nearly flat sheet; repulsion inflates it back into a 3D brain.
      for (const n of nodes) {
        n.z = (Math.random() - 0.5) * 6;
        n.vz = 0;
      }
      Graph.numDimensions(3);
      applyForces();
      const far = Math.max(d, 700);
      Graph.cameraPosition({ x: far * 0.55, y: far * 0.2, z: far * 0.8 }, { x: 0, y: 0, z: 0 }, 1200);
      if (!state.selected) setTimeout(fitSoon, 1300);
    }
  }

  // ---------- timeline ----------
  const range = $('#issue');
  range.max = data.issues;
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
    const shown = Graph.graphData().nodes.length;
    $('#tl-label').innerHTML = `<b>Issue ${state.issue}</b> / ${data.issues} · ${shown} notes`;
    $('#play').classList.toggle('playing', !!playTimer);
    $('#play').setAttribute('aria-label', playTimer ? 'Pause' : 'Play the brain growing issue by issue');
    for (const b of document.querySelectorAll('#types button')) b.setAttribute('aria-pressed', String(state.types[b.dataset.type]));
    for (const b of document.querySelectorAll('#view button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
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
  $('#fit').addEventListener('click', () => Graph.zoomToFit(900, 40));

  // ---------- header + legend ----------
  const c = data.counts;
  $('#stats').textContent = `${c.notes} notes · ${c.links.toLocaleString()} links · Issues 1–${data.issues}`;
  $('#updated').textContent = `Updated ${new Date(data.generated).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`;

  $('#types').innerHTML = TYPES.map((t) => `
    <button data-type="${t}" aria-pressed="true">
      <b><i class="glyph ${t}"></i>${TYPE_PLURAL[t]}</b><span>${c[`${t}s`]}</span>
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
  domainList.innerHTML = data.domainOrder.map((id) => byId.get(id)).map((d) => `
    <li><button data-id="${d.id}" style="--c:${colorOf(d)}"><i class="dot"></i><span>${esc(d.title)}</span><span class="count">${members.get(d.id) || 0}</span></button></li>`).join('');
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

  // ---------- note panel with 2D local graph ----------
  const panel = $('#panel');

  function egoGraph(n) {
    const nb = [...adj.get(n)].sort((a, b) =>
      TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || hueOf(a) - hueOf(b) || a.title.localeCompare(b.title));
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
    const r = nb.length > 70 ? 2.6 : nb.length > 30 ? 3.4 : 4.6;
    const spokes = nb.map((m) => `<line x1="${C}" y1="${C}" x2="${f(pt.get(m)[0])}" y2="${f(pt.get(m)[1])}" stroke="${colorOf(m)}"/>`).join('');
    const dots = nb.map((m) => {
      const [x, y] = pt.get(m);
      const rr = m.type === 'domain' ? r * 1.7 : r;
      const mark = m.type === 'source'
        ? `<circle cx="${f(x)}" cy="${f(y)}" r="${rr}" fill="#05060a" stroke="${colorOf(m)}" stroke-width="1.4"/>`
        : `<circle cx="${f(x)}" cy="${f(y)}" r="${rr}" fill="${colorOf(m)}"/>`;
      return `<g data-id="${m.id}">${mark}<circle class="hit" cx="${f(x)}" cy="${f(y)}" r="${Math.max(rr + 3, 8)}"/></g>`;
    }).join('');
    const svg = `
      <svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Local graph: ${nb.length} notes connected to ${esc(n.title)}">
        <defs><radialGradient id="ego-glow"><stop offset="0" stop-color="${colorOf(n)}" stop-opacity=".6"/><stop offset="1" stop-color="${colorOf(n)}" stop-opacity="0"/></radialGradient></defs>
        <g class="chords">${chords}</g>
        <g class="spokes">${spokes}</g>
        <circle cx="${C}" cy="${C}" r="38" fill="url(#ego-glow)"/>
        <circle cx="${C}" cy="${C}" r="9" fill="${colorOf(n)}"/>
        <g class="dots">${dots}</g>
      </svg>`;
    const caption = `${nb.length} direct connections · ${chordCount} links among them`;
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
    panel.style.setProperty('--c', colorOf(n));
    panel.innerHTML = `
      <button class="close" data-close aria-label="Close note">×</button>
      <div class="panel-meta"><i class="dot sm"></i>${TYPE_LABEL[n.type]} · ${issueLabel(n)}</div>
      <h2>${esc(n.title)}</h2>
      ${n.claim ? `<p class="claim">${esc(n.claim)}</p>` : ''}
      ${n.type === 'source' ? `<p class="byline">${esc(n.author || '')}${n.date ? ` · ${esc(n.date)}` : ''}</p>` : ''}
      ${n.url ? `<a class="essay" href="${esc(n.url)}" target="_blank" rel="noopener">Read the essay on worksinprogress.co ↗</a>` : ''}
      ${domains.length ? `<div class="chips">${domains.map((d) => `<button class="chip" data-id="${d.id}" style="--c:${colorOf(d)}"><i class="dot sm"></i>${esc(d.title)}</button>`).join('')}</div>` : ''}
      <section class="ego">
        <h3>Local graph <span>2D</span></h3>
        ${ego.svg}
        <p class="ego-caption" id="ego-caption" data-default="${esc(ego.caption)}">${esc(ego.caption)}</p>
      </section>
      <section class="conn">
        ${groups.map(([t, g]) => `
          <h3>${TYPE_PLURAL[t]} <span>${g.length}</span></h3>
          <ul>${g.map((m) => `<li><button data-id="${m.id}" style="--c:${colorOf(m)}"><i class="dot sm"></i><span>${esc(m.title)}</span><span class="iss">#${m.issue}</span></button></li>`).join('')}</ul>`).join('')}
      </section>`;
    panel.scrollTop = 0;
  }

  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return select(null);
    const b = e.target.closest('[data-id]');
    if (b) select(byId.get(+b.dataset.id));
  });
  // Hovering anything in the panel lights the same note up in the big graph.
  panel.addEventListener('mouseover', (e) => {
    const b = e.target.closest('[data-id]');
    const n = b ? byId.get(+b.dataset.id) : null;
    if (n === state.hover) return;
    state.hover = n;
    refresh();
    const svg = panel.querySelector('.ego svg');
    const cap = panel.querySelector('#ego-caption');
    if (!svg) return;
    svg.classList.toggle('hovering', !!n && !!b.closest('svg'));
    for (const p of svg.querySelectorAll('.chords path')) p.classList.toggle('on', !!n && (+p.dataset.a === n.id || +p.dataset.b === n.id));
    cap.innerHTML = n ? `<b>${esc(n.title)}</b>${TYPE_LABEL[n.type]} · ${issueLabel(n)}` : esc(cap.dataset.default);
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
      ? results.map((n, i) => `<li role="option" id="r${i}" aria-selected="${i === active}"><button tabindex="-1" data-id="${n.id}" style="--c:${colorOf(n)}"><i class="dot sm"></i><span>${esc(n.title)}</span><em>${TYPE_LABEL[n.type]}</em></button></li>`).join('')
      : '<li class="empty">No notes match</li>';
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
