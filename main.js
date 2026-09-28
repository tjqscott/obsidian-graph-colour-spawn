/*
 * Graph Colour Spawn
 *
 * Derived from Graph Spawn by Taylor Scott:
 * https://github.com/tjqscott/obsidian-graph-spawn
 *
 * MIT License
 *
 * Copyright (c) 2026 Taylor Scott
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
"use strict";

const obsidian = require("obsidian");

const NEUTRAL_KEY = "neutral";
const SESSION_DIRECTORY = "reference/sessions/";
const PALETTE_SATURATION = 0.58;
const PALETTE_LIGHTNESS = 0.74;
const SESSION_LINKED_HUE = 36;
const MIN_GRAPH_SCALE = 1 / 128;
const WATCH_MS = 1500;
const CONFIG_WATCH_MS = 15000;
const STABLE_OBSERVATIONS = 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const REPEL_SLIDER_MAX = 40;
// Bound rendered radii (and diameters) to 2:1, not the underlying weights.
const MIN_RENDER_RADIUS = 8;
const MAX_RENDER_RADIUS = MIN_RENDER_RADIUS * 2;
const MIN_RENDER_WEIGHT = (MIN_RENDER_RADIUS / 3) ** 2 - 1;
const MAX_RENDER_WEIGHT = (MAX_RENDER_RADIUS / 3) ** 2 - 1;
const MIDDLE_RENDER_WEIGHT =
  Math.sqrt((MIN_RENDER_WEIGHT + 1) * (MAX_RENDER_WEIGHT + 1)) - 1;

// Vault-specific colour groups the plugin keeps present through Obsidian's own
// settings engine, because direct writes to graph.json race the running app.
const REQUIRED_COLOUR_GROUPS = [
  { query: 'path:"plans/"', rgb: 0xbde396 },
  { query: 'path:"tools/"', rgb: 0xbde396 },
  { query: 'path:"scratch/"', rgb: 0xbde396 },
  { query: 'path:/^[^\\/]+\\.md$/', rgb: 0xbde396 },
  { query: 'path:"tasks.base"', rgb: 0xe3d896 },
];
const REMOVED_QUERIES = ['path:"home.md"'];

function byte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(255, Math.round(number)));
}

function rgbKey(red, green, blue) {
  const channels = [byte(red), byte(green), byte(blue)];
  if (channels.some((channel) => channel === null)) return null;
  return `rgb:${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function normaliseColour(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rgb = Math.trunc(value) & 0xffffff;
    return `rgb:${rgb.toString(16).padStart(6, "0")}`;
  }

  if (typeof value === "string") {
    const colour = value.trim().toLowerCase();
    const hex = colour.match(/^#?([0-9a-f]{6})$/i);
    if (hex) return `rgb:${hex[1].toLowerCase()}`;
    const shortHex = colour.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (shortHex) {
      return `rgb:${shortHex
        .slice(1)
        .map((channel) => channel + channel)
        .join("")
        .toLowerCase()}`;
    }
    const functional = colour.match(
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/
    );
    if (functional) return rgbKey(functional[1], functional[2], functional[3]);
    return null;
  }

  if (!value || typeof value !== "object") return null;

  if (Object.prototype.hasOwnProperty.call(value, "rgb")) {
    const nested = normaliseColour(value.rgb);
    if (nested) return nested;
  }
  if (Array.isArray(value) && value.length >= 3) {
    return rgbKey(value[0], value[1], value[2]);
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "r") &&
    Object.prototype.hasOwnProperty.call(value, "g") &&
    Object.prototype.hasOwnProperty.call(value, "b")
  ) {
    return rgbKey(value.r, value.g, value.b);
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "red") &&
    Object.prototype.hasOwnProperty.call(value, "green") &&
    Object.prototype.hasOwnProperty.call(value, "blue")
  ) {
    return rgbKey(value.red, value.green, value.blue);
  }
  return null;
}

function hslToRgb(hue, saturation = PALETTE_SATURATION, lightness = PALETTE_LIGHTNESS) {
  const h = ((Number(hue) % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(1, Number(saturation) || 0));
  const l = Math.max(0, Math.min(1, Number(lightness) || 0));
  if (!s) {
    const channel = Math.round(l * 255);
    return (channel << 16) | (channel << 8) | channel;
  }

  const spread = s * Math.min(l, 1 - l);
  const hueChannel = (offset) => {
    const channel = (offset + h * 12) % 12;
    return l - spread * Math.max(-1, Math.min(channel - 3, 9 - channel, 1));
  };
  return (byte(hueChannel(0) * 255) << 16) |
    (byte(hueChannel(8) * 255) << 8) |
    byte(hueChannel(4) * 255);
}

function paletteForWeights(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const spans = weights.map((weight) => weight / total * 360);
  // Keep the reserved session hue and folder order stable as the vault grows.
  let cursor = SESSION_LINKED_HUE + spans[spans.length - 1] / 2;
  return spans.map((span) => {
    const rgb = hslToRgb(cursor + span / 2);
    cursor += span;
    return rgb;
  });
}

function paletteForGroupCount(groupCount) {
  return paletteForWeights(Array(Math.max(1, Math.floor(Number(groupCount) || 0))).fill(1));
}

function countColourGroups(groups, files) {
  const indexed = colourGroupsWithQueries(groups);
  const rules = parsePathColourRules({ colorGroups: indexed });
  const counts = new Map(indexed.map((group) => [group.query, 0]));
  for (const file of files || []) {
    // Match the native note graph, including its task board. Attachments do
    // not change every note's hue just because an export was saved.
    if (!/\.(md|base)$/i.test(file.path)) continue;
    const rule = configuredColourRule({ id: file.path }, rules);
    if (rule) counts.set(rule.query, (counts.get(rule.query) || 0) + 1);
  }
  return indexed.map((group) => counts.get(group.query) || 0);
}

function colourGroupsWithQueries(groups) {
  return (Array.isArray(groups) ? groups : []).filter(
    (group) => group && typeof group.query === "string" && group.query.trim()
  );
}

function normaliseColourGroups(groups, counts = null) {
  const indexed = colourGroupsWithQueries(groups);
  const palette = counts
    ? paletteForWeights([...indexed.map((_, index) => Math.max(3, counts[index] || 0)), 3])
    : paletteForGroupCount(indexed.length + 1);
  let index = 0;
  return (Array.isArray(groups) ? groups : []).map((group) => {
    if (!group || typeof group.query !== "string" || !group.query.trim()) return group;
    const currentColour = group.color;
    const colour =
      currentColour && typeof currentColour === "object"
        ? { ...currentColour, rgb: palette[index] }
        : { a: 1, rgb: palette[index] };
    const next = {
      ...group,
      color: colour,
    };
    index += 1;
    return next;
  });
}

function colourGroupsNeedNormalising(groups, counts = null) {
  const source = Array.isArray(groups) ? groups : [];
  const normalised = normaliseColourGroups(source, counts);
  return normalised.some((group, index) => {
    if (!group || typeof group.query !== "string" || !group.query.trim()) return false;
    return normaliseColour(source[index] && source[index].color) !==
      normaliseColour(group.color);
  });
}

function graphConfigNeedsMerge(config, counts = null) {
  const groups = config && Array.isArray(config.colorGroups) ? config.colorGroups : [];
  if (colourGroupsNeedNormalising(groups, counts)) return true;
  if (groups.some((group) => REMOVED_QUERIES.includes(group && group.query))) return true;
  return REQUIRED_COLOUR_GROUPS.some(
    (wanted) => !groups.some((group) => group && group.query === wanted.query)
  );
}

function sessionLinkedRgb(groups) {
  const count = colourGroupsWithQueries(groups).length;
  return paletteForGroupCount(count + 1)[count];
}

function colourKeyToRgb(key) {
  const match = typeof key === "string" && key.match(/^rgb:([0-9a-f]{6})$/);
  return match ? parseInt(match[1], 16) : null;
}

function colourHue(key) {
  const match = typeof key === "string" && key.match(/^rgb:([0-9a-f]{6})$/);
  if (!match) return null;

  const red = parseInt(match[1].slice(0, 2), 16) / 255;
  const green = parseInt(match[1].slice(2, 4), 16) / 255;
  const blue = parseInt(match[1].slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const delta = maximum - Math.min(red, green, blue);
  if (!delta) return null;

  let hue;
  if (maximum === red) hue = ((green - blue) / delta) % 6;
  else if (maximum === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function parsePathColourRules(config) {
  const groups = config && Array.isArray(config.colorGroups) ? config.colorGroups : [];
  return groups.flatMap((group) => {
    const query = group && typeof group.query === "string" ? group.query.trim() : "";
    const key = normaliseColour(group && group.color);
    if (!key) return [];

    const literal = query.match(/^path:\s*"([^"]+)"$/i);
    if (literal) return [{ prefix: literal[1].replace(/^\/+/, ""), key, query }];

    const regex = query.match(/^path:\s*\/(.+)\/$/i);
    if (regex) {
      try {
        return [{ pattern: new RegExp(regex[1]), key, query }];
      } catch (_) {
        return [];
      }
    }
    return [];
  });
}

function stableId(node) {
  return String(node && node.id !== undefined ? node.id : "");
}

function normaliseVaultPath(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .replace(/#.*/, "");
}

