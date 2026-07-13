import { Parser } from '@etothepii/satisfactory-file-parser';

// --- Core blueprint logic (shared with CLI) ---

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

function getProps(obj) {
    if (obj.properties instanceof Map) return obj.properties;
    if (Array.isArray(obj.properties)) return new Map(obj.properties.map(p => [p.name, p]));
    return new Map(Object.entries(obj.properties || {}));
}

function getPropValue(obj, name) {
    return getProps(obj).get(name)?.value;
}

function getAllObjects(save) {
    return Object.values(save.levels).flatMap(l =>
        l.objects instanceof Map ? [...l.objects.values()]
        : Array.isArray(l.objects) ? l.objects
        : Object.values(l.objects || {})
    );
}

let lwCounter = 0;
function lightweightToEntity(typePath, inst) {
    const entity = {
        typePath,
        rootObject: 'Persistent_Level',
        instanceName: `Persistent_Level:PersistentLevel.${typePath.split('.').pop()}_LW_${lwCounter++}`,
        flags: 8,
        properties: {},
        specialProperties: { type: 'EmptySpecialProperties' },
        trailingData: [],
        saveCustomVersion: 0,
        shouldMigrateObjectRefsToPersistent: false,
        parentEntityName: '',
        type: 'SaveEntity',
        needTransform: true,
        wasPlacedInLevel: false,
        parentObject: { levelName: 'Persistent_Level', pathName: 'Persistent_Level:PersistentLevel.BuildableSubsystem' },
        transform: inst.transform,
        components: [],
        _lightweight: true,
    };
    if (inst.usedRecipe?.pathName) {
        entity.properties.mBuiltWithRecipe = {
            type: 'ObjectProperty', name: 'mBuiltWithRecipe',
            propertyTagType: { name: 'ObjectProperty', children: [] },
            value: inst.usedRecipe,
        };
    }
    if (inst.usedSwatchSlot?.pathName) {
        entity.properties.mCustomizationData = {
            type: 'StructProperty', name: 'mCustomizationData',
            propertyTagType: { name: 'StructProperty', children: [{ name: 'FactoryCustomizationData', children: [{ name: '/Script/FactoryGame', children: [] }] }] },
            value: {
                type: 'FactoryCustomizationData',
                properties: {
                    SwatchDesc: {
                        type: 'ObjectProperty', name: 'SwatchDesc',
                        propertyTagType: { name: 'ObjectProperty', children: [] },
                        value: inst.usedSwatchSlot,
                    },
                },
            },
        };
    }
    return entity;
}

const DESIGNER_TIERS = { Mk1: 4, MK2: 5, Mk3: 6 };

function detectMaxDesignerTier(save) {
    const allObjects = getAllObjects(save);
    let maxDim = 4;
    for (const obj of allObjects) {
        if (!obj.typePath.includes('BlueprintDesigner')) continue;
        for (const [key, dim] of Object.entries(DESIGNER_TIERS)) {
            if (obj.typePath.includes(key) && dim > maxDim) maxDim = dim;
        }
    }
    return maxDim;
}

function computeDesignerDimension(objects, maxDim) {
    let maxAbs = 0;
    for (const obj of objects) {
        const t = obj.transform?.translation;
        if (!t) continue;
        maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z));
    }
    const needed = Math.max(Math.ceil(maxAbs / 400) * 2, 4);
    return { x: Math.min(needed, maxDim), y: Math.min(needed, maxDim), z: Math.min(needed, maxDim) };
}

function getProxyId(proxy) {
    return parseInt(proxy.instanceName.match(/_(\d+)$/)?.[1] || '0');
}

function getSessionName(save) {
    for (const obj of getAllObjects(save)) {
        const name = getPropValue(obj, 'mReplicatedSessionName');
        if (name) return name;
        const saveName = getPropValue(obj, 'mSaveSessionName');
        if (saveName) return saveName;
    }
    return 'unknown';
}

