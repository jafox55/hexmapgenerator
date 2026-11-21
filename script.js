'use strict';

// ---------- Settings ----------
const MIN_PER_TERRAIN = 2;   // every terrain must show up at least this many times
const MAX_ATTEMPTS = 25;     // rebuild the map if the minimum can't be met
const CLASHES = { Desert: 'Tundra', Tundra: 'Desert' }; // pairs that should never touch
const END_RANGE = 0.85;      // end can be any tile at least 85% as far as the farthest one
const MAX_REGION = 6;        // most tiles of one terrain allowed in a single connected group

// Axial directions for pointy-top hexes.
const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

const key = (q, r) => `${q},${r}`;
const faceOf = (cell) => (cell.showingA ? cell.tile.sideA : cell.tile.sideB);
const backOf = (cell) => (cell.showingA ? cell.tile.sideB : cell.tile.sideA);

// ---------- Generation ----------

// All hex positions exactly n steps from the center.
function ringCells(n) {
  if (n === 0) return [[0, 0]];
  const cells = [];
  let q = HEX_DIRS[4][0] * n;
  let r = HEX_DIRS[4][1] * n;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < n; step++) {
      cells.push([q, r]);
      q += HEX_DIRS[side][0];
      r += HEX_DIRS[side][1];
    }
  }
  return cells;
}

function neighborsOf(map, q, r) {
  const out = [];
  for (const [dq, dr] of HEX_DIRS) {
    const cell = map.get(key(q + dq, r + dr));
    if (cell) out.push(cell);
  }
  return out;
}

// Size of the connected same-terrain group a tile would join if it showed `terrain` at (q, r).
// Counts every group it touches, since placing it can merge two groups into one.
function regionSizeIfPlaced(map, q, r, terrain) {
  const seen = new Set([key(q, r)]);
  const group = neighborsOf(map, q, r).filter((c) => faceOf(c) === terrain);
  for (const c of group) seen.add(key(c.q, c.r));
  for (let i = 0; i < group.length; i++) {
    for (const n of neighborsOf(map, group[i].q, group[i].r)) {
      const k = key(n.q, n.r);
      if (!seen.has(k) && faceOf(n) === terrain) { seen.add(k); group.push(n); }
    }
  }
  return group.length + 1;
}