function buildSessionLinkedPaths(resolvedLinks) {
  const paths = new Set();
  if (!resolvedLinks || typeof resolvedLinks !== "object") return paths;

  for (const [source, links] of Object.entries(resolvedLinks)) {
    if (!normaliseVaultPath(source).startsWith(SESSION_DIRECTORY)) continue;
    for (const target of Object.keys(links || {})) {
      const path = normaliseVaultPath(target);
      if (path) paths.add(path);
    }
  }
  return paths;
}

function configuredColourRule(node, rules) {
  const id = normaliseVaultPath(stableId(node));
  return (Array.isArray(rules) ? rules : []).find((candidate) =>
    candidate.prefix ? id.startsWith(candidate.prefix) : candidate.pattern.test(id)
  );
}

function configuredColourKey(node, rules) {
  const rule = configuredColourRule(node, rules);
  return rule ? rule.key : null;
}

function isSessionLinkedNode(node, sessionLinkedPaths) {
  return Boolean(
    sessionLinkedPaths &&
      typeof sessionLinkedPaths.has === "function" &&
      sessionLinkedPaths.has(normaliseVaultPath(stableId(node)))
  );
}

function extractColourKey(
  node,
  rules = [],
  sessionLinkedPaths = new Set(),
  sessionLinkedKey = normaliseColour(sessionLinkedRgb([]))
) {
  if (!node || typeof node !== "object") return NEUTRAL_KEY;

  // A path group is an explicit user-visible category. Session links can group
  // uncategorised notes, but must not repaint a configured category such as
  // people/ when one of its notes is mentioned in a session.
  const configured = configuredColourKey(node, rules);
  if (configured) return configured;
  if (isSessionLinkedNode(node, sessionLinkedPaths)) return sessionLinkedKey;

  const colour = node.color;
  if (colour && typeof colour === "object" && "rgb" in colour) {
    const preferred = normaliseColour(colour.rgb);
    if (preferred) return preferred;
  }
  return normaliseColour(colour) || NEUTRAL_KEY;
}

