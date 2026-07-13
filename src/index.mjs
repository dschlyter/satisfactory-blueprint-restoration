#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';

const SAVE_DIR = '/data/saves';
const OUTPUT_DIR = '/data/output';

function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const saveFile = args[1];

    if (!command || !saveFile) {
        console.log('Usage: satisfactory-blueprint-restoration <command> <save.sav> [options]');
        console.log('');
        console.log('Commands:');
        console.log('  list <save.sav> [-v]                  List unique blueprint names');
        console.log('  instances <save.sav> "name"           List all instances of a blueprint');
        console.log('  extract <save.sav> [--all]            Extract blueprints to output dir');
        console.log('  extract <save.sav> --name "name"      Extract specific blueprint by name');
        console.log('  extract <save.sav> --pick "name" N    Pick Nth instance of a blueprint');
        process.exit(1);
    }

    const save = parseSave(join(SAVE_DIR, saveFile));
    const groups = findBlueprintGroups(save);

    if (command === 'list') {
        const verbose = args.includes('-v') || args.includes('--verbose');
        listBlueprints(groups, verbose);
    } else if (command === 'instances') {
        const name = args[2];
        if (!name) { console.error('Usage: instances <save.sav> "name"'); process.exit(1); }
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
    console.log(`Parsing save: ${path}`);
    return Parser.ParseSave('save', toArrayBuffer(readFileSync(path)));
}

function parseExtractOptions(args) {
    const opts = { all: false, name: null, pick: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--all') opts.all = true;
        if (args[i] === '--name') opts.name = args[++i];
        if (args[i] === '--pick') { opts.name = args[++i]; opts.pick = parseInt(args[++i], 10); }
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

    // Group by blueprint name
    const byName = new Map();
    for (const [proxy, entities] of proxyEntities) {
        const nameVal = getPropValue(proxy, 'mBlueprintName');
        const name = typeof nameVal === 'string' ? nameVal : nameVal?.value || 'unnamed';
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ proxy, entities });
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
    for (const [name, instances] of sorted) {
        if (verbose) {
            const entityCounts = instances.map(i => i.entities.length);
            const maxEntities = Math.max(...entityCounts);
            const minEntities = Math.min(...entityCounts);
            const countStr = minEntities === maxEntities ? `${maxEntities}` : `${minEntities}-${maxEntities}`;
            console.log(`  "${name}" — ${instances.length} placement(s), ${countStr} entities each`);
        } else {
            const suffix = instances.length > 1 ? ` (${instances.length}x)` : '';
            console.log(`  ${name}${suffix}`);
        }
    }
}

function listInstances(groups, name) {
    const instances = groups.get(name);
    if (!instances) {
        console.error(`Blueprint "${name}" not found. Use 'list' to see available names.`);
        process.exit(1);
    }

    console.log(`\n"${name}" — ${instances.length} instance(s):\n`);
    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const pos = inst.proxy.transform?.translation;
        const posStr = pos ? `at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : '';
        console.log(`  [${i}] ${inst.entities.length} entities ${posStr}`);
    }
    console.log(`\nTo extract a specific instance: ./run.sh extract <save.sav> --pick "${name}" <index>`);
}

function selectInstance(instances, pick) {
    if (pick !== null && pick !== undefined) return instances[pick];
    // Default: pick the instance with the most entities
    return instances.reduce((best, cur) => cur.entities.length > best.entities.length ? cur : best);
}

function buildBlueprintFromEntities(name, proxy, entities, save) {
    // Collect recipe references from entities
    const recipes = new Set();
    for (const obj of entities) {
        const recipe = getPropValue(obj, 'mBuiltWithRecipe');
        if (recipe?.pathName) recipes.add(recipe.pathName);
    }
    const recipeReferences = [...recipes].map(p => ({ levelName: '', pathName: p }));

    // Strip mBlueprintProxy from entity properties and deep-clone
    const cleanedObjects = entities.map(obj => {
        const clone = JSON.parse(JSON.stringify(obj));
        if (clone.properties) {
            if (clone.properties instanceof Object && !Array.isArray(clone.properties)) {
                delete clone.properties.mBlueprintProxy;
            }
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

    mkdirSync(OUTPUT_DIR, { recursive: true });

    const toExtract = opts.name
        ? [[opts.name, groups.get(opts.name)]].filter(([, v]) => v)
        : [...groups.entries()];

    if (opts.name && !groups.has(opts.name)) {
        console.error(`Blueprint "${opts.name}" not found. Use 'list' to see available names.`);
        process.exit(1);
    }

    console.log(`\nExtracting ${toExtract.length} blueprint(s) to ${OUTPUT_DIR}\n`);

    let extracted = 0;
    for (const [name, instances] of toExtract) {
        const instance = selectInstance(instances, opts.pick);
        console.log(`"${name}" — ${instance.entities.length} entities (from ${instances.length} placement(s))`);

        try {
            const blueprint = buildBlueprintFromEntities(name, instance.proxy, instance.entities, save);
            writeBlueprintFiles(OUTPUT_DIR, name, blueprint);
            extracted++;
        } catch (e) {
            console.error(`  ERROR: ${e.message}`);
        }
    }

    console.log(`\nExtracted ${extracted}/${toExtract.length} blueprints to ${OUTPUT_DIR}`);
}

main();