// Size of the biggest connected same-terrain group on the map.
function largestRegion(map) {
  const seen = new Set();
  let largest = 0;
  for (const [k, cell] of map) {
    if (seen.has(k)) continue;
    const terrain = faceOf(cell);
    const group = [cell];
    seen.add(k);
    for (let i = 0; i < group.length; i++) {
      for (const n of neighborsOf(map, group[i].q, group[i].r)) {
        const nk = key(n.q, n.r);
        if (!seen.has(nk) && faceOf(n) === terrain) { seen.add(nk); group.push(n); }
      }
    }
    largest = Math.max(largest, group.length);
  }
  return largest;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Keep only the items with the top score for each rule in turn, then pick one at random.
function pickBest(items, rules, rng) {
  let pool = items;
  for (const score of rules) {
    if (pool.length <= 1) break;
    let best = -Infinity;
    let next = [];
    for (const item of pool) {
      const s = score(item);
      if (s > best) { best = s; next = [item]; }
      else if (s === best) next.push(item);
    }
    pool = next;
  }
  return pool[Math.floor(rng() * pool.length)];
}

// Scoring rules shared by placement and by the minimum-count fix.
function terrainRules(terrain, terrains, map, posOf) {
  const related = new Set(terrains[terrain].neighbors);
  const clash = CLASHES[terrain];
  const around = (item) => { const [q, r] = posOf(item); return neighborsOf(map, q, r); };
  return [
    (item) => { const [q, r] = posOf(item); return regionSizeIfPlaced(map, q, r, terrain) <= MAX_REGION ? 1 : 0; },
    (item) => (clash && around(item).some((c) => faceOf(c) === clash) ? 0 : 1),
    (item) => around(item).filter((c) => faceOf(c) === terrain).length,
    (item) => around(item).filter((c) => related.has(faceOf(c))).length,
  ];
}

function buildMap(data, tileCount, rng) {
  const deck = shuffle(data.tiles.slice(), rng)
    .slice(0, tileCount)
    .map((tile) => ({ tile, showingA: rng() < 0.5 }));

  const map = new Map();
  let ring = 0;
  let open = ringCells(0);
  let skipped = 0;    // tiles sent to the bottom of the pile in a row
  let oversize = 0;   // tiles placed even though they broke the region limit

  const fitsSomewhere = (terrain) =>
    open.some(([q, r]) => regionSizeIfPlaced(map, q, r, terrain) <= MAX_REGION);

  while (deck.length > 0) {
    if (open.length === 0) {
      ring += 1;
      open = ringCells(ring);
    }
    const drawn = deck.shift();

    // Region limit: if this side can't go anywhere, try the other side,
    // then the bottom of the pile. Only if no remaining tile fits is the limit broken.
    if (!fitsSomewhere(faceOf(drawn))) {
      drawn.showingA = !drawn.showingA;
      if (!fitsSomewhere(faceOf(drawn))) {
        drawn.showingA = !drawn.showingA;
        if (skipped < deck.length) { deck.push(drawn); skipped += 1; continue; }
        oversize += 1;
      }
    }
    skipped = 0;

    const terrain = faceOf(drawn);
    const spot = pickBest(open, terrainRules(terrain, data.terrains, map, (p) => p), rng);
    open = open.filter((p) => p !== spot);
    map.set(key(spot[0], spot[1]), { ...drawn, q: spot[0], r: spot[1], ring, fixed: false });
  }
  return { map, rings: ring + 1, oversize };
}

function countTerrains(map, names) {
  const counts = Object.fromEntries(names.map((n) => [n, 0]));
  for (const cell of map.values()) counts[faceOf(cell)] += 1;
  return counts;
}

// Flip tiles until every terrain appears at least `min` times. Returns flips made, or -1 if impossible.
function ensureMinimum(map, terrains, min, rng) {
  const names = Object.keys(terrains);
  let flips = 0;
  for (let guard = 0; guard < 200; guard++) {
    const counts = countTerrains(map, names);
    const short = names.filter((n) => counts[n] < min).sort((a, b) => counts[a] - counts[b]);
    if (short.length === 0) return flips;

    const need = short[0];
    const candidates = [...map.values()].filter(
      (c) => backOf(c) === need && counts[faceOf(c)] > min
    );
    if (candidates.length === 0) return -1;

    const rules = terrainRules(need, terrains, map, (c) => [c.q, c.r]);
    rules.push((c) => counts[faceOf(c)]); // prefer taking from the most common terrain
    const pick = pickBest(candidates, rules, rng);
    pick.showingA = !pick.showingA;
    pick.fixed = true;
    flips += 1;
  }
  return -1;
}

// ---------- Start and end points ----------

// Tiles on the map's edge: anything missing at least one neighbor.
function edgeCells(map) {
  return [...map.values()].filter((c) => neighborsOf(map, c.q, c.r).length < 6);
}

// Fastest travel time (in hours) from one tile to every other tile.
// Moving onto a tile costs that tile's hours; the starting tile is free.
function travelTimes(map, terrains, startKey) {
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  for (;;) {
    let current = null;
    let best = Infinity;
    for (const [k, d] of dist) {
      if (!done.has(k) && d < best) { best = d; current = k; }
    }
    if (current === null) break;
    done.add(current);
    const cell = map.get(current);
    for (const n of neighborsOf(map, cell.q, cell.r)) {
      const nk = key(n.q, n.r);
      const nd = best + terrains[faceOf(n)].hours;
      if (!dist.has(nk) || nd < dist.get(nk)) { dist.set(nk, nd); prev.set(nk, current); }
    }
  }
  return { dist, prev };
}

// Start on a random edge tile. The end goes far from it:
//  1. Each tile's distance is the fastest time to reach its border (its own hours aren't counted),
//     so costly terrain doesn't win just for being costly.
//  2. Every tile at least END_RANGE as far as the farthest one is a candidate.
//  3. Pick a candidate at random, weighted by each terrain's endWeight in tiles.json.
function chooseEndpoints(map, terrains, rng) {
  const edges = edgeCells(map);
  const start = edges[Math.floor(rng() * edges.length)];
  const startKey = key(start.q, start.r);
  const { dist } = travelTimes(map, terrains, startKey);

  const scored = [];
  let max = 0;
  for (const [k, d] of dist) {
    if (k === startKey) continue;
    const score = d - terrains[faceOf(map.get(k))].hours;
    scored.push([k, score]);
    max = Math.max(max, score);
  }
  const candidates = scored.filter(([, s]) => s >= max * END_RANGE).map(([k]) => k);
  const weightOf = (k) => terrains[faceOf(map.get(k))].endWeight ?? 1;
  const total = candidates.reduce((sum, k) => sum + weightOf(k), 0);
  let roll = rng() * total;
  let end = candidates[candidates.length - 1];
  for (const k of candidates) {
    roll -= weightOf(k);
    if (roll < 0) { end = k; break; }
  }
  return { start: startKey, end };
}

function generateMap(data, tileCount, rng = Math.random) {
  let fallback = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { map, rings } = buildMap(data, tileCount, rng);
    const flips = ensureMinimum(map, data.terrains, MIN_PER_TERRAIN, rng);
    if (flips < 0) continue;
    const result = { map, rings, flips, attempt };
    if (largestRegion(map) <= MAX_REGION) {
      return { ...result, ...chooseEndpoints(map, data.terrains, rng) };
    }
    fallback = fallback || result; // keep one in case no try meets every rule
  }
  if (fallback) return { ...fallback, ...chooseEndpoints(fallback.map, data.terrains, rng) };
  throw new Error(`Could not reach ${MIN_PER_TERRAIN} of every terrain after ${MAX_ATTEMPTS} tries.`);
}

// ---------- Map codes ----------
// A code like K7Q2M9 rebuilds the same map. Its first letter also says how many tiles
// the map uses. "-2", "-3"... at the end picks a different start and end on the same map.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1, which are easy to misread
const CODE_SIZES = [80, 60, 40];

