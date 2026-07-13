#!/usr/bin/env node
import { readFileSync } from 'fs';
import { Parser } from '@etothepii/satisfactory-file-parser';

function toArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function parseAndDump(label, sbpPath, sbpcfgPath) {
    console.log(`\n=== ${label} ===`);
    const bp = Parser.ParseBlueprintFiles('bp',
        toArrayBuffer(readFileSync(sbpPath)),
        toArrayBuffer(readFileSync(sbpcfgPath)),
    );
    console.log(`Objects: ${bp.objects.length}`);
    console.log(`Recipes: ${bp.header.recipeReferences?.length}`);
    console.log(`Designer dim: ${JSON.stringify(bp.header.designerDimension)}`);
    console.log(`Config desc: "${bp.config.description}"`);
    console.log(`Object types:`);
    const types = {};
    for (const obj of bp.objects) {
        const short = obj.typePath.split('/').pop();
        types[short] = (types[short] || 0) + 1;
    }
    for (const [t, c] of Object.entries(types).sort()) console.log(`  ${t}: ${c}`);
}

parseAndDump('Original', '/data/saves/blueprints/2x Assemblers.sbp', '/data/saves/blueprints/2x Assemblers.sbpcfg');
parseAndDump('Extracted', '/data/output/Tech42 REV3NGE/2x Assemblers.sbp', '/data/output/Tech42 REV3NGE/2x Assemblers.sbpcfg');
