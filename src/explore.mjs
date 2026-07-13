#!/usr/bin/env node
// Exploration script - dump blueprint-related data from a save file
import { readFileSync } from 'fs';
import { join } from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';

const savePath = join('/data/saves', process.argv[2] || 'test.sav');
console.log(`Parsing ${savePath}...`);
const buf = readFileSync(savePath);
const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const save = Parser.ParseSave('save', data);

console.log(`\n=== Save structure ===`);
console.log(`Top-level keys: ${Object.keys(save).join(', ')}`);
console.log(`levels type: ${typeof save.levels}, constructor: ${save.levels?.constructor?.name}`);

// Figure out the levels structure
const levels = save.levels instanceof Map ? [...save.levels.values()]
    : Array.isArray(save.levels) ? save.levels
    : Object.values(save.levels || {});

console.log(`Levels count: ${levels.length}`);

const blueprintObjects = [];
const blueprintPropertyNames = new Set();
const blueprintTypePaths = new Set();

for (const level of levels) {
    const levelName = level.name || level.pathName || '(unnamed)';
    const objects = level.objects instanceof Map ? [...level.objects.values()]
        : Array.isArray(level.objects) ? level.objects
        : Object.values(level.objects || {});
    console.log(`\nLevel: ${levelName}, objects: ${objects.length}`);

    for (const obj of objects) {
        const typePath = obj.typePath || '';
        const isBlueprint = typePath.toLowerCase().includes('blueprint');

        if (isBlueprint) {
            blueprintTypePaths.add(typePath);
            blueprintObjects.push(obj);
        }

        const props = obj.properties instanceof Map ? [...obj.properties.entries()]
            : Array.isArray(obj.properties) ? obj.properties.map(p => [p.name, p])
            : Object.entries(obj.properties || {});

        for (const [name, prop] of props) {
            if (name?.toLowerCase().includes('blueprint')) {
                blueprintPropertyNames.add(name);
                if (!isBlueprint) blueprintObjects.push(obj);
            }
        }
    }
}

console.log(`\n=== Blueprint type paths ===`);
for (const tp of blueprintTypePaths) console.log(`  ${tp}`);

console.log(`\n=== Blueprint property names ===`);
for (const pn of blueprintPropertyNames) console.log(`  ${pn}`);

console.log(`\n=== Blueprint objects (${blueprintObjects.length}) ===`);
for (const obj of blueprintObjects.slice(0, 15)) {
    console.log(`\n--- ${obj.typePath} ---`);
    console.log(`  instanceName: ${obj.instanceName}`);
    const objKeys = Object.keys(obj).filter(k => k !== 'typePath' && k !== 'instanceName');
    console.log(`  keys: ${objKeys.join(', ')}`);
    const props = obj.properties instanceof Map ? [...obj.properties.entries()]
        : Array.isArray(obj.properties) ? obj.properties.map(p => [p.name, p])
        : Object.entries(obj.properties || {});
    console.log(`  properties (${props.length}):`);
    for (const [name, prop] of props) {
        const val = JSON.stringify(prop.value ?? prop)?.substring(0, 200);
        console.log(`    ${name} [${prop.type || '?'}] = ${val}`);
    }
}

if (blueprintObjects.length > 15) {
    console.log(`\n... and ${blueprintObjects.length - 15} more`);
}

// Also dump the first blueprint file for comparison
try {
    const bpBuf = readFileSync('/data/saves/blueprints/2x Assemblers.sbp');
    const bpData = bpBuf.buffer.slice(bpBuf.byteOffset, bpBuf.byteOffset + bpBuf.byteLength);
    const bpCfgBuf = readFileSync('/data/saves/blueprints/2x Assemblers.sbpcfg');
    const bpCfgData = bpCfgBuf.buffer.slice(bpCfgBuf.byteOffset, bpCfgBuf.byteOffset + bpCfgBuf.byteLength);
    const bp = Parser.ParseBlueprintFiles('bp', bpData, bpCfgData);
    console.log(`\n=== Reference blueprint file ===`);
    console.log(`Top-level keys: ${Object.keys(bp).join(', ')}`);
    console.log(JSON.stringify(bp, null, 2).substring(0, 3000));
} catch (e) {
    console.log(`\nCould not parse reference blueprint: ${e.message}`);
}
