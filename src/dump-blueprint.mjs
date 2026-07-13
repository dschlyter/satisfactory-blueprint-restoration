#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { Parser } from '@etothepii/satisfactory-file-parser';

function toArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const bpData = toArrayBuffer(readFileSync('/data/saves/blueprints/2x Assemblers.sbp'));
const bpCfgData = toArrayBuffer(readFileSync('/data/saves/blueprints/2x Assemblers.sbpcfg'));
const bp = Parser.ParseBlueprintFiles('bp', bpData, bpCfgData);

writeFileSync('/data/output/blueprint-reference.json', JSON.stringify(bp, null, 2));
console.log('Wrote blueprint-reference.json');

// Also dump a proxy and its linked objects from save
const saveData = toArrayBuffer(readFileSync('/data/saves/test.sav'));
const save = Parser.ParseSave('save', saveData);

const levels = Object.values(save.levels);
const allObjects = levels.flatMap(l => l.objects instanceof Map ? [...l.objects.values()]
    : Array.isArray(l.objects) ? l.objects : Object.values(l.objects || {}));

const proxies = allObjects.filter(o => o.typePath === '/Script/FactoryGame.FGBlueprintProxy');
console.log(`Found ${proxies.length} blueprint proxies`);

for (const proxy of proxies) {
    const proxyPath = `${proxy.parentEntityName || 'Persistent_Level'}:PersistentLevel.${proxy.instanceName?.split('.').pop()}`;

    const getPropValue = (obj, name) => {
        const props = obj.properties instanceof Map ? obj.properties
            : Array.isArray(obj.properties) ? new Map(obj.properties.map(p => [p.name, p]))
            : new Map(Object.entries(obj.properties || {}));
        return props.get(name);
    };

    const nameProp = getPropValue(proxy, 'mBlueprintName');
    console.log(`\nProxy: ${proxy.instanceName}`);
    console.log(`  Name: ${JSON.stringify(nameProp?.value)}`);

    // Find all objects referencing this proxy
    const linkedObjects = allObjects.filter(o => {
        const bp = getPropValue(o, 'mBlueprintProxy');
        return bp?.value?.pathName?.includes(proxy.instanceName?.split('.').pop());
    });

    console.log(`  Linked objects: ${linkedObjects.length}`);
    writeFileSync('/data/output/proxy-dump.json', JSON.stringify({
        proxy,
        linkedObjectCount: linkedObjects.length,
        linkedObjects: linkedObjects.slice(0, 5),
    }, null, 2));
}

console.log('\nDone. Check output/');
