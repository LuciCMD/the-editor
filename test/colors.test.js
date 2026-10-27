const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempEnv, removeDir } = require('./helpers');

const dir = useTempEnv();

const dbManager = require('../database/dbManager');
const colors = require('../utils/colors');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['commands', 'components', 'passives', 'utils'];

function jsFiles(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

test.after(async () => {
    await dbManager.closeAllConnections();
    removeDir(dir);
});

test('palette matches color-hex.com 43555', () => {
    assert.deepStrictEqual(colors, {
        AQUA: 0x90D2D8,
        MINT: 0xB7DED2,
        PEACH: 0xF7C297,
        CREAM: 0xFFECB8,
        PINK: 0xF6A6B2
    });
});

// A wrong require path to utils/colors only shows up when the module loads
test('every command, component and passive still loads', () => {
    for (const folder of ['commands', 'components', 'passives']) {
        for (const file of jsFiles(path.join(ROOT, folder))) {
            assert.doesNotThrow(() => require(file), `${path.relative(ROOT, file)} failed to load`);
        }
    }
});

test('no accent colour is hard-coded outside utils/colors.js', () => {
    const offenders = [];
    for (const folder of SOURCE_DIRS) {
        for (const file of jsFiles(path.join(ROOT, folder))) {
            if (file === path.join(ROOT, 'utils', 'colors.js')) continue;
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            lines.forEach((line, i) => {
                if (/0x[0-9A-Fa-f]{6}\b/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
            });
        }
    }
    assert.deepStrictEqual(offenders, []);
});
