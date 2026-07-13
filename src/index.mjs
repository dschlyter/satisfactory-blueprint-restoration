#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';

const SAVE_DIR = '/data/saves';
const OUTPUT_DIR = '/data/output';

function quatConj(q) { return {x: -q.x, y: -q.y, z: -q.z, w: q.w}; }
function quatMul(a, b) {
    return {
        w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
        x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
        y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
        z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
    };
}
function rotateByQuat(v, q) {
    const r = quatMul(quatMul(q, {x: v.x, y: v.y, z: v.z, w: 0}), quatConj(q));
    return {x: r.x, y: r.y, z: r.z};
}

function main() {
    const args = process.argv.slice(2);
    const saveFile = args[0];
    const command = args[1];

    if (!saveFile || !command) {
        console.log('Usage: satisfactory-blueprint-restoration <save.sav> <command> [options]');
        console.log('');
        console.log('Commands:');
        console.log('  list [-v]                             List unique blueprint names');
        console.log('  instances "name"                      List all instances of a blueprint');
        console.log('  extract [--all]                       Extract all blueprints, latest placement (default)');
        console.log('  extract --name "name"                 Extract specific blueprint by name');
        console.log('  extract --pick "name" [N]             Pick Nth instance (default: latest)');
        process.exit(1);
    }

    const save = parseSave(join(SAVE_DIR, saveFile));
    const groups = findBlueprintGroups(save);

    if (command === 'list') {
        const verbose = args.includes('-v') || args.includes('--verbose');
        listBlueprints(groups, verbose);
    } else if (command === 'instances') {
        const name = args[2];
        if (!name) { console.error('Usage: <save.sav> instances "name"'); process.exit(1); }
        listInstances(groups, name);
    } else if (command === 'extract') {
        const opts = parseExtractOptions(args.slice(2));
        extractBlueprints(save, groups, opts);
    } else {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
}

function toArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function parseSave(path) {
    if (!existsSync(path)) {
        console.error(`Save file not found: ${path}`);
        console.error(`Place your .sav file in the data/ directory and pass the filename.`);
        process.exit(1);
    }
    console.log(`Parsing save: ${path}`);
    const save = Parser.ParseSave('save', toArrayBuffer(readFileSync(path)));
    save._sessionName = getSessionName(save);
    return save;
}

function getSessionName(save) {
    const allObjects = getAllObjects(save);
    for (const obj of allObjects) {
        const name = getPropValue(obj, 'mReplicatedSessionName');
        if (name) return name;
        const saveName = getPropValue(obj, 'mSaveSessionName');
        if (saveName) return saveName;
    }
    return 'unknown';
}

function parseExtractOptions(args) {
    const opts = { all: false, name: null, pick: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--all') opts.all = true;
        if (args[i] === '--name') opts.name = args[++i];
        if (args[i] === '--pick') {
            opts.name = args[++i];
            const next = args[i + 1];
            if (next !== undefined && !next.startsWith('-')) opts.pick = parseInt(args[++i], 10);
        }
    }
    if (!opts.name) opts.all = true;
    return opts;
}

function getProps(obj) {
    if (obj.properties instanceof Map) return obj.properties;
    if (Array.isArray(obj.properties)) return new Map(obj.properties.map(p => [p.name, p]));
    return new Map(Object.entries(obj.properties || {}));
}

function getPropValue(obj, name) {
    return getProps(obj).get(name)?.value;
}

function getAllObjects(save) {
    const levels = Object.values(save.levels);
    return levels.flatMap(l =>
        l.objects instanceof Map ? [...l.objects.values()]
        : Array.isArray(l.objects) ? l.objects
        : Object.values(l.objects || {})
    );
}

function findBlueprintGroups(save) {
    const allObjects = getAllObjects(save);

    const proxies = allObjects.filter(o => o.typePath === '/Script/FactoryGame.FGBlueprintProxy');
    console.log(`Found ${proxies.length} blueprint proxy instances`);

    const proxyPathIndex = new Map();
    for (const proxy of proxies) {
        const pathKey = proxy.instanceName?.split('.').pop();
        proxyPathIndex.set(pathKey, proxy);
    }

    // Index all objects by instanceName for component lookup
    const objectsByInstance = new Map();
    for (const obj of allObjects) {
        if (obj.instanceName) objectsByInstance.set(obj.instanceName, obj);
    }

    // Link objects to their proxy, including child components
    const proxyEntities = new Map();
    for (const proxy of proxies) proxyEntities.set(proxy, []);

    for (const obj of allObjects) {
        const bpRef = getPropValue(obj, 'mBlueprintProxy');
        if (!bpRef?.pathName) continue;
        const pathKey = bpRef.pathName.split('.').pop();
        const proxy = proxyPathIndex.get(pathKey);
        if (!proxy) continue;

        const entities = proxyEntities.get(proxy);
        entities.push(obj);

        // Also collect child components referenced by this object
        const components = obj.components || [];
        for (const compRef of components) {
            const compPath = compRef.pathName || compRef;
            const comp = objectsByInstance.get(compPath);
            if (comp) entities.push(comp);
        }
    }

    // Compute relative age (0=oldest, 100=newest) from proxy IDs (count down from INT32_MAX)
    const allIds = proxies.map(p => getProxyId(p)).sort((a, b) => a - b);
    const maxId = allIds[allIds.length - 1];
    const minId = allIds[0];
    const idRange = maxId - minId || 1;
    const proxyAge = new Map();
    for (const proxy of proxies) {
        proxyAge.set(proxy, Math.round((maxId - getProxyId(proxy)) / idRange * 100));
    }

    // Group by blueprint name (case-insensitive dedup, display name from latest placement)
    const byKey = new Map();
    const displayNames = new Map();
    for (const [proxy, entities] of proxyEntities) {
        const nameVal = getPropValue(proxy, 'mBlueprintName');
        const name = typeof nameVal === 'string' ? nameVal : nameVal?.value || 'unnamed';
        const key = name.toLowerCase();
        const age = proxyAge.get(proxy);
        if (!byKey.has(key)) {
            byKey.set(key, []);
            displayNames.set(key, { name, age });
        } else if (age > displayNames.get(key).age) {
            displayNames.set(key, { name, age });
        }
        byKey.get(key).push({ proxy, entities, age });
    }

    const byName = new Map();
    for (const [key, instances] of byKey) {
        byName.set(displayNames.get(key).name, instances);
    }

    return byName;
}

function listBlueprints(groups, verbose) {
    if (groups.size === 0) {
        console.log('No blueprint groups found.');
        return;
    }

    console.log(`\n${groups.size} unique blueprint(s):\n`);
    const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const range = (arr) => { const min = Math.min(...arr); const max = Math.max(...arr); return min === max ? `${min}` : `${min}-${max}`; };
    const rows = sorted.map(([name, instances]) => [
        verbose ? `"${name}"` : name,
        `${instances.length}`,
        range(instances.map(i => i.entities.length)),
        range(instances.map(i => i.age)) + '%',
    ]);
    const cols = ['Name', 'Instances', 'Entities', 'Age'];
    const widths = cols.map((c, ci) => Math.max(c.length, ...rows.map(r => r[ci].length)));
    console.log(`  ${cols[0].padEnd(widths[0])}  ${cols[1].padStart(widths[1])}  ${cols[2].padStart(widths[2])}  ${cols[3].padStart(widths[3])}`);
    console.log(`  ${widths.map(w => ''.padEnd(w, '-')).join('  ')}`);
    for (const r of rows) {
        console.log(`  ${r[0].padEnd(widths[0])}  ${r[1].padStart(widths[1])}  ${r[2].padStart(widths[2])}  ${r[3].padStart(widths[3])}`);
    }
}

function listInstances(groups, name) {
    const instances = findGroup(groups, name);
    if (!instances) {
        console.error(`Blueprint "${name}" not found. Use 'list' to see available names.`);
        process.exit(1);
    }

    console.log(`\n"${name}" — ${instances.length} instance(s):\n`);
    instances.sort((a, b) => a.age - b.age);
    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const pos = inst.proxy.transform?.translation;
        const posStr = pos ? `at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : '';
        const summary = summarizeEntities(inst.entities);
        console.log(`  [${i}] ${inst.entities.length} entities, age ${inst.age}% ${posStr}`);
        if (summary) console.log(`       ${summary}`);
    }
    console.log(`\nTo extract a specific instance: ./run.sh extract <save.sav> --pick "${name}" <index>`);
}

function summarizeEntities(entities) {
    const counts = {};
    for (const obj of entities) {
        if (obj.typePath.includes('Component') || obj.typePath.includes('InfoComponent')) continue;
        const short = obj.typePath.split('/').pop()
            .replace(/\.\w+_C$/, '')
            .replace(/^Build_/, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2');
        counts[short] = (counts[short] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c}x ${t}`).join(', ');
}

