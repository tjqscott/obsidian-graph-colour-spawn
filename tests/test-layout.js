"use strict";
const assert = require("node:assert/strict");
const Module = require("module");
const load = Module._load;
Module._load = function (request, ...args) {
  return request === "obsidian" ? { Plugin: class {}, Notice: class {} } : load.call(this, request, ...args);
};
const Plugin = require("../main.js");
Module._load = load;
const t = Plugin._test;
const groups = [90, 3, 40, 60, 30, 7, 70, 112, 9, 30, 2, 1].map((count, index) => ({
  id: `folder-${index}`, key: t.normaliseColour(t.paletteForGroupCount(12)[index]),
  nodes: Array.from({ length: count }, (_, slot) => ({ id: `${index}/${slot}.md`, weight: slot % 50 + 6 })),
}));
const radius = t.wheelRadius(554);
const full = t.generatePayload(groups, radius);
assert.deepEqual(full, t.generatePayload(groups, radius), "initial layout is deterministic");
assert.equal(Object.keys(full).length, groups.flatMap((g) => g.nodes).length);
assert.ok(Object.values(full).flat().every(Number.isFinite));
assert.equal(typeof full.hasOwnProperty, "function", "worker requires a plain object");
const distances = Object.values(full).map(([x, y]) => Math.hypot(x, y));
assert.ok(distances.some((r) => r < radius * 0.1), "the wheel fills its centre");
assert.ok(distances.filter((r) => r < radius * 0.5).length > distances.length * 0.2, "this is a filled disc, not a ring");
for (const group of groups.filter((g) => g.nodes.length < 8)) {
  const points = group.nodes.map((n) => full[n.id]);
  const spread = Math.max(...points.flatMap((a) => points.map((b) => Math.hypot(a[0]-b[0], a[1]-b[1]))));
  assert.ok(spread < radius * 0.35, "tiny categories occupy a neighbouring patch");
}
const sectors = t.wheelSectors(groups);
assert.ok(Math.abs(sectors.reduce((n,s) => n+s.span,0)-2*Math.PI) < 1e-10);
assert.ok(sectors.find((s) => s.group.nodes.length===112).span > sectors.find((s) => s.group.nodes.length===3).span * 30);
const rules = [{ query: 'path:"reference/"', prefix: "reference/", key: "rgb:96cce3" }];
const before = t.groupNodesByColour([{id:"reference/a.md",weight:6}], rules);
const after = t.groupNodesByColour([{id:"reference/a.md",weight:30}], [{...rules[0],key:"rgb:e396ca"}]);
assert.equal(t.groupSignature(before),t.groupSignature(after),"hue/degree changes do not reset positions");
const old = new Map();
for (const group of groups) for (const node of group.nodes) {
  [node.x,node.y] = full[node.id]; old.set(node.id,group.id);
}
const dragged = groups[0].nodes[0]; dragged.x=123456; dragged.y=-98765;
const added = {id:"0/new.md",weight:6}; groups[0].nodes.push(added);
const delta = t.incrementalPayload(groups, old, radius);
assert.equal(delta[dragged.id],false,"manual drags are preserved");
assert.ok(Object.keys(delta).length === old.size+1,"worker retains every existing member");
assert.equal(Object.values(delta).filter(Array.isArray).length,1,"only the new note is repositioned");
const peers = groups[0].nodes.filter((n)=>old.has(n.id)&&n!==dragged);
assert.ok(Math.min(...peers.map((n)=>Math.hypot(n.x-delta[added.id][0],n.y-delta[added.id][1]))) < radius*0.15,"new note spawns beside its live group");
const translated = groups.map((g)=>({...g,nodes:g.nodes.map((n)=>({...n,x:n.x+40000,y:n.y-30000}))}));
const moved = t.incrementalPayload(translated,old,radius)[added.id];
assert.ok(Math.abs(moved[0]-delta[added.id][0]-40000)<1e-6 && Math.abs(moved[1]-delta[added.id][1]+30000)<1e-6,"spawn follows current positions, not the original template");
const messages=[];
const renderer={nodes:[{id:"reference/a.md"},{id:"reference/b.md"}],worker:{postMessage:(m)=>messages.push(m)}};
const plugin=Object.assign(new Plugin(),{configReady:true,colourRules:rules,sessionLinkedPaths:new Set(),state:new WeakMap(),forces:{}});
plugin.renderers=()=>[renderer];plugin.extendRepelSliders=()=>{};plugin.applySessionLinkedColours=()=>false;
plugin.sweep(false);plugin.sweep(false);
renderer.nodes.forEach((n,i)=>{n.x=5000+i*500;n.y=3000});
renderer.nodes.push({id:"reference/c.md"});plugin.sweep(false);plugin.sweep(false);
assert.deepEqual(Object.keys(messages.at(-1).nodes).sort(),["reference/a.md","reference/b.md","reference/c.md"]);
assert.equal(messages.at(-1).nodes["reference/a.md"],false);
assert.ok(messages.every((m)=>!m.forceNode),"plugin never pins or overrides native dragging");
const messageCount=messages.length;plugin.sweep(false);plugin.sweep(false);
assert.equal(messages.length,messageCount,"settled graph gets no repeated nudges");
renderer.nodes.pop();plugin.sweep(false);plugin.sweep(false);
assert.equal(Object.keys(messages.at(-1).nodes).length,2,"deleted nodes leave worker membership");
const config=[{query:'path:"big/"',color:{a:1,rgb:0}},{query:'path:"tiny/"',color:{a:1,rgb:0}}];
assert.deepEqual(t.countColourGroups(config,[{path:"big/a.md"},{path:"big/b.md"},{path:"big/export.html"},{path:"tiny/c.md"}]),[2,1]);
const palette=t.normaliseColourGroups(config,[100,2]);
assert.ok(!t.colourGroupsNeedNormalising(palette,[100,2]),"population palette is stable");
assert.ok(t.colourGroupsNeedNormalising(palette,[2,100]),"relative group sizes affect palette spacing");
console.log("filled wheel, small patches, weighted colours, live spawning and unpinned dragging passed");
