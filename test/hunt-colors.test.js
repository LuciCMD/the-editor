const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const colors = require('../utils/colors');

const ROOT = path.join(__dirname, '..');

function jsFiles(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

// A misspelt key gives undefined, which loads fine and silently drops the accent bar
test('every palette name used in the code exists in utils/colors.js', () => {
    const missing = [];
    for (const folder of ['commands', 'components', 'passives', 'utils']) {
        for (const file of jsFiles(path.join(ROOT, folder))) {
            const src = fs.readFileSync(file, 'utf8');
            const rel = path.relative(ROOT, file);
            for (const m of src.matchAll(/\bcolors\.([A-Za-z_]+)/g)) {
                if (!(m[1] in colors)) missing.push(`${rel}: colors.${m[1]}`);
            }
            for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(['"][./]*utils\/colors['"]\)/g)) {
                for (const part of m[1].split(',')) {
                    const key = part.split(':')[0].trim();
                    if (key && !(key in colors)) missing.push(`${rel}: { ${key} }`);
                }
            }
        }
    }
    assert.deepStrictEqual(missing, []);
});

test('palette values are valid 24-bit colours', () => {
    for (const [name, value] of Object.entries(colors)) {
        assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF, name);
    }
});