function findBlueprintGroups(save, onProgress) {
    lwCounter = 0;
    const allObjects = getAllObjects(save);

    const proxies = allObjects.filter(o => o.typePath === '/Script/FactoryGame.FGBlueprintProxy');
    onProgress?.(`Found ${proxies.length} blueprint proxies...`);

    const proxyPathIndex = new Map();
    for (const proxy of proxies) {
        proxyPathIndex.set(proxy.instanceName?.split('.').pop(), proxy);
    }

    const objectsByInstance = new Map();
    for (const obj of allObjects) {
        if (obj.instanceName) objectsByInstance.set(obj.instanceName, obj);
    }

    const proxyEntities = new Map();
    for (const proxy of proxies) proxyEntities.set(proxy, []);

    for (const obj of allObjects) {
        const bpRef = getPropValue(obj, 'mBlueprintProxy');
        if (!bpRef?.pathName) continue;
        const proxy = proxyPathIndex.get(bpRef.pathName.split('.').pop());
        if (!proxy) continue;
        const entities = proxyEntities.get(proxy);
        entities.push(obj);
        for (const compRef of (obj.components || [])) {
            const comp = objectsByInstance.get(compRef.pathName || compRef);
            if (comp) entities.push(comp);
        }
    }

    const lwSub = allObjects.find(o => o.typePath.includes('LightweightBuildableSubsystem'));
    if (lwSub?.specialProperties?.buildables) {
        let lwCount = 0;
        for (const buildable of lwSub.specialProperties.buildables) {
            for (const inst of buildable.instances) {
                const pp = inst.blueprintProxy?.pathName;
                if (!pp) continue;
                const proxy = proxyPathIndex.get(pp.split('.').pop());
                if (!proxy) continue;
                proxyEntities.get(proxy).push(lightweightToEntity(buildable.typeReference.pathName, inst));
                lwCount++;
            }
        }
        onProgress?.(`Found ${lwCount} lightweight buildables...`);
    }

    const allIds = proxies.map(p => getProxyId(p)).sort((a, b) => a - b);
    const maxId = allIds[allIds.length - 1];
    const minId = allIds[0];
    const idRange = maxId - minId || 1;
    const proxyAge = new Map();
    for (const proxy of proxies) {
        proxyAge.set(proxy, Math.round((maxId - getProxyId(proxy)) / idRange * 100));
    }

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

function sanitizeObject(obj, entityNames) {
    const props = obj.properties;
    if (!props || typeof props !== 'object') return;
    if (props.mInventoryStacks?.values) {
        for (const stack of props.mInventoryStacks.values) {
            if (stack.properties?.Item?.value) {
                stack.properties.Item.value.itemReference = { levelName: '', pathName: '' };
            }
            if (stack.properties?.NumItems) stack.properties.NumItems.value = 0;
        }
    }
    if (props.mConnectedComponent?.value?.pathName) {
        if (!entityNames.has(props.mConnectedComponent.value.pathName)) {
            delete props.mConnectedComponent;
        }
    }
    if (props.mWires?.values) {
        props.mWires.values = props.mWires.values.filter(w => entityNames.has(w.pathName));
    }
    delete props.mCurrentPotential;
    delete props.mPendingPotential;
    delete props.mProductivityMonitor;
    delete props.mProductionBoostDuration;
}

function buildBlueprintFromEntities(name, proxy, entities, save) {
    const recipes = new Set();
    for (const obj of entities) {
        const recipe = getPropValue(obj, 'mBuiltWithRecipe');
        if (recipe?.pathName) recipes.add(recipe.pathName);
    }
    const recipeReferences = [...recipes].map(p => ({ levelName: '', pathName: p }));

    const STRIP_PROPS = ['mBlueprintProxy', 'mConveyorChainActor'];
    const proxyRot = proxy.transform?.rotation || {x:0,y:0,z:0,w:1};
    const proxyPos = proxy.transform?.translation || {x:0,y:0,z:0};
    const invRot = quatConj(proxyRot);
    const GRID_HALF_CELL = 200;
    const originOffset = rotateByQuat({x: GRID_HALF_CELL, y: 0, z: 0}, proxyRot);
    const origin = {x: proxyPos.x + originOffset.x, y: proxyPos.y + originOffset.y, z: proxyPos.z + originOffset.z};
    const entityNames = new Set(entities.map(e => e.instanceName));

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
        sanitizeObject(clone, entityNames);
        return clone;
    });

    return {
        name,
        compressionInfo: save.compressionInfo || {
            chunkHeaderVersion: 572662306, packageFileTag: 2653586369,
            maxUncompressedChunkContentSize: 131072, compressionAlgorithm: 3,
        },
        header: {
            headerVersion: 2,
            saveVersion: save.header?.saveVersion || 60,
            buildVersion: save.header?.buildVersion || 495413,
            designerDimension: computeDesignerDimension(cleanedObjects, save._maxDesignerDim),
            recipeReferences, itemCosts: [],
            objectVersionData: save.objectVersionData || {},
        },
        config: {
            configVersion: 6, description: 'Restored from save file',
            color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, iconID: 782,
            referencedIconLibrary: '/Game/FactoryGame/-Shared/Blueprint/IconLibrary',
            iconLibraryType: 'IconLibrary',
            lastEditedBy: { serviceProvider: 1, playerInfoTableIndex: 0 },
        },
        objects: cleanedObjects,
    };
}