function groupNodesByColour(
  nodes,
  rules = [],
  sessionLinkedPaths = new Set(),
  sessionLinkedKey = normaliseColour(sessionLinkedRgb([]))
) {
  const buckets = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const key = extractColourKey(node, rules, sessionLinkedPaths, sessionLinkedKey);
    const rule = configuredColourRule(node, rules);
    const id = rule ? rule.query : isSessionLinkedNode(node, sessionLinkedPaths) ? "session-linked" : key;
    if (!buckets.has(id)) buckets.set(id, { id, key, nodes: [] });
    buckets.get(id).nodes.push(node);
  }
  return [...buckets.values()].map((group) => ({ ...group,
    nodes: group.nodes.sort((a, b) => stableId(a).localeCompare(stableId(b))),
  })).sort((a, b) => (colourHue(a.key) ?? 360) - (colourHue(b.key) ?? 360));
}

function groupSignature(groups) {
  // Colour or link-degree changes must never reset hand-positioned notes.
  return JSON.stringify(groups.map((group) => [group.id || group.key,
    group.nodes.map(stableId)]).sort((a, b) => a[0].localeCompare(b[0])));
}

function wheelSectors(groups) {
  const ordered = [...groups].sort((a, b) => (colourHue(a.key) ?? 360) - (colourHue(b.key) ?? 360));
  const total = ordered.reduce((sum, group) => sum + group.nodes.length, 0) || 1;
  let cursor = 0;
  const sectors = ordered.map((group) => {
    const span = Math.PI * 2 * group.nodes.length / total;
    const sector = { group, start: cursor, span, angle: cursor + span / 2 };
    cursor += span;
    return sector;
  });
  // One rotation aligns the population-sized sectors with their colour hues.
  let x = 0, y = 0;
  for (const sector of sectors) {
    const difference = ((colourHue(sector.group.key) ?? 0) - 90) * Math.PI / 180 - sector.angle;
    x += Math.cos(difference) * sector.group.nodes.length;
    y += Math.sin(difference) * sector.group.nodes.length;
  }
  const rotation = Math.atan2(y, x);
  return sectors.map((sector) => ({ ...sector, start: sector.start + rotation, angle: sector.angle + rotation }));
}