// Seeded random numbers, so the same code always gives the same map.
function seededRng(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newCode(tileCount) {
  const sizeIndex = CODE_SIZES.indexOf(tileCount);
  const firsts = [...CODE_CHARS].filter((_, i) => i % CODE_SIZES.length === sizeIndex);
  let code = firsts[Math.floor(Math.random() * firsts.length)];
  for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

// Returns { base, variant, tileCount, code } or null if the text isn't a valid code.
function parseCode(text) {
  const clean = String(text).toUpperCase().replace(/\s+/g, '');
  const match = clean.match(/^([A-Z2-9]{6})(?:-(\d{1,3}))?$/);
  if (!match || [...match[1]].some((ch) => !CODE_CHARS.includes(ch))) return null;
  const variant = match[2] ? Number(match[2]) : 1;
  if (variant < 1) return null;
  const base = match[1];
  const tileCount = CODE_SIZES[CODE_CHARS.indexOf(base[0]) % CODE_SIZES.length];
  return { base, variant, tileCount, code: variant > 1 ? `${base}-${variant}` : base };
}

function mapFromCode(data, parsed) {
  const result = generateMap(data, parsed.tileCount, seededRng(parsed.base));
  if (parsed.variant > 1) {
    Object.assign(result, chooseEndpoints(result.map, data.terrains, seededRng(`${parsed.base}#${parsed.variant}`)));
  }
  return result;
}

// ---------- Build order ----------
// Tiles go down from the center outward, ring by ring, clockwise. Every tile touches
// one already on the table, so players always know where it goes.

const CLOCKWISE = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const DIRECTION_WORDS = {
  '1,0': 'to the right of',
  '-1,0': 'to the left of',
  '1,-1': 'above and to the right of',
  '0,-1': 'above and to the left of',
  '0,1': 'below and to the right of',
  '-1,1': 'below and to the left of',
};

// Ring n walked clockwise, starting at its top-left corner.
function clockwiseRing(n) {
  if (n === 0) return [[0, 0]];
  const cells = [];
  let q = 0;
  let r = -n;
  for (const [dq, dr] of CLOCKWISE) {
    for (let i = 0; i < n; i++) {
      cells.push([q, r]);
      q += dq;
      r += dr;
    }
  }
  return cells;
}

const ringOf = (cell) => (Math.abs(cell.q) + Math.abs(cell.r) + Math.abs(cell.q + cell.r)) / 2;

function buildSteps(map) {
  const order = [];
  for (let n = 0; ; n++) {
    const ring = clockwiseRing(n).map(([q, r]) => key(q, r));
    const present = ring.map((k) => map.has(k));
    if (!present.some(Boolean)) break;
    // Where the ring can start: anywhere on a full ring, or just after a gap on a partly
    // filled one so its tiles come in unbroken runs. Prefer a start that touches the last tile.
    const full = present.every(Boolean);
    const starts = ring
      .map((_, i) => i)
      .filter((i) => present[i] && (full || !present[(i - 1 + ring.length) % ring.length]));
    const last = order.length ? map.get(order[order.length - 1].key) : null;
    const touchesLast = (i) => last && neighborsOf(map, last.q, last.r).some((c) => key(c.q, c.r) === ring[i]);
    const first = starts.find(touchesLast) ?? starts[0];
    for (let i = 0; i < ring.length; i++) {
      const k = ring[(first + i) % ring.length];
      if (map.has(k)) order.push({ key: k, ring: n });
    }
  }

  // Where each tile goes: next to the last tile when it touches it,
  // otherwise next to a tile already down (preferring the inner ring).
  const placed = new Set();
  const directionFrom = (fromKey, toKey) => {
    const a = map.get(fromKey);
    const b = map.get(toKey);
    return DIRECTION_WORDS[`${b.q - a.q},${b.r - a.r}`];
  };
  return order.map((s, i) => {
    let ref = null;
    if (i > 0) {
      const prev = order[i - 1].key;
      const dir = directionFrom(prev, s.key);
      if (dir) {
        ref = { key: prev, dir, previous: true };
      } else {
        const c = map.get(s.key);
        const anchor = neighborsOf(map, c.q, c.r)
          .filter((n) => placed.has(key(n.q, n.r)))
          .sort((a, b) => ringOf(a) - ringOf(b))[0];
        const anchorKey = key(anchor.q, anchor.r);
        ref = { key: anchorKey, dir: directionFrom(anchorKey, s.key), previous: false };
      }
    }
    placed.add(s.key);
    return { ...s, ringStart: i === 0 || order[i - 1].ring !== s.ring, ref };
  });
}

const pileName = (tile) => `${tile.sideA} / ${tile.sideB}`;

// How many tiles of each pair a map needs, in the order the pairs appear in tiles.json.
function pullList(data, map) {
  const counts = new Map(data.tiles.map((t) => [pileName(t), 0]));
  for (const cell of map.values()) counts.set(pileName(cell.tile), counts.get(pileName(cell.tile)) + 1);
  return [...counts].filter(([, n]) => n > 0);
}

// ---------- Drawing ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEX_SIZE = 10;
const state = {
  data: null, result: null, selected: null, travel: null,
  code: null,     // parsed map code for the current map
  edited: false,  // true once a tile is flipped by hand (the code then rebuilds the original)
  build: null,    // { steps, step } while Build mode is on; step -1 is the intro, steps.length is done
};

// Start and end bands share one style: two stripes inside the tile edge.
// Start: orange outside, black inside. End: white outside, black inside.
const MARKERS = {
  start: { stripes: ['#ff7a00', '#1b1a17'], label: 'start point', borderName: 'orange' },
  end: { stripes: ['#ffffff', '#1b1a17'], label: 'end point', borderName: 'black' },
};

// The band runs from the tile edge inward, under the black edge.
const EDGE_WIDTH = 0.6;              // black tile edge (matches style.css)
const MARKER_WIDTH = EDGE_WIDTH * 3; // whole band, 3x the black edge
// The outer stripe is a little wider because the black edge covers its
// outer 0.3 units; this way both stripes show at about the same width.
const STRIPE_SPLIT = 1.05;           // distance in from the edge where the outer stripe ends
const insetRadius = (distance) => HEX_SIZE - distance / Math.cos(Math.PI / 6);

// SVG markup for a tile's start or end band: outer stripe, then inner stripe.
function markerBandMarkup(marker, cx, cy) {
  const [outer, inner] = marker.stripes;
  const stripe = (color, from, to) =>
    `<polygon class="marker-band" points="${hexPoints(cx, cy, insetRadius((from + to) / 2))}" stroke="${color}" stroke-width="${to - from}"/>`;
  return stripe(outer, 0, STRIPE_SPLIT) + stripe(inner, STRIPE_SPLIT, MARKER_WIDTH);
}

// Pink highlight ring: 1.8 units wide, covering the tile's black edge and running
// outward, with a thin dark line only on its outer side.
const outsetRadius = (distance) => HEX_SIZE + distance / Math.cos(Math.PI / 6);
const HIGHLIGHT_RADIUS = outsetRadius(0.6); // pink, from 0.3 inside the edge to 1.5 outside
const HALO_RADIUS = outsetRadius(1.05);     // dark, from the edge to 2.1 outside (shows past the pink)

// Small inline hex with the marker band, for the legend and Build mode.
function markerKey(marker) {
  return `<svg class="marker-key" viewBox="-10.5 -10.5 21 21" aria-hidden="true">
    <polygon points="${hexPoints(0, 0)}" fill="#fffdf7"/>
    ${markerBandMarkup(marker, 0, 0)}
    <polygon points="${hexPoints(0, 0)}" fill="none" stroke="#3b352b" stroke-width="${EDGE_WIDTH}" stroke-linejoin="round"/>
  </svg>`;
}

function markerAt(k) {
  if (k === state.result.start) return MARKERS.start;
  if (k === state.result.end) return MARKERS.end;
  return null;
}

const ICON_SIZE = 11;                     // every icon fills the same square (hex radius is 10)
const ICON_DARK = '#1f1e1b';
const ICON_LIGHT = '#ffffff';

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Dark or white icon, whichever stands out more against the tile color.
function iconColorFor(tileColor) {
  return contrast(tileColor, ICON_DARK) >= contrast(tileColor, ICON_LIGHT) ? ICON_DARK : ICON_LIGHT;
}

const iconId = (terrain) => `icon-${terrain.toLowerCase().replace(/\s+/g, '-')}`;

// One alpha mask per terrain, built from its icon file, so each icon can be drawn in any color.
function buildIconDefs(terrains) {
  const holder = document.createElementNS(SVG_NS, 'svg');
  holder.setAttribute('class', 'icon-defs');
  holder.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(SVG_NS, 'defs');
  for (const [name, info] of Object.entries(terrains)) {
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', iconId(name));
    mask.setAttribute('maskUnits', 'objectBoundingBox');
    mask.setAttribute('maskContentUnits', 'objectBoundingBox');
    mask.setAttribute('x', '0'); mask.setAttribute('y', '0');
    mask.setAttribute('width', '1'); mask.setAttribute('height', '1');
    mask.style.maskType = 'alpha';
    const img = document.createElementNS(SVG_NS, 'image');
    img.setAttribute('href', info.icon);
    img.setAttribute('width', '1'); img.setAttribute('height', '1');
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    mask.append(img);
    defs.append(mask);
  }
  holder.append(defs);
  document.body.prepend(holder);
}

// A square filled with the icon color and cut to the icon's shape.
// "iconRaise" in tiles.json lifts an icon that looks low (hex units; the tile's radius is 10).
function iconShape(terrain, tileColor, cx, cy, size) {
  const lift = (state.data?.terrains[terrain]?.iconRaise || 0) * (size / ICON_SIZE);
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', (cx - size / 2).toFixed(2));
  rect.setAttribute('y', (cy - size / 2 - lift).toFixed(2));
  rect.setAttribute('width', size);
  rect.setAttribute('height', size);
  rect.setAttribute('fill', iconColorFor(tileColor));
  rect.setAttribute('mask', `url(#${iconId(terrain)})`);
  rect.setAttribute('class', 'icon');
  return rect;
}

function hexCenter(q, r) {
  return [HEX_SIZE * Math.sqrt(3) * (q + r / 2), HEX_SIZE * 1.5 * r];
}

function hexPoints(cx, cy, radius = HEX_SIZE) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(cx + radius * Math.cos(a)).toFixed(2)},${(cy + radius * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function renderMap() {
  const svg = document.getElementById('map');
  const { map } = state.result;
  const { terrains } = state.data;
  svg.replaceChildren();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const frag = document.createDocumentFragment();

  for (const [k, cell] of map) {
    const terrain = faceOf(cell);
    const info = terrains[terrain];
    const [cx, cy] = hexCenter(cell.q, cell.r);
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `hex${state.selected === k ? ' selected' : ''}${buildClass(k)}`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    const marker = markerAt(k);
    g.setAttribute('aria-label', `${terrain}, ${info.hours} hours${marker ? `, ${marker.label}` : ''}`);
    g.dataset.key = k;

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${terrain} (${info.hours} h)${marker ? `, ${marker.label}` : ''}`;

    const fill = document.createElementNS(SVG_NS, 'polygon');
    fill.setAttribute('points', hexPoints(cx, cy));
    fill.setAttribute('fill', info.color);
    fill.setAttribute('class', 'fill');
    g.append(title, fill);

    if (marker) {
      const band = document.createElementNS(SVG_NS, 'g');
      band.innerHTML = markerBandMarkup(marker, cx, cy);
      g.append(...band.children);
    }

    const edge = document.createElementNS(SVG_NS, 'polygon');
    edge.setAttribute('points', hexPoints(cx, cy));
    edge.setAttribute('class', 'edge');
    g.append(iconShape(terrain, info.color, cx, cy, ICON_SIZE), edge);

    // A highlighted tile gets a pink outline over its edge, with a dark line around the
    // outside so it shows on light and dark tiles. It stays clear of the start or end border.
    if (state.selected === k || currentBuildKey() === k) {
      for (const [cls, radius] of [['halo', HALO_RADIUS], ['highlight', HIGHLIGHT_RADIUS]]) {
        const ring = document.createElementNS(SVG_NS, 'polygon');
        ring.setAttribute('points', hexPoints(cx, cy, radius));
        ring.setAttribute('class', cls);
        g.append(ring);
      }
    }
    frag.append(g);
  }

  // Draw outlined tiles last so their outlines sit on top.
  const current = currentBuildKey();
  const onTop = current
    ? [state.build.steps[state.build.step].ref?.key, current]
    : [state.selected];
  for (const k of onTop) {
    const g = k && frag.querySelector(`[data-key="${k}"]`);
    if (g) frag.append(g);
  }

  // One pink ring for keyboard focus, drawn above every tile and moved by showFocusRing().
  const ring = document.createElementNS(SVG_NS, 'g');
  ring.setAttribute('id', 'focus-ring');
  ring.setAttribute('class', 'hex focus-ring');
  ring.setAttribute('aria-hidden', 'true');
  ring.style.display = 'none';
  for (const cls of ['halo', 'highlight']) {
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('class', cls);
    ring.append(poly);
  }
  frag.append(ring);
  svg.append(frag);

  const pad = HEX_SIZE * 1.55;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  svg.setAttribute('viewBox', `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`);
}

function renderLegend() {
  const { terrains } = state.data;
  const counts = countTerrains(state.result.map, Object.keys(terrains));
  const list = document.getElementById('legend');
  list.replaceChildren();
  for (const [name, info] of Object.entries(terrains)) {
    const li = document.createElement('li');
    const low = counts[name] < MIN_PER_TERRAIN;
    li.innerHTML = `
      <span class="name">${name}</span>
      <span class="count${low ? ' low' : ''}">${counts[name]}</span>`;

    const swatch = document.createElementNS(SVG_NS, 'svg');
    swatch.setAttribute('class', 'swatch');
    swatch.setAttribute('viewBox', '-10.5 -10.5 21 21');
    swatch.setAttribute('aria-hidden', 'true');
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', hexPoints(0, 0));
    poly.setAttribute('fill', info.color);
    swatch.append(poly, iconShape(name, info.color, 0, 0, ICON_SIZE));
    li.prepend(swatch);
    list.append(li);
  }
}


// A hex swatch with the terrain's icon, used in the legend-style spots of the page.
function terrainSwatch(name, cls = 'swatch') {
  const info = state.data.terrains[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '-10.5 -10.5 21 21');
  svg.setAttribute('aria-hidden', 'true');
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', hexPoints(0, 0));
  poly.setAttribute('fill', info.color);
  svg.append(poly, iconShape(name, info.color, 0, 0, ICON_SIZE));
  return svg;
}

function renderCode() {
  document.getElementById('map-code').textContent = state.code.code;
  document.getElementById('code-note').textContent = state.edited
    ? 'You flipped tiles by hand, so this code rebuilds the map as it was before your flips.'
    : '';
}

function tilePreview(cell) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'tile-preview');
  svg.setAttribute('viewBox', '-10.5 -10.5 21 21');
  svg.setAttribute('aria-hidden', 'true');

  if (cell) {
    const points = hexPoints(0, 0).split(' ');
    const face = faceOf(cell);
    const back = backOf(cell);
    const faceInfo = state.data.terrains[face];
    const backInfo = state.data.terrains[back];
    const left = document.createElementNS(SVG_NS, 'polygon');
    left.setAttribute('points', [points[5], points[4], points[3], points[2]].join(' '));
    left.setAttribute('fill', faceInfo.color);
    const right = document.createElementNS(SVG_NS, 'polygon');
    right.setAttribute('points', [points[5], points[0], points[1], points[2]].join(' '));
    right.setAttribute('fill', backInfo.color);

    const divider = document.createElementNS(SVG_NS, 'line');
    divider.setAttribute('x1', '0');
    divider.setAttribute('y1', '-10');
    divider.setAttribute('x2', '0');
    divider.setAttribute('y2', '10');
    divider.setAttribute('stroke', '#3b352b');
    divider.setAttribute('stroke-width', EDGE_WIDTH);

    svg.append(
      left,
      right,
      iconShape(face, faceInfo.color, -4.3, 0, 6.8),
      iconShape(back, backInfo.color, 4.3, 0, 6.8),
      divider,
    );
  }

  const outline = document.createElementNS(SVG_NS, 'polygon');
  outline.setAttribute('points', hexPoints(0, 0));
  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', '#3b352b');
  outline.setAttribute('stroke-width', EDGE_WIDTH);
  svg.append(outline);
  return svg;
}

function updateTilePreviewSize() {
  const map = document.getElementById('map');
  if (!map?.viewBox.baseVal.width || !map.viewBox.baseVal.height) return;
  const rect = map.getBoundingClientRect();
  const scale = Math.min(
    rect.width / map.viewBox.baseVal.width,
    rect.height / map.viewBox.baseVal.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return;
  const size = `${21 * scale}px`;
  document.querySelectorAll('.tile-preview').forEach((preview) => {
    preview.style.width = size;
    preview.style.height = size;
  });
}

function renderTileInfo() {
  const box = document.getElementById('tile-info');
  const cell = state.selected && state.result.map.get(state.selected);
  if (!cell) {
    const row = document.createElement('div');
    row.className = 'row';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Tap a tile to see its other side or flip it.';
    row.append(tilePreview(null), hint);
    box.replaceChildren(row);
    updateTilePreviewSize();
    return;
  }
  const face = faceOf(cell);
  const back = backOf(cell);
  const marker = markerAt(state.selected);
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('p');
  text.innerHTML = `<strong>Tile #${cell.tile.id}</strong>${marker ? ` (${marker.label})` : ''}: ${face} / ${back}`;
  const flip = document.createElement('button');
  flip.type = 'button';
  flip.id = 'flip';
  flip.textContent = 'Flip tile';
  row.append(tilePreview(cell), text, flip);
  box.replaceChildren(row);
  updateTilePreviewSize();
  flip.addEventListener('click', () => {
    cell.showingA = !cell.showingA;
    state.edited = true;
    renderAll();
  });
}

// ---------- Build mode ----------

function currentBuildKey() {
  const b = state.build;
  return b && b.step >= 0 && b.step < b.steps.length ? b.steps[b.step].key : null;
}

function buildClass(k) {
  const b = state.build;
  if (!b || b.step < 0 || b.step >= b.steps.length) return '';
  const index = b.indexOf.get(k);
  if (index === b.step) return ' current';
  if (k === b.steps[b.step].ref?.key) return ' placed anchor';
  return index < b.step ? ' placed' : ' upcoming';
}

function startBuild() {
  const steps = buildSteps(state.result.map);
  state.build = { steps, step: -1, indexOf: new Map(steps.map((s, i) => [s.key, i])) };
  state.selected = null;
  renderAll();
  document.getElementById('build-panel').scrollIntoView({ block: 'nearest' });
  document.querySelector('#build-panel [data-action="start"]')?.focus();
}

function setBuildStep(step) {
  const b = state.build;
  const wasPlacing = b.step >= 0 && b.step < b.steps.length;
  b.step = Math.max(-1, Math.min(step, b.steps.length));
  renderMap();
  renderBuildPanel();
  // Coming from the intro, bring the map to the top so it sits above the step panel.
  if (!wasPlacing && b.step >= 0 && b.step < b.steps.length) window.scrollTo({ top: 0 });
}

function renderBuildPanel() {
  const panel = document.getElementById('build-panel');
  const status = document.getElementById('build-status');
  const b = state.build;
  document.body.classList.toggle('building', Boolean(b));
  if (!b) {
    panel.hidden = true;
    panel.replaceChildren();
    status.textContent = '';
    return;
  }
  panel.hidden = false;
  panel.classList.toggle('intro', b.step < 0 || b.step >= b.steps.length);
  const focused = document.activeElement?.dataset?.action;
  const total = b.steps.length;
  const { map } = state.result;

  if (b.step < 0) {
    const usesAll = map.size === state.data.tiles.length;
    const pulls = pullList(state.data, map)
      .map(([pile, n]) => `<li><span>${pile}</span><strong>${n}</strong></li>`).join('');
    panel.innerHTML = `
      <h2>Build this map at the table</h2>
      <ol class="build-tips">
        <li>Sort the tiles into piles by pair, such as Plains / Mountains.</li>
        <li>Turn your phone to match the table: tiles point up and icons sit upright.</li>
        <li>Start with the center tile in the middle of your play area, then work outward ring by ring, going clockwise. Each step shows where the tile goes, which pile to take it from and which side faces up.</li>
      </ol>
      ${usesAll
        ? `<p class="pull-all">This map uses all ${map.size} tiles.</p>`
        : `<details class="pulls" open>
             <summary>Tiles to pull from the box (${map.size})</summary>
             <ul class="pull-list">${pulls}</ul>
           </details>`}
      <div class="build-nav">
        <button type="button" data-action="exit">Cancel</button>
        <button type="button" class="primary" data-action="start">Start placing</button>
      </div>`;
    status.textContent = 'Build mode. Sort your tiles, then start placing.';
  } else if (b.step >= total) {
    panel.innerHTML = `
      <h2>Map built</h2>
      <p>All ${total} tiles are down. Put your meeple on the tile with the orange border and the end token on the tile with the black border.</p>
      <div class="build-nav">
        <button type="button" data-action="back">Back</button>
        <button type="button" class="primary" data-action="exit">Done</button>
      </div>`;
    status.textContent = `Map built. All ${total} tiles placed.`;
  } else {
    const s = b.steps[b.step];
    const cell = map.get(s.key);
    const face = faceOf(cell);
    const pile = pileName(cell.tile);
    const marker = markerAt(s.key);
    const last = b.step === total - 1;
    const where = !s.ref
      ? 'Put it in the middle of your play area.'
      : `Place it ${s.ref.dir} ${s.ref.previous ? 'the last tile' : `the outlined ${faceOf(map.get(s.ref.key))} tile`}.`;
    const ringText = s.ring === 0 ? 'Center tile' : `Ring ${s.ring}`;
    const ringNote = s.ring > 0 && s.ringStart ? `Starting ring ${s.ring}, going clockwise. ` : '';
    panel.innerHTML = `
      <p class="build-progress">Step ${b.step + 1} of ${total} · Tile #${cell.tile.id} · ${ringText}</p>
      <progress max="${total}" value="${b.step + 1}" aria-hidden="true"></progress>
      <div class="build-instruction">
        <div class="build-swatch"></div>
        <div>
          <p class="build-face">Take tile #${cell.tile.id} from the <strong>${pile}</strong> pile, ${face} side up</p>
        </div>
      </div>
      <p class="build-where">${ringNote}${where}</p>
      ${marker ? `<p class="build-marker">${markerKey(marker)} This is the ${marker.label} (${marker.borderName} border).</p>` : ''}
      <div class="build-nav">
        <button type="button" data-action="back"${b.step === 0 ? ' disabled' : ''}>Back</button>
        <button type="button" class="primary" data-action="next">${last ? 'Finish' : 'Next tile'}</button>
      </div>
      <button type="button" class="link" data-action="exit">Exit Build mode</button>`;
    panel.querySelector('.build-swatch').append(terrainSwatch(face, 'swatch big'));
    status.textContent = `Step ${b.step + 1} of ${total}, tile number ${cell.tile.id}, ${ringText}. Take it from the ${pile} pile, ${face} side up. ` +
      `${ringNote}${where}${marker ? ` This is the ${marker.label}.` : ''}`;
  }

  if (focused) {
    const again = panel.querySelector(`[data-action="${focused}"]:not([disabled])`)
      || panel.querySelector('[data-action="next"], [data-action="exit"].primary');
    again?.focus();
  }
}

function exitBuild() {
  state.build = null;
  renderMap();
  renderBuildPanel();
  document.getElementById('start-build').focus();
}

function onBuildPanelClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || !state.build) return;
  const { step } = state.build;
  if (action === 'start') setBuildStep(0);
  else if (action === 'next') setBuildStep(step + 1);
  else if (action === 'back') setBuildStep(step - 1);
  else if (action === 'exit') exitBuild();
}

// ---------- PNG export ----------

const EXPORT_SCALE = 10;
const coloredIconCache = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
}

async function coloredIcon(name, color) {
  const cacheKey = `${name}:${color}`;
  if (coloredIconCache.has(cacheKey)) return coloredIconCache.get(cacheKey);
  const size = ICON_SIZE * EXPORT_SCALE;
  const source = await loadImage(state.data.terrains[name].icon);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, size, size);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  coloredIconCache.set(cacheKey, canvas);
  return canvas;
}

