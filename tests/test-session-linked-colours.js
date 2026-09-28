"use strict";

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return { Plugin: class {}, PluginSettingTab: class {}, Setting: class {} };
  return originalLoad.call(this, request, parent, isMain);
};
const Plugin = require("../main.js");
Module._load = originalLoad;

const {
  buildSessionLinkedPaths,
  colourHue,
  colourGroupsNeedNormalising,
  graphConfigNeedsMerge,
  extractColourKey,
  groupNodesByColour,
  normaliseColour,
  normaliseColourGroups,
  paletteForGroupCount,
  parsePathColourRules,
  sessionLinkedRgb,
} = Plugin._test;

function equal(actual, expected, description) {
  if (actual !== expected) throw new Error(`${description}: expected ${expected}, got ${actual}`);
}

function truthy(value, description) {
  if (!value) throw new Error(description);
}

function approximately(actual, expected, tolerance, description) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${description}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

const rawGroups = [
  { query: 'path:"reference/"', color: { a: 1, rgb: 0x96c2e3 } },
  { query: 'path:"nudges/"', color: { a: 0.42, rgb: 0xe3b896 } },
  { query: 'path:"tools/"', color: { a: 1, rgb: 0xe3b896 } },
];
const repairedGroups = normaliseColourGroups(rawGroups);
const configBeforeRepair = {
  search: "",
  repelStrength: 40,
  colorGroups: rawGroups,
};
const nonColourSettings = JSON.stringify({
  search: configBeforeRepair.search,
  repelStrength: configBeforeRepair.repelStrength,
});
const configAfterRepair = {
  ...configBeforeRepair,
  colorGroups: repairedGroups,
};
const repairedRgb = repairedGroups.map((group) => group.color.rgb);
const sessionKey = normaliseColour(sessionLinkedRgb(repairedGroups));
const rules = parsePathColourRules({ colorGroups: repairedGroups });
const linked = buildSessionLinkedPaths({
  "reference/sessions/2026-09-03.md": {
    "reference/important-source.md": 1,
    "research/derived-output.md": 2,
  },
  "reference/ordinary.md": { "research/ignored.md": 1 },
}, "reference/sessions/");

truthy(colourGroupsNeedNormalising(rawGroups), "duplicate palette needs repair");
truthy(!colourGroupsNeedNormalising(repairedGroups), "repaired palette stays stable");
equal(new Set(repairedRgb).size, repairedRgb.length, "each configured group has a unique colour");
equal(
  repairedGroups[1].color.a,
  rawGroups[1].color.a,
  "palette repair preserves alpha"
);
equal(
  JSON.stringify({
    search: configAfterRepair.search,
    repelStrength: configAfterRepair.repelStrength,
  }),
  nonColourSettings,
  "palette repair preserves non-colour settings"
);
const missingColour = normaliseColourGroups([
  { query: 'path:"new-group/"' },
]);
truthy(
  colourGroupsNeedNormalising([{ query: 'path:"new-group/"' }]),
  "new group without a colour needs repair"
);
equal(
  colourGroupsNeedNormalising(missingColour),
  false,
  "new group receives a stable palette colour"
);
const preset = { addGroups: ['path:"plans/"'], removeQueries: ['path:"home.md"'], sessionFolder: "reference/sessions/" };
truthy(graphConfigNeedsMerge({ colorGroups: [] }, null, preset), "missing required groups need repair");
equal(graphConfigNeedsMerge({ colorGroups: [] }), false, "no preset asks for no groups");
equal(buildSessionLinkedPaths({ "reference/sessions/a.md": { "b.md": 1 } }).size, 0, "no session folder links nothing");
truthy(
  graphConfigNeedsMerge({
    colorGroups: [{ query: 'path:"home.md"', color: { a: 1, rgb: 0 } }],
  }, null, preset),
  "obsolete groups need removal"
);
equal(sessionKey === normaliseColour(repairedRgb[0]), false, "session colour differs from first group");
equal(sessionKey === normaliseColour(repairedRgb[1]), false, "session colour differs from second group");
equal(sessionKey === normaliseColour(repairedRgb[2]), false, "session colour differs from third group");

const palette = paletteForGroupCount(repairedGroups.length + 1);
const hues = palette.map((rgb) => colourHue(normaliseColour(rgb))).sort((left, right) => left - right);
for (let index = 0; index < hues.length; index += 1) {
  const next = hues[(index + 1) % hues.length] + (index === hues.length - 1 ? 360 : 0);
  approximately(next - hues[index], 90, 1.5, "wheel colours are evenly spaced");
}
approximately(colourHue(sessionKey), 36, 1.5, "session-linked colour stays yellow-orange");

equal(linked.has("reference/important-source.md"), true, "session link indexed");
equal(linked.has("research/ignored.md"), false, "non-session link excluded");
equal(
  extractColourKey({ id: "reference/ordinary.md" }, rules, linked, sessionKey),
  normaliseColour(repairedRgb[0]),
  "unlinked reference keeps its wheel colour"
);
equal(
  extractColourKey({ id: "reference/important-source.md" }, rules, linked, sessionKey),
  normaliseColour(repairedRgb[0]),
  "configured path colour wins over the session-linked colour"
);
equal(
  extractColourKey({ id: "research/derived-output.md" }, rules, linked, sessionKey),
  sessionKey,
  "session-linked non-reference receives reserved wheel colour"
);
equal(
  groupNodesByColour(
    [{ id: "reference/ordinary.md" }, { id: "research/derived-output.md" }],
    rules,
    linked,
    sessionKey
  ).length,
  2,
  "session relationship creates its own spawn group for uncategorised notes"
);
console.log("equidistant palette and session-linked classification passed");