function writeBlueprintToArrayBuffers(blueprint) {
    const sbpChunks = [];
    let sbpHeader = null;
    const result = Parser.WriteBlueprintFiles(
        blueprint,
        (header) => { sbpHeader = header; },
        (chunk) => { sbpChunks.push(chunk); },
    );
    const totalSize = (sbpHeader?.byteLength || 0) + sbpChunks.reduce((s, c) => s + c.byteLength, 0);
    const sbpBuffer = new Uint8Array(totalSize);
    let offset = 0;
    if (sbpHeader) { sbpBuffer.set(new Uint8Array(sbpHeader), offset); offset += sbpHeader.byteLength; }
    for (const chunk of sbpChunks) { sbpBuffer.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
    return { sbp: sbpBuffer, sbpcfg: new Uint8Array(result.configFileBinary) };
}

// --- Web UI ---

const $ = (sel) => document.querySelector(sel);

let currentSave = null;
let currentGroups = null;

function setStatus(msg) {
    $('#status').textContent = msg;
}

function getDesignerDim(save) {
    const val = document.querySelector('input[name="designer"]:checked')?.value;
    return val === 'auto' || !val ? save._detectedDesignerDim : parseInt(val);
}

function handleFile(file) {
    if (!file.name.endsWith('.sav')) {
        setStatus('Please drop a Satisfactory save file (.sav)');
        return;
    }
    setStatus(`Reading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);
    $('#results').innerHTML = '';
    $('#drop-zone').classList.add('processing');

    const reader = new FileReader();
    reader.onload = () => {
        setTimeout(() => processSave(reader.result, file.name), 50);
    };
    reader.readAsArrayBuffer(file);
}

function processSave(arrayBuffer, fileName) {
    try {
        setStatus('Parsing save file...');
        const save = Parser.ParseSave('save', arrayBuffer);
        save._sessionName = getSessionName(save);
        save._detectedDesignerDim = detectMaxDesignerTier(save);
        save._maxDesignerDim = save._detectedDesignerDim;
        currentSave = save;

        const tierNames = { 4: 'Mk1', 5: 'Mk2', 6: 'Mk3' };
        $('#auto-label').textContent = `Auto (${tierNames[save._detectedDesignerDim] || 'Mk1'} — ${save._detectedDesignerDim}x${save._detectedDesignerDim}x${save._detectedDesignerDim})`;
        $('#designer-size').style.display = '';

        const groups = findBlueprintGroups(save, setStatus);
        currentGroups = groups;

        renderResults(groups, save, fileName);
    } catch (e) {
        setStatus(`Error parsing save: ${e.message}`);
        console.error(e);
    }
    $('#drop-zone').classList.remove('processing');
}

function renderResults(groups, save, fileName) {
    const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    if (sorted.length === 0) {
        setStatus('No blueprints found in this save file.');
        return;
    }

    setStatus(`Found ${sorted.length} blueprints in "${save._sessionName}"`);

    const container = $('#results');
    container.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'btn btn-primary';
    const updateCheckedCount = () => {
        const count = document.querySelectorAll('.row-check:checked').length;
        downloadAllBtn.textContent = `Download Checked (${count}/${sorted.length})`;
        downloadAllBtn.disabled = count === 0;
    };
    downloadAllBtn.onclick = () => downloadAll(save);
    toolbar.appendChild(downloadAllBtn);
    container.appendChild(toolbar);

    const helpText = document.createElement('p');
    helpText.className = 'help-text';
    helpText.textContent = 'Blueprint is recovered from the last placed instance in the world. If this instance has entities deleted they will be missing. Change which instance to use in the dropdown menu.';
    container.appendChild(helpText);

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
        <th class="check-col"><input type="checkbox" id="select-all" checked></th><th class="sortable" data-sort="name">Name</th><th class="sortable active" data-sort="placed">Placed ▼</th><th>Instance</th><th>Contents</th><th></th>
    </tr></thead>`;
    table.querySelector('#select-all').onchange = (e) => {
        table.querySelectorAll('.row-check').forEach(cb => cb.checked = e.target.checked);
        updateCheckedCount();
    };
    const tbody = document.createElement('tbody');

    const rows = [];
    for (const [name, instances] of sorted) {
        const byAge = [...instances].sort((a, b) => getProxyId(b.proxy) - getProxyId(a.proxy));
        const newest = byAge[byAge.length - 1];
        const summary = summarizeEntities(newest.entities);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="check-col"><input type="checkbox" class="row-check" checked></td>
            <td class="name-col">${escHtml(name)}</td>
            <td class="num-col">${instances.length}</td>
            <td class="num-col"></td>
            <td class="summary-col">${escHtml(summary)}</td>
            <td class="action-col"></td>`;
        tr._byAge = byAge;
        tr._sortName = name.toLowerCase();
        tr._sortPlaced = instances.length;
        tr.querySelector('.row-check').onchange = updateCheckedCount;

        const instanceCell = tr.querySelectorAll('td')[3];
        if (instances.length === 1) {
            instanceCell.textContent = `#1 (${newest.entities.length} entities)`;
        } else {
            const maxEntities = Math.max(...byAge.map(i => i.entities.length));
            const select = document.createElement('select');
            select.className = 'instance-select';
            for (let i = 0; i < byAge.length; i++) {
                const inst = byAge[i];
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = `#${i + 1} (${inst.entities.length} entities)`;
                select.appendChild(opt);
            }
            select.value = byAge.length - 1;
            const updateWarning = () => {
                const inst = byAge[select.value];
                select.classList.toggle('warn', inst.entities.length < maxEntities);
            };
            updateWarning();
            select.onchange = () => {
                const inst = byAge[select.value];
                tr.querySelector('.summary-col').textContent = summarizeEntities(inst.entities);
                updateWarning();
            };
            instanceCell.appendChild(select);
        }

        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.textContent = 'Download';
        const select = instanceCell.querySelector('select');
        btn.onclick = () => {
            const idx = select ? parseInt(select.value) : 0;
            downloadOne(name, byAge[idx], save, btn);
        };
        tr.querySelector('.action-col').appendChild(btn);
        rows.push(tr);
    }

    function sortRows(key) {
        const headers = table.querySelectorAll('.sortable');
        headers.forEach(th => {
            th.classList.remove('active');
            th.textContent = th.dataset.sort === 'name' ? 'Name' : 'Placed';
        });
        const activeHeader = table.querySelector(`[data-sort="${key}"]`);
        activeHeader.classList.add('active');
        if (key === 'placed') {
            rows.sort((a, b) => b._sortPlaced - a._sortPlaced || a._sortName.localeCompare(b._sortName));
            activeHeader.textContent = 'Placed ▼';
        } else {
            rows.sort((a, b) => a._sortName.localeCompare(b._sortName));
            activeHeader.textContent = 'Name ▲';
        }
        tbody.innerHTML = '';
        rows.forEach(tr => tbody.appendChild(tr));
    }

    table.querySelectorAll('.sortable').forEach(th => {
        th.onclick = () => sortRows(th.dataset.sort);
    });

    sortRows('placed');
    table.appendChild(tbody);
    container.appendChild(table);
    updateCheckedCount();
}

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function downloadOne(name, instance, save, btn) {
    const origText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    setTimeout(() => {
        try {
            save._maxDesignerDim = getDesignerDim(save);
            const blueprint = buildBlueprintFromEntities(name, instance.proxy, instance.entities, save);
            const { sbp, sbpcfg } = writeBlueprintToArrayBuffers(blueprint);
            const safeName = name.replace(/[/\\?*:|"<>]/g, '_');
            downloadFile(`${safeName}.sbp`, sbp);
            downloadFile(`${safeName}.sbpcfg`, sbpcfg);
            btn.textContent = 'Done!';
            setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
        } catch (e) {
            btn.textContent = 'Error';
            btn.disabled = false;
            console.error(`Error extracting "${name}":`, e);
            setTimeout(() => { btn.textContent = origText; }, 2000);
        }
    }, 10);
}

async function downloadAll(save) {
    const rows = [...document.querySelectorAll('tbody tr')].filter(
        tr => tr.querySelector('.row-check')?.checked
    );
    if (rows.length === 0) return;

    const btn = $('.btn-primary');
    const origText = btn.textContent;
    btn.disabled = true;

    let done = 0;
    const files = [];

    for (const tr of rows) {
        const name = tr.querySelector('.name-col').textContent;
        btn.textContent = `Extracting ${++done}/${rows.length}...`;
        await new Promise(r => setTimeout(r, 0));
        try {
            const byAge = tr._byAge;
            const select = tr.querySelector('.instance-select');
            const idx = select ? parseInt(select.value) : byAge.length - 1;
            const instance = byAge[idx];
            save._maxDesignerDim = getDesignerDim(save);
            const blueprint = buildBlueprintFromEntities(name, instance.proxy, instance.entities, save);
            const { sbp, sbpcfg } = writeBlueprintToArrayBuffers(blueprint);
            const safeName = name.replace(/[/\\?*:|"<>]/g, '_');
            files.push({ name: `${safeName}.sbp`, data: sbp });
            files.push({ name: `${safeName}.sbpcfg`, data: sbpcfg });
        } catch (e) {
            console.error(`Error extracting "${name}":`, e);
        }
    }

    btn.textContent = 'Building zip...';
    await new Promise(r => setTimeout(r, 0));

    const zipBlob = await createZip(files, save._sessionName);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${save._sessionName} - Blueprints.zip`;
    a.click();
    URL.revokeObjectURL(url);

    btn.textContent = origText;
    btn.disabled = false;
}

function downloadFile(name, data) {
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

async function createZip(files, sessionName) {
    // Minimal ZIP implementation (no compression — blueprint files are already small)
    const enc = new TextEncoder();
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = enc.encode(`${sessionName}/${file.name}`);
        // Local file header
        const local = new Uint8Array(30 + nameBytes.length + file.data.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);  // signature
        lv.setUint16(4, 20, true);           // version needed
        lv.setUint16(6, 0, true);            // flags
        lv.setUint16(8, 0, true);            // compression (store)
        lv.setUint16(10, 0, true);           // mod time
        lv.setUint16(12, 0, true);           // mod date
        lv.setUint32(14, crc32(file.data), true);
        lv.setUint32(18, file.data.length, true);  // compressed
        lv.setUint32(22, file.data.length, true);  // uncompressed
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);           // extra length
        local.set(nameBytes, 30);
        local.set(file.data, 30 + nameBytes.length);
        localHeaders.push(local);

        // Central directory header
        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, crc32(file.data), true);
        cv.setUint32(20, file.data.length, true);
        cv.setUint32(24, file.data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centralHeaders.push(central);

        offset += local.length;
    }

    const centralSize = centralHeaders.reduce((s, h) => s + h.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localHeaders, ...centralHeaders, eocd], { type: 'application/zip' });
}

function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- Init ---

console.log('Blueprint restoration app loaded');
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = $('#drop-zone');
    const fileInput = $('#file-input');

    ['dragenter', 'dragover'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('dragover');
        });
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    // Prevent browser from opening file on missed drops
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
    });
});