function canvasHexPath(ctx, cx, cy, radius) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

async function exportMapPng() {
  if (!state.result) return;
  const button = document.getElementById('export-png');
  button.disabled = true;
  showCodeMessage('Preparing PNG…');

  try {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cell of state.result.map.values()) {
      const [cx, cy] = hexCenter(cell.q, cell.r);
      minX = Math.min(minX, cx - HEX_SIZE);
      maxX = Math.max(maxX, cx + HEX_SIZE);
      minY = Math.min(minY, cy - HEX_SIZE);
      maxY = Math.max(maxY, cy + HEX_SIZE);
    }

    const pad = HEX_SIZE * 1.15;
    const left = minX - pad;
    const top = minY - pad;
    const width = Math.ceil((maxX - minX + pad * 2) * EXPORT_SCALE);
    const height = Math.ceil((maxY - minY + pad * 2) * EXPORT_SCALE);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    for (const [key, cell] of state.result.map) {
      const [cx, cy] = hexCenter(cell.q, cell.r);
      const px = (cx - left) * EXPORT_SCALE;
      const py = (cy - top) * EXPORT_SCALE;
      const terrain = faceOf(cell);
      const info = state.data.terrains[terrain];

      canvasHexPath(ctx, px, py, HEX_SIZE * EXPORT_SCALE);
      ctx.fillStyle = info.color;
      ctx.fill();

      const marker = markerAt(key);
      if (marker) {
        for (let i = 0; i < marker.stripes.length; i++) {
          const from = i === 0 ? 0 : STRIPE_SPLIT;
          const to = i === 0 ? STRIPE_SPLIT : MARKER_WIDTH;
          const radius = insetRadius((from + to) / 2) * EXPORT_SCALE;
          canvasHexPath(ctx, px, py, radius);
          ctx.strokeStyle = marker.stripes[i];
          ctx.lineWidth = (to - from) * EXPORT_SCALE;
          ctx.lineJoin = 'miter';
          ctx.stroke();
        }
      }

      const icon = await coloredIcon(terrain, iconColorFor(info.color));
      const iconSize = ICON_SIZE * EXPORT_SCALE;
      const lift = (info.iconRaise || 0) * EXPORT_SCALE;
      ctx.drawImage(icon, px - iconSize / 2, py - iconSize / 2 - lift, iconSize, iconSize);

      canvasHexPath(ctx, px, py, HEX_SIZE * EXPORT_SCALE);
      ctx.strokeStyle = '#3b352b';
      ctx.lineWidth = EDGE_WIDTH * EXPORT_SCALE;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create PNG');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.code.code}-wayfarer-map.png`;
    link.click();
    URL.revokeObjectURL(url);
    showCodeMessage(`Exported ${state.code.code} as a PNG.`);
  } catch (err) {
    showCodeMessage(err.message || 'Could not export the PNG.');
  } finally {
    button.disabled = false;
  }
}