function wheelRadius(count, forces = {}) {
  const repel = Number.isFinite(forces.repelStrength) ? Math.max(1, forces.repelStrength) : 64000;
  const centre = Number.isFinite(forces.centerStrength) ? Math.max(0.002, forces.centerStrength) : 0.1;
  // Seed close to the native force equilibrium, so it settles without the
  // large inward rush that used to fold one colour through another.
  return Math.max(400, Math.sqrt(Math.max(1, count) * repel / centre));
}

function generatePayload(groups, radius = wheelRadius(groups.reduce((n, g) => n + g.nodes.length, 0))) {
  const payload = {};
  const sectors = wheelSectors(groups);
  const count = groups.reduce((sum, group) => sum + group.nodes.length, 0);
  if (!count) return payload;
  const start = sectors[0].start;
  const wrap = (angle) => (angle - start + Math.PI * 8) % (Math.PI * 2);
  let slots = Array.from({ length: count }, (_, index) => {
    const distance = radius * Math.sqrt((index + 0.5) / count);
    const angle = index * GOLDEN_ANGLE;
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, angle: wrap(angle) };
  });
  const assigned = new Map();
  // Tiny categories get neighbouring outer slots, rather than a thin line of
  // dots from centre to edge. Large categories fill the remaining disc.
  for (const sector of sectors.filter((entry) => entry.group.nodes.length < 8)) {
    const cx = Math.cos(sector.angle) * radius * 0.87;
    const cy = Math.sin(sector.angle) * radius * 0.87;
    slots.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    assigned.set(sector.group.id || sector.group.key, slots.splice(0, sector.group.nodes.length));
  }
  slots.sort((a, b) => a.angle - b.angle);
  for (const sector of sectors) {
    const key = sector.group.id || sector.group.key;
    if (!assigned.has(key)) assigned.set(key, slots.splice(0, sector.group.nodes.length));
    // Avoid placing every large/hub note in the centre. A stable path hash
    // distributes visible sizes naturally within each colour's space.
    const nodes = sector.group.nodes.slice().sort((a, b) => hashString(stableId(a)) - hashString(stableId(b)) || stableId(a).localeCompare(stableId(b)));
    assigned.get(key).forEach((slot, index) => { payload[nodes[index].id] = [slot.x, slot.y]; });
  }
  return payload;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function incrementalPayload(groups, previousKeys, radius) {
  const all = groups.flatMap((group) => group.nodes);
  const established = all.filter((node) => previousKeys.has(stableId(node)) && Number.isFinite(node.x) && Number.isFinite(node.y));
  if (!established.length) return generatePayload(groups, radius);
  const cx = median(established.map((node) => node.x));
  const cy = median(established.map((node) => node.y));
  const distances = established.map((node) => Math.hypot(node.x - cx, node.y - cy)).sort((a, b) => a - b);
  const liveRadius = Math.max(400, distances[Math.floor(distances.length * 0.9)] / Math.sqrt(0.9));
  const spacing = liveRadius * Math.sqrt(Math.PI / Math.max(1, established.length));
  const occupied = established.map((node) => [node.x, node.y]);
  const payload = {};
  for (const sector of wheelSectors(groups)) {
    const group = sector.group, key = group.id || group.key;
    const peers = group.nodes.filter((node) => previousKeys.get(stableId(node)) === key && Number.isFinite(node.x) && Number.isFinite(node.y));
    const gx = peers.length ? median(peers.map((node) => node.x)) : cx + Math.cos(sector.angle) * liveRadius * 0.85;
    const gy = peers.length ? median(peers.map((node) => node.y)) : cy + Math.sin(sector.angle) * liveRadius * 0.85;
    const reach = Math.max(spacing * 1.5, liveRadius * Math.sqrt(group.nodes.length / all.length) * 0.65);
    for (const node of group.nodes) {
      const id = stableId(node);
      if (previousKeys.get(id) === key) { payload[id] = false; continue; }
      let best = [gx, gy], bestScore = -Infinity;
      const phase = hashString(id) / 4294967296 * Math.PI * 2;
      for (let index = 0; index < 160; index += 1) {
        const distance = reach * Math.sqrt(index / 160);
        const angle = phase + index * GOLDEN_ANGLE;
        const candidate = [gx + Math.cos(angle) * distance, gy + Math.sin(angle) * distance];
        let clearance = Infinity;
        for (const point of occupied) clearance = Math.min(clearance, Math.hypot(candidate[0] - point[0], candidate[1] - point[1]));
        const outside = Math.max(0, Math.hypot(candidate[0] - cx, candidate[1] - cy) - liveRadius);
        const score = Math.min(clearance, spacing * 1.25) - distance * 0.18 - outside * 0.8;
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
      payload[id] = best;
      occupied.push(best);
    }
  }
  // false means "keep its position". Missing an existing ID would delete it
  // from the native worker, which caused the previous streaks on new notes.
  return payload;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nodeWeight(node) {
  const weight = Number(node && node.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function nodeDegree(node) {
  try {
    const related = node && typeof node.getRelated === "function" && node.getRelated();
    return Array.isArray(related) ? related.length : 0;
  } catch (_) {
    return 0;
  }
}

function renderWeightForDegree(degree, minimumDegree, maximumDegree) {
  const minimum = Math.max(0, Number(minimumDegree) || 0);
  const maximum = Math.max(minimum, Number(maximumDegree) || 0);
  const value = Math.max(0, Number(degree) || 0);
  if (maximum === minimum) return MIDDLE_RENDER_WEIGHT;

  const position = Math.max(
    0,
    Math.min(
      1,
      (Math.log(value + 1) - Math.log(minimum + 1)) /
        (Math.log(maximum + 1) - Math.log(minimum + 1))
    )
  );
  return (
    (MIN_RENDER_WEIGHT + 1) *
      Math.pow((MAX_RENDER_WEIGHT + 1) / (MIN_RENDER_WEIGHT + 1), position) -
    1
  );
}

function sizeNodesByDegree(nodes) {
  const entries = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && typeof node === "object")
    .map((node) => ({ node, degree: nodeDegree(node) }));
  if (!entries.length) return false;

  const degrees = entries.map((entry) => entry.degree);
  const minimum = Math.min(...degrees);
  const maximum = Math.max(...degrees);
  let changed = false;
  for (const entry of entries) {
    const weight = renderWeightForDegree(entry.degree, minimum, maximum);
    if (Math.abs(nodeWeight(entry.node) - weight) > 0.0001) {
      entry.node.weight = weight;
      changed = true;
    }
  }
  return changed;
}

class GraphColourSpawnPlugin extends obsidian.Plugin {
  async onload() {
    this.state = new WeakMap();
    this.colourRules = [];
    this.configReady = false;
    this.sessionLinkedPaths = new Set();
    this.sessionOriginalColours = new Map();
    this.sessionLinkedRgb = sessionLinkedRgb([]);
    this.sessionLinkedKey = normaliseColour(this.sessionLinkedRgb);
    this.sessionLinkedPathsReady = false;
    this.sessionIndexTimer = null;
    this.register(() => {
      if (this.sessionIndexTimer !== null) window.clearTimeout(this.sessionIndexTimer);
    });
    const savedData = (await this.loadData()) || {};
    const savedRepel = Number(savedData.repelStrength);
    this.data = Number.isFinite(savedRepel)
      ? { repelStrength: Math.max(0, Math.min(REPEL_SLIDER_MAX, savedRepel)), layoutVersion: savedData.layoutVersion }
      : {};
    await this.saveData(this.data);

    // Plugins load before the workspace restores its views, so a merge written
    // here lands on disk before the graph view reads graph.json. That wins the
    // race that swallowed every external edit to this file.
    await this.mergeGraphConfig(this.data.layoutVersion !== 2);
    this.data.layoutVersion = 2;
    await this.saveData(this.data);

    this.addCommand({
      id: "respawn-colour-groups",
      name: "Respawn colour wheel",
      callback: async () => {
        await this.loadConfiguredColours();
        this.sweep(true);
      },
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (normaliseVaultPath(file && file.path).startsWith(SESSION_DIRECTORY)) {
          this.scheduleSessionLinkedPathsRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          normaliseVaultPath(file && file.path).startsWith(SESSION_DIRECTORY) ||
          normaliseVaultPath(oldPath).startsWith(SESSION_DIRECTORY)
        ) {
          this.scheduleSessionLinkedPathsRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (normaliseVaultPath(file && file.path).startsWith(SESSION_DIRECTORY)) {
          this.scheduleSessionLinkedPathsRefresh();
        }
      })
    );

    this.app.workspace.onLayoutReady(async () => {
      await this.loadConfiguredColours();
      this.refreshSessionLinkedPaths();
      this.sweep(false);
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.sweep(false))
    );
    this.registerInterval(window.setInterval(() => this.sweep(false), WATCH_MS));
    this.registerInterval(
      window.setInterval(async () => {
        await this.loadConfiguredColours();
        this.sweep(false);
      }, CONFIG_WATCH_MS)
    );
  }

  scheduleSessionLinkedPathsRefresh() {
    if (this.sessionIndexTimer !== null) return;
    this.sessionIndexTimer = window.setTimeout(() => {
      this.sessionIndexTimer = null;
      this.refreshSessionLinkedPaths();
    }, 100);
  }

  refreshSessionLinkedPaths(sweep = true) {
    try {
      const next = buildSessionLinkedPaths(this.app.metadataCache.resolvedLinks);
      const changed =
        next.size !== this.sessionLinkedPaths.size ||
        [...next].some((path) => !this.sessionLinkedPaths.has(path));
      this.sessionLinkedPaths = next;
      this.sessionLinkedPathsReady = true;
      if (changed && sweep) this.sweep(false);
    } catch (_) {
      // Metadata is a public API, but it can be unavailable while Obsidian starts.
      this.sessionLinkedPaths = new Set();
      this.sessionLinkedPathsReady = true;
    }
  }

  setSessionLinkedColour(groups) {
    this.sessionLinkedRgb = sessionLinkedRgb(groups);
    this.sessionLinkedKey = normaliseColour(this.sessionLinkedRgb);
  }

  applySessionLinkedColours(nodes) {
    let changed = false;
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== "object") continue;
      const path = normaliseVaultPath(stableId(node));
      const shouldUseSessionColour =
        isSessionLinkedNode(node, this.sessionLinkedPaths) &&
        !configuredColourKey(node, this.colourRules);
      if (shouldUseSessionColour) {
        if (!this.sessionOriginalColours.has(path)) {
          this.sessionOriginalColours.set(path, node.color);
        }
        if (normaliseColour(node.color) !== this.sessionLinkedKey) {
          node.color = { a: 1, rgb: this.sessionLinkedRgb };
          changed = true;
        }
      } else if (this.sessionOriginalColours.has(path)) {
        node.color = this.sessionOriginalColours.get(path);
        this.sessionOriginalColours.delete(path);
        changed = true;
      }
    }
    return changed;
  }

  async mergeGraphConfig(restoreScale = false) {
    try {
      const configPath = `${this.app.vault.configDir}/graph.json`;
      const config = JSON.parse(await this.app.vault.adapter.read(configPath));
      const groups = Array.isArray(config.colorGroups) ? config.colorGroups : [];

      config.colorGroups = groups.filter(
        (group) => !REMOVED_QUERIES.includes(group && group.query)
      );
      for (const wanted of REQUIRED_COLOUR_GROUPS) {
        if (!config.colorGroups.some((group) => group && group.query === wanted.query)) {
          config.colorGroups.push({
            query: wanted.query,
            color: { a: 1, rgb: 0 },
          });
        }
      }

      const counts = countColourGroups(config.colorGroups, this.app.vault.getFiles());
      config.colorGroups = normaliseColourGroups(config.colorGroups, counts);
      if (restoreScale) config.scale = 0.03;
      this.setSessionLinkedColour(config.colorGroups);

      await this.app.vault.adapter.write(
        configPath,
        JSON.stringify(config, null, 2)
      );
      this.syncNativeColours(config.colorGroups);
    } catch (_) {
      // Never block plugin load on a config merge.
    }
  }

  async loadConfiguredColours() {
    try {
      const configPath = `${this.app.vault.configDir}/graph.json`;
      const contents = await this.app.vault.adapter.read(configPath);
      let config = JSON.parse(contents);
      if (graphConfigNeedsMerge(config, countColourGroups(config.colorGroups, this.app.vault.getFiles()))) {
        await this.mergeGraphConfig();
        config = JSON.parse(await this.app.vault.adapter.read(configPath));
      }
      this.setSessionLinkedColour(config.colorGroups);
      this.colourRules = parsePathColourRules(config);
      this.syncNativeColours(config.colorGroups);

      const slider = Number(config.centerStrength);
      this.forces = {
        centerStrength: (Math.pow(0.01, 1 - (Number.isFinite(slider) ? slider : 0.5)) - 0.01) / 0.99,
        repelStrength: Math.pow(Number(config.repelStrength) || 20, 3),
      };
    } catch (_) {
      this.colourRules = [];
      this.forces = {};
    } finally {
      this.configReady = true;
    }
  }

  syncNativeColours(groups) {
    // Keep native painting and spawn classification on the same palette.
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type) || []) {
        const view = leaf.view;
        const engine = view && (view.dataEngine || view.engine);
        if (!engine || typeof engine.getOptions !== "function" || typeof engine.setOptions !== "function") continue;
        const options = engine.getOptions();
        if (JSON.stringify(options.colorGroups) === JSON.stringify(groups)) continue;
        engine.setOptions({ ...options, colorGroups: groups });
        if (typeof view.onOptionsChange === "function") view.onOptionsChange();
      }
    }
  }

  renderers() {
    const found = [];
    try {
      for (const type of ["graph", "localgraph"]) {
        const leaves = this.app.workspace.getLeavesOfType(type) || [];
        for (const leaf of leaves) {
          const renderer = leaf && leaf.view && leaf.view.renderer;
          if (
            renderer &&
            renderer.worker &&
            typeof renderer.worker.postMessage === "function" &&
            Array.isArray(renderer.nodes) &&
            renderer.nodes.length
          ) {
            found.push(renderer);
          }
        }
      }
    } catch (_) {
      // Obsidian's graph renderer is private API. A changed shape is harmless.
    }
    return found;
  }

  extendRepelSliders() {
    try {
      for (const type of ["graph", "localgraph"]) {
        const leaves = this.app.workspace.getLeavesOfType(type) || [];
        for (const leaf of leaves) {
          const view = leaf && leaf.view;
          const roots = [
            view && view.engine && view.engine.forceOptions && view.engine.forceOptions.el,
            view && view.containerEl,
          ];
          const slider = roots
            .filter(Boolean)
            .map((root) => root.querySelector('input[type="range"].slider[max="20"]'))
            .find(Boolean);
          if (!slider) continue;

          slider.max = String(REPEL_SLIDER_MAX);
          if (!slider.graphColourSpawnListening) {
            slider.addEventListener("input", () => {
              const value = Number(slider.valueAsNumber);
              if (!Number.isFinite(value)) return;
              this.data.repelStrength = Math.max(
                0,
                Math.min(REPEL_SLIDER_MAX, value)
              );
              void this.saveData(this.data);
            });
            slider.graphColourSpawnListening = true;
          }

          const preferred = Number(this.data.repelStrength);
          if (
            Number.isFinite(preferred) &&
            preferred > 20 &&
            slider.valueAsNumber !== preferred
          ) {
            slider.valueAsNumber = preferred;
            slider.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
    } catch (_) {
      // The graph controls are private Obsidian UI. Leave the native cap alone
      // if a future version changes the control shape.
    }
  }

  interceptRefresh(renderer) {
    // Hook the shared renderer prototype so newly opened graph views are covered
    // before their first data update too. Plain-object renderers use themselves.
    let owner = renderer;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, "setData")) {
      owner = Object.getPrototypeOf(owner);
    }
    if (!owner || typeof owner.setData !== "function") return;
    if (!this.refreshHooks) this.refreshHooks = new Map();
    if (this.refreshHooks.has(owner)) return;

    const plugin = this;
    const descriptor = Object.getOwnPropertyDescriptor(owner, "setData");
    const original = owner.setData;
    let active = true;
    function setData(...args) {
      if (!active || !plugin.configReady || !this.worker || !Array.isArray(this.nodes)) {
        return original.apply(this, args);
      }
      const renderer = this;
      const worker = renderer.worker;
      const postDescriptor = Object.getOwnPropertyDescriptor(worker, "postMessage");
      const postMessage = worker.postMessage;
      let prepared = false;
      plugin.refreshSessionLinkedPaths(false);
      // Native setData assigns weights and random positions, then sends its
      // worker update. Correct both at that boundary, before any frame can paint.
      function postRefresh(message, ...rest) {
        if (message && message.nodes) {
          try {
            const update = plugin.prepareRenderer(renderer, false, true);
            prepared = true;
            if (update && update.payload) {
              message = { ...message, nodes: update.payload, alpha: update.initial ? 0.6 : 0.08 };
            }
          } catch (_) {
            // Keep native updates working if Obsidian changes its private API.
          }
        }
        return postMessage.call(this, message, ...rest);
      }
      worker.postMessage = postRefresh;
      try {
        const result = original.apply(renderer, args);
        // Colour-only refreshes may not send a worker update, but can still
        // overwrite session colours or weights before the next paint.
        if (!prepared) {
          try {
            const update = plugin.prepareRenderer(renderer, false, true);
            if (update && update.payload) {
              postMessage.call(worker, { nodes: update.payload, alpha: update.initial ? 0.6 : 0.08, run: true });
            }
          } catch (_) {
            // The periodic sweep remains a fallback for changed internals.
          }
        }
        return result;
      } finally {
        if (postDescriptor) Object.defineProperty(worker, "postMessage", postDescriptor);
        else delete worker.postMessage;
      }
    }
    Object.defineProperty(owner, "setData", { ...descriptor, value: setData });
    this.refreshHooks.set(owner, setData);
    this.register(() => {
      active = false;
      if (owner.setData === setData) Object.defineProperty(owner, "setData", descriptor);
      this.refreshHooks.delete(owner);
    });
  }

  prepareRenderer(renderer, force, immediate = false) {
    const resized = sizeNodesByDegree(renderer.nodes);
    const recoloured = this.applySessionLinkedColours(renderer.nodes);
    if ((resized || recoloured) && typeof renderer.changed === "function") renderer.changed();
    const groups = groupNodesByColour(
      renderer.nodes, this.colourRules, this.sessionLinkedPaths, this.sessionLinkedKey
    );
    if (!groups.length) {
      this.state.delete(renderer);
      return null;
    }
    const signature = groupSignature(groups);
    const previous = this.state.get(renderer) || {
      observedSignature: null, observationCount: 0, appliedSignature: null,
    };
    if (!force && signature === previous.appliedSignature) return null;
    const observationCount = signature === previous.observedSignature ? previous.observationCount + 1 : 1;
    if (!force && !immediate && observationCount < STABLE_OBSERVATIONS) {
      this.state.set(renderer, { ...previous, observedSignature: signature, observationCount });
      return null;
    }
    const assignedKeys = new Map();
    for (const group of groups) {
      for (const node of group.nodes) assignedKeys.set(stableId(node), group.id || group.key);
    }
    const radius = wheelRadius(renderer.nodes.length, this.forces);
    const initial = force || !previous.assignedKeys;
    const payload = initial ? generatePayload(groups, radius) : incrementalPayload(groups, previous.assignedKeys, radius);
    const touched = Object.values(payload).filter(Array.isArray).length;
    const removed = previous.assignedKeys && [...previous.assignedKeys.keys()].some((id) => !assignedKeys.has(id));
    // The renderer must agree with the worker immediately, before the next
    // simulation response supplies its coordinates.
    for (const node of renderer.nodes) {
      const position = payload[stableId(node)];
      if (Array.isArray(position)) [node.x, node.y] = position;
    }
    this.state.set(renderer, { observedSignature: signature, observationCount,
      appliedSignature: signature, assignedKeys });
    return { payload: touched || removed ? payload : null, touched, groups: groups.length, initial };
  }

  sweep(force) {
    if (!this.configReady) return;

    this.extendRepelSliders();
    const renderers = this.renderers();
    if (!renderers.length) {
      if (force) new obsidian.Notice("Graph Colour Spawn: no graph view open");
      return;
    }

    let seededNodes = 0;
    let seededGroups = 0;
    for (const renderer of renderers) {
      try {
        this.interceptRefresh(renderer);
        const update = this.prepareRenderer(renderer, force);
        if (!update) continue;
        if (update.payload) {
          renderer.worker.postMessage({
            nodes: update.payload,
            alpha: update.initial ? 0.6 : 0.08,
            run: true,
          });
        }
        seededNodes += update.touched;
        seededGroups += update.groups;
      } catch (_) {
        // Leave a renderer alone if its undocumented internals have changed.
      }
    }

    if (force) {
      new obsidian.Notice(
        seededNodes
          ? `Graph Colour Spawn: ${seededGroups} groups, ${seededNodes} nodes respawned`
          : "Graph Colour Spawn: graph not ready yet"
      );
    }
  }
}

GraphColourSpawnPlugin._test = {
  NEUTRAL_KEY,
  PALETTE_SATURATION,
  PALETTE_LIGHTNESS,
  SESSION_LINKED_HUE,
  normaliseColour,
  hslToRgb,
  paletteForGroupCount,
  paletteForWeights,
  countColourGroups,
  colourGroupsWithQueries,
  normaliseColourGroups,
  colourGroupsNeedNormalising,
  graphConfigNeedsMerge,
  sessionLinkedRgb,
  colourKeyToRgb,
  normaliseVaultPath,
  buildSessionLinkedPaths,
  colourHue,
  parsePathColourRules,
  configuredColourKey,
  isSessionLinkedNode,
  extractColourKey,
  groupNodesByColour,
  groupSignature,
  nodeWeight,
  nodeDegree,
  renderWeightForDegree,
  sizeNodesByDegree,
  generatePayload,
  wheelRadius,
  wheelSectors,
  incrementalPayload,
};

module.exports = GraphColourSpawnPlugin;