function findGroup(groups, name) {
    return groups.get(name) || [...groups.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

function getProxyId(proxy) {
    return parseInt(proxy.instanceName.match(/_(\d+)$/)?.[1] || '0');
}

function selectInstance(instances, pick) {
    if (pick !== null && pick !== undefined) return instances[pick];
    // Default: most recently placed (lowest proxy ID = newest)
    return instances.reduce((best, cur) =>
        getProxyId(cur.proxy) < getProxyId(best.proxy) ? cur : best);
}

function buildBlueprintFromEntities(name, proxy, entities, save) {
    // Collect recipe references from entities
    const recipes = new Set();
    for (const obj of entities) {
        const recipe = getPropValue(obj, 'mBuiltWithRecipe');
        if (recipe?.pathName) recipes.add(recipe.pathName);
    }
    const recipeReferences = [...recipes].map(p => ({ levelName: '', pathName: p }));

    const STRIP_PROPS = ['mBlueprintProxy', 'mConveyorChainActor'];

    // Transform world coordinates to blueprint-local coordinates
    const proxyRot = proxy.transform?.rotation || {x:0,y:0,z:0,w:1};
    const proxyPos = proxy.transform?.translation || {x:0,y:0,z:0};
    const invRot = quatConj(proxyRot);

    // Blueprint origin is offset from proxy by half a designer grid cell (200) in local X
    const GRID_HALF_CELL = 200;
    const originOffset = rotateByQuat({x: GRID_HALF_CELL, y: 0, z: 0}, proxyRot);
    const origin = {x: proxyPos.x + originOffset.x, y: proxyPos.y + originOffset.y, z: proxyPos.z + originOffset.z};

    const cleanedObjects = entities.map(obj => {
        const clone = JSON.parse(JSON.stringify(obj));
        if (clone.properties instanceof Object && !Array.isArray(clone.properties)) {
            for (const prop of STRIP_PROPS) delete clone.properties[prop];
        }
        if (clone.transform?.translation) {
            const t = clone.transform.translation;
            const rel = {x: t.x - origin.x, y: t.y - origin.y, z: t.z - origin.z};
            clone.transform.translation = rotateByQuat(rel, invRot);
        }
        if (clone.transform?.rotation) {
            clone.transform.rotation = quatMul(invRot, clone.transform.rotation);
        }
        return clone;
    });

    // Borrow version data from the save
    const objectVersionData = save.objectVersionData || {};

    const bounds = getPropValue(proxy, 'mLocalBounds');

    return {
        name,
        compressionInfo: save.compressionInfo || {
            chunkHeaderVersion: 572662306,
            packageFileTag: 2653586369,
            maxUncompressedChunkContentSize: 131072,
            compressionAlgorithm: 3,
        },
        header: {
            headerVersion: 2,
            saveVersion: save.header?.saveVersion || 60,
            buildVersion: save.header?.buildVersion || 495413,
            designerDimension: { x: 8, y: 8, z: 8 },
            recipeReferences,
            itemCosts: [],
            objectVersionData: objectVersionData,
        },
        config: {
            configVersion: 6,
            description: `Restored from save file`,
            color: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
            iconID: 0,
            referencedIconLibrary: '/Game/FactoryGame/-Shared/Blueprint/IconLibrary',
            iconLibraryType: 'IconLibrary',
            lastEditedBy: { serviceProvider: 1, playerInfoTableIndex: 0 },
        },
        objects: cleanedObjects,
    };
}

function writeBlueprintFiles(outputDir, name, blueprint) {
    const sbpChunks = [];
    let sbpHeader = null;

    const result = Parser.WriteBlueprintFiles(
        blueprint,
        (header) => { sbpHeader = header; },
        (chunk) => { sbpChunks.push(chunk); },
    );

    // Assemble .sbp from header + chunks
    const totalSize = (sbpHeader?.byteLength || 0) + sbpChunks.reduce((s, c) => s + c.byteLength, 0);
    const sbpBuffer = new Uint8Array(totalSize);
    let offset = 0;
    if (sbpHeader) {
        sbpBuffer.set(new Uint8Array(sbpHeader), offset);
        offset += sbpHeader.byteLength;
    }
    for (const chunk of sbpChunks) {
        sbpBuffer.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }

    const safeName = name.replace(/[/\\?*:|"<>]/g, '_');
    const sbpPath = join(outputDir, `${safeName}.sbp`);
    const sbpcfgPath = join(outputDir, `${safeName}.sbpcfg`);

    writeFileSync(sbpPath, Buffer.from(sbpBuffer));
    writeFileSync(sbpcfgPath, Buffer.from(result.configFileBinary));

    console.log(`  Wrote: ${safeName}.sbp + .sbpcfg`);
    return { sbpPath, sbpcfgPath };
}

function extractBlueprints(save, groups, opts) {
    if (groups.size === 0) {
        console.log('No blueprint groups found.');
        return;
    }

    const sessionDir = join(OUTPUT_DIR, save._sessionName);
    mkdirSync(sessionDir, { recursive: true });
    console.log(`Session: "${save._sessionName}"`);

    let toExtract;
    if (opts.name) {
        const found = findGroup(groups, opts.name);
        if (!found) {
            console.error(`Blueprint "${opts.name}" not found. Use 'list' to see available names.`);
            process.exit(1);
        }
        const displayName = [...groups.entries()].find(([, v]) => v === found)[0];
        toExtract = [[displayName, found]];
    } else {
        toExtract = [...groups.entries()];
    }

    console.log(`\nExtracting ${toExtract.length} blueprint(s) to ${OUTPUT_DIR}\n`);

    let extracted = 0;
    for (const [name, instances] of toExtract) {
        const instance = selectInstance(instances, opts.pick);
        const pickNote = instances.length > 1 ? ` (latest of ${instances.length} placements)` : '';
        console.log(`"${name}" — ${instance.entities.length} entities${pickNote}`);

        try {
            const blueprint = buildBlueprintFromEntities(name, instance.proxy, instance.entities, save);
            writeBlueprintFiles(sessionDir, name, blueprint);
            extracted++;
        } catch (e) {
            console.error(`  ERROR: ${e.message}`);
        }
    }

    console.log(`\nExtracted ${extracted}/${toExtract.length} blueprints to ${OUTPUT_DIR}`);
}

main();