// ---------- Page ----------

function renderAll() {
  state.travel = travelTimes(state.result.map, state.data.terrains, state.result.start);
  renderMap();
  renderLegend();
  document.getElementById('summary').textContent = ''; // only used for loading and error messages
  renderCode();
  renderTileInfo();
  renderBuildPanel();
}

function showCodeMessage(text) {
  const message = document.getElementById('code-message');
  message.textContent = text;
  message.style.textAlign = /^Exported |^Preparing PNG/.test(text) ? 'center' : '';
}

function setHash(code) {
  try {
    if (location.hash.slice(1) !== code) location.hash = code;
  } catch (err) { /* some viewers don't allow it; the code is still shown on the page */ }
}

function loadCode(parsed) {
  try {
    state.result = mapFromCode(state.data, parsed);
  } catch (err) {
    document.getElementById('summary').textContent = err.message;
    return;
  }
  state.code = parsed;
  state.edited = false;
  state.selected = null;
  state.build = null;
  document.getElementById('tile-count').value = String(parsed.tileCount);
  renderAll();
  setHash(parsed.code);
}

function generate() {
  const count = Number(document.getElementById('tile-count').value);
  showCodeMessage('');
  loadCode(parseCode(newCode(count)));
}

function newStartAndEnd() {
  if (!state.result) return;
  const parsed = parseCode(`${state.code.base}-${state.code.variant + 1}`);
  Object.assign(state.result, chooseEndpoints(state.result.map, state.data.terrains, seededRng(`${parsed.base}#${parsed.variant}`)));
  state.code = parsed;
  if (state.build) state.build.step = -1;
  renderAll();
  setHash(parsed.code);
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(state.code.code);
    showCodeMessage(`Copied ${state.code.code}.`);
  } catch (err) {
    showCodeMessage(`Couldn't copy here. The code is ${state.code.code}.`);
  }
}

function onCodeSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('code-input');
  const parsed = parseCode(input.value);
  if (!parsed) {
    showCodeMessage('That code isn\'t valid. Codes are 6 letters and numbers, like K7Q2M9, sometimes with -2 or -3 at the end.');
    input.focus();
    return;
  }
  input.value = '';
  showCodeMessage(`Loaded ${parsed.code}.`);
  loadCode(parsed);
}

function onMapActivate(event) {
  const g = event.target.closest('.hex');
  if (!g) return;
  if (state.build) {
    // In Build mode, tapping a tile jumps to its step.
    setBuildStep(state.build.indexOf.get(g.dataset.key));
  } else {
    state.selected = state.selected === g.dataset.key ? null : g.dataset.key;
    renderMap();
    renderTileInfo();
  }
  const again = document.querySelector(`#map [data-key="${g.dataset.key}"]`);
  if (again && event.type === 'keydown') again.focus();
}

// Show the pink ring on a tile reached by keyboard (Tab), and hide it otherwise.
function showFocusRing(event) {
  const ring = document.getElementById('focus-ring');
  if (!ring) return;
  const g = event.type === 'focusin' && event.target.closest('.hex');
  if (!g || !g.matches(':focus-visible')) { ring.style.display = 'none'; return; }
  const cell = state.result.map.get(g.dataset.key);
  const [cx, cy] = hexCenter(cell.q, cell.r);
  const [halo, highlight] = ring.children;
  halo.setAttribute('points', hexPoints(cx, cy, HALO_RADIUS));
  highlight.setAttribute('points', hexPoints(cx, cy, HIGHLIGHT_RADIUS));
  ring.style.display = '';
}

