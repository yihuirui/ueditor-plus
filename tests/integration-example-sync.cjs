'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    checkExamples,
    syncExamples,
    MANIFEST_NAME,
    EXAMPLE_TARGETS
} = require('../scripts/sync-examples.js');

function makeFixture() {
    const realTempRoot = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(realTempRoot, 'ueditor-example-sync-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '4.5.0' }));
    write(root, 'dist/ueditor.all.js', 'window.UE = true;');
    write(root, 'dist/dialogs/contentimport/contentimport.js', 'safe import bundle');
    write(root, 'dist-min/ueditor.all.js', 'minified editor bundle');
    write(root, 'dist-min/dialogs/ai/ai.js', 'minified AI bundle');
    EXAMPLE_TARGETS.forEach((target) => fs.mkdirSync(path.join(root, target), { recursive: true }));
    return root;
}

function write(root, relativePath, contents) {
    const absolute = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
    return absolute;
}

function readTarget(root, targetIndex, relativePath) {
    return fs.readFileSync(path.join(root, EXAMPLE_TARGETS[targetIndex], ...relativePath.split('/')));
}

function removeFixture(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

test('sync copies each built artifact and writes a deterministic complete hash manifest', (t) => {
    const root = makeFixture();
    t.after(() => removeFixture(root));

    const result = syncExamples({ repoRoot: root });
    assert.equal(result.targets.length, 3);
    assert.equal(checkExamples({ repoRoot: root }).buildId, result.buildId);

    const manifestContents = EXAMPLE_TARGETS.map((_, index) => readTarget(root, index, MANIFEST_NAME).toString('utf8'));
    assert.equal(manifestContents[0], manifestContents[1]);
    assert.equal(manifestContents[1], manifestContents[2]);
    const manifest = JSON.parse(manifestContents[0]);
    assert.equal(manifest.packageVersion, '4.5.0');
    assert.equal(manifest.artifacts.dist.files.length, 2);
    assert.equal(manifest.artifacts['dist-min'].files.length, 2);
    assert.equal(manifest.artifacts.dist.files[0].sha256, crypto.createHash('sha256').update('safe import bundle').digest('hex'));
    assert.equal(readTarget(root, 2, 'dialogs/contentimport/contentimport.js').toString(), 'safe import bundle');
});

test('check mode detects absent, changed, and extra content without repairing or removing it', (t) => {
    const root = makeFixture();
    t.after(() => removeFixture(root));
    syncExamples({ repoRoot: root });

    const missing = path.join(root, EXAMPLE_TARGETS[0], 'ueditor.all.js');
    fs.unlinkSync(missing);
    assert.throws(() => checkExamples({ repoRoot: root }), /missing=.*ueditor\.all\.js/);
    assert.equal(fs.existsSync(missing), false, 'check mode does not repair missing files');
    write(root, `${EXAMPLE_TARGETS[0]}/ueditor.all.js`, 'window.UE = true;');

    const changed = path.join(root, EXAMPLE_TARGETS[0], 'ueditor.all.js');
    fs.writeFileSync(changed, 'tampered');
    assert.throws(() => checkExamples({ repoRoot: root }), /changed=.*ueditor\.all\.js/);
    fs.writeFileSync(changed, 'window.UE = true;');

    const extra = write(root, `${EXAMPLE_TARGETS[0]}/unexpected.txt`, 'keep this file');
    assert.throws(() => checkExamples({ repoRoot: root }), /unexpected\.txt/);
    assert.equal(fs.readFileSync(extra, 'utf8'), 'keep this file');
});

test('sync refuses extra files and directories without deleting user data', (t) => {
    const root = makeFixture();
    t.after(() => removeFixture(root));
    const sentinel = write(root, `${EXAMPLE_TARGETS[1]}/operator-notes.txt`, 'preserve');
    assert.throws(() => syncExamples({ repoRoot: root }), /operator-notes\.txt/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');

    fs.unlinkSync(sentinel);
    const emptyDirectory = path.join(root, EXAMPLE_TARGETS[1], 'old-empty-folder');
    fs.mkdirSync(emptyDirectory);
    assert.throws(() => syncExamples({ repoRoot: root }), /old-empty-folder/);
    assert.equal(fs.existsSync(emptyDirectory), true);
    assert.equal(fs.existsSync(path.join(root, EXAMPLE_TARGETS[0], MANIFEST_NAME)), false,
        'all targets are preflighted before the first write');
});

test('sync refuses a nested target symlink before touching another target', (t) => {
    const root = makeFixture();
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ueditor-example-outside-'));
    t.after(() => {
        removeFixture(root);
        removeFixture(outside);
    });
    const protectedFile = path.join(outside, 'protected.txt');
    fs.writeFileSync(protectedFile, 'outside sentinel');
    const linkPath = path.join(root, EXAMPLE_TARGETS[1], 'unexpected-link');
    fs.symlinkSync(protectedFile, linkPath);

    assert.throws(() => syncExamples({ repoRoot: root }), /symbolic link/);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'outside sentinel');
    assert.equal(fs.existsSync(path.join(root, EXAMPLE_TARGETS[0], MANIFEST_NAME)), false,
        'preflight failure leaves earlier targets untouched');
});

test('sync refuses symlinked roots and artifact directories', (t) => {
    const root = makeFixture();
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ueditor-example-outside-'));
    t.after(() => {
        removeFixture(root);
        removeFixture(outside);
    });
    const linkedRoot = path.join(root, EXAMPLE_TARGETS[2]);
    fs.rmdirSync(linkedRoot);
    fs.symlinkSync(outside, linkedRoot);
    assert.throws(() => syncExamples({ repoRoot: root }), /symbolic link/);
    assert.equal(fs.readdirSync(outside).length, 0);

    fs.unlinkSync(linkedRoot);
    fs.mkdirSync(linkedRoot);
    const dist = path.join(root, 'dist');
    const outsideDist = path.join(outside, 'dist');
    fs.renameSync(dist, outsideDist);
    fs.symlinkSync(outsideDist, dist);
    assert.throws(() => syncExamples({ repoRoot: root }), /symbolic link/);
    assert.equal(fs.existsSync(path.join(linkedRoot, MANIFEST_NAME)), false);
});

test('same package version receives a new build id when artifact contents change', (t) => {
    const root = makeFixture();
    t.after(() => removeFixture(root));
    const initial = syncExamples({ repoRoot: root });
    write(root, 'dist/ueditor.all.js', 'window.UE = changed;');
    const updated = syncExamples({ repoRoot: root });
    assert.notEqual(initial.buildId, updated.buildId);
    assert.equal(checkExamples({ repoRoot: root }).buildId, updated.buildId);
});

