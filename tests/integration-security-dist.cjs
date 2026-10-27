'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeDom, loadIntoWindow } = require('./helpers/security-harness.cjs');

const builds = ['dist', 'dist-min'];

test('generated distributions include a working shared HTML sanitizer', function (t) {
    for (const build of builds) {
        const bundlePath = `${build}/ueditor.all.js`;
        assert.ok(fs.existsSync(path.join(__dirname, '..', bundlePath)), `${bundlePath} exists`);

        const dom = makeDom();
        t.after(() => dom.window.close());
        const window = loadIntoWindow(dom, bundlePath);
        assert.equal(typeof window.UE?.sanitizeHtml, 'function', `${build} exposes UE.sanitizeHtml`);

        window.__securityPayloadExecuted = false;
        const sanitized = window.UE.sanitizeHtml(
            '<script>window.__securityPayloadExecuted = true</script>' +
            '<p onclick="window.__securityPayloadExecuted = true">rich <strong>text</strong></p>' +
            '<img src="x" onerror="window.__securityPayloadExecuted = true">' +
            '<a href="javascript:window.__securityPayloadExecuted = true">link</a>'
        );
        const output = window.document.createElement('div');
        output.innerHTML = sanitized;

        assert.equal(window.__securityPayloadExecuted, false, `${build} did not execute payloads`);
        assert.equal(output.querySelector('script'), null, `${build} strips scripts`);
        assert.equal(output.querySelector('p').getAttribute('onclick'), null, `${build} strips event handlers`);
        assert.equal(output.querySelector('img').getAttribute('onerror'), null, `${build} strips image handlers`);
        assert.equal(output.querySelector('a').getAttribute('href'), null, `${build} strips javascript URLs`);
        assert.equal(output.querySelector('p').textContent, 'rich text', `${build} keeps formatted text`);
        assert.ok(output.querySelector('p strong'), `${build} keeps safe rich-text markup`);
    }
});

test('generated dialog copies retain the shared sanitizer integration', function () {
    for (const build of builds) {
        const aiPath = path.join(__dirname, '..', build, 'dialogs/ai/ai.js');
        const attachmentPath = path.join(__dirname, '..', build, 'dialogs/attachment/attachment.js');
        assert.ok(fs.existsSync(aiPath), `${build} includes the AI dialog`);
        assert.ok(fs.existsSync(attachmentPath), `${build} includes the attachment dialog`);

        const aiSource = fs.readFileSync(aiPath, 'utf8');
        assert.match(aiSource, /sanitizeHtml/, `${build} AI dialog uses the shared sanitizer`);
        assert.match(aiSource, /安全过滤器不可用/, `${build} AI dialog keeps fail-closed feedback`);

        const attachmentSource = fs.readFileSync(attachmentPath, 'utf8');
        assert.match(attachmentSource, /textContent/, `${build} attachment names are rendered as text`);
    }
});