function hashCode() {
  try { return parseCode(decodeURIComponent(location.hash.slice(1))); } catch (err) { return null; }
}

async function init() {
  try {
    const res = await fetch('tiles.json');
    if (!res.ok) throw new Error(res.statusText);
    state.data = await res.json();
    buildIconDefs(state.data.terrains);
    document.getElementById('key-start').innerHTML = markerKey(MARKERS.start);
    document.getElementById('key-end').innerHTML = markerKey(MARKERS.end);
  } catch (err) {
    document.getElementById('summary').textContent =
      'Could not load tiles.json. Open this page through a web server (for example, run "python -m http.server" in this folder) instead of opening the file directly.';
    return;
  }

  document.getElementById('generate').addEventListener('click', generate);
  document.getElementById('reroll-points').addEventListener('click', newStartAndEnd);
  document.getElementById('copy-code').addEventListener('click', copyCode);
  document.getElementById('code-form').addEventListener('submit', onCodeSubmit);
  document.getElementById('export-png').addEventListener('click', exportMapPng);
  document.getElementById('start-build').addEventListener('click', startBuild);
  document.getElementById('build-panel').addEventListener('click', onBuildPanelClick);

  const svg = document.getElementById('map');
  new ResizeObserver(updateTilePreviewSize).observe(svg);
  svg.addEventListener('click', onMapActivate);
  svg.addEventListener('focusin', showFocusRing);
  svg.addEventListener('focusout', showFocusRing);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMapActivate(e); }
  });

  // Arrow keys step through Build mode.
  document.addEventListener('keydown', (e) => {
    if (!state.build || e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); setBuildStep(state.build.step + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setBuildStep(state.build.step - 1); }
  });

  // Opening the page with #CODE (or changing it) loads that map.
  window.addEventListener('hashchange', () => {
    const parsed = hashCode();
    if (parsed && parsed.code !== state.code?.code) loadCode(parsed);
  });

  const fromHash = hashCode();
  if (fromHash) loadCode(fromHash);
  else generate();
}

if (typeof document !== 'undefined') {
  init();
} else if (typeof module !== 'undefined') {
  module.exports = {
    generateMap, buildMap, countTerrains, faceOf, ringCells, travelTimes, edgeCells, largestRegion,
    seededRng, newCode, parseCode, mapFromCode, buildSteps, pullList, pileName,
  };
}
