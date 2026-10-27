'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeDom, loadIntoWindow, REPO_ROOT } = require('./helpers/security-harness.cjs');

function loadSanitizer(dom) {
    loadIntoWindow(dom, '_src/editor.js');
    loadIntoWindow(dom, '_src/core/sanitizer.js');
    loadIntoWindow(dom, '_src/vendor/DOMPurify/dist/purify.isolated.js');
    return dom.window.UE;
}

function loadEditorRuntime(dom, options = {}) {
    const ue = loadSanitizer(dom);
    [
        '_src/core/browser.js',
        '_src/core/utils.js',
        '_src/core/EventBase.js',
        '_src/core/dtd.js',
        '_src/core/domUtils.js',
        '_src/core/Range.js',
        '_src/core/Selection.js',
        '_src/core/Editor.js',
        '_src/core/Editor.defaultoptions.js',
        '_src/core/loadconfig.js',
        '_src/core/node.js',
        '_src/core/htmlparser.js',
        '_src/core/filternode.js',
        '_src/core/plugin.js',
        '_src/plugins/defaultfilter.js',
        '_src/plugins/inserthtml.js',
        '_src/plugins/paste.js',
        '_src/plugins/source.js',
        '_src/plugins/link.js'
    ].forEach(script => loadIntoWindow(dom, script));

    ue.I18N = { 'zh-cn': {} };
    const editor = new dom.window.UE.Editor({
        sourceEditor: 'textarea',
        autoSyncData: false,
        loadConfigFromServer: false,
        ...options
    });
    editor.document = dom.window.document;
    editor.body = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(editor.body);
    const iframeHost = dom.window.document.createElement('div');
    editor.iframe = dom.window.document.createElement('iframe');
    iframeHost.appendChild(editor.iframe);
    dom.window.document.body.appendChild(iframeHost);
    editor.selection = {
        getNative() { return null; },
        getRange() {
            return {
                createAddress() { return {}; },
                moveToAddress() { return this; },
                select() { return this; }
            };
        }
    };
    return editor;
}

function parseHtml(dom, html) {
    const holder = dom.window.document.createElement('div');
    holder.innerHTML = html;
    return holder;
}

test('DOMPurify removes active markup and internal UEditor metadata while preserving rich text', () => {
    const dom = makeDom();
    const ue = loadSanitizer(dom);
    const input = [
        '<p onclick="alert(1)">text <strong>bold</strong></p>',
        '<a href="java&#x73;cript:alert(2)" onmouseover="alert(3)">bad</a>',
        '<img src="x" onerror="alert(4)" _src="javascript:alert(5)">',
        '<span style="color: red; background-image: url(&quot;javascript:alert(10)&quot;); --payload: url(&quot;javascript:alert(11)&quot;); background: var(--payload)">styled</span>',
        '<span style="color: blue; background-image: u\\72l(&quot;javascript:alert(12)&quot;)">escaped CSS</span>',
        '<script>alert(6)</script>',
        '<div cdata_tag="script" cdata_data="alert(7)" _ue_custom_node_="true">fake</div>',
        '<iframe src="https://frame.example.test/view" srcdoc="<script>alert(8)</script>" allow="camera" onload="alert(9)"></iframe>',
        '<iframe src="javascript:alert(12)"></iframe>'
    ].join('');
    const clean = ue.sanitizeHtml(input);
    const result = parseHtml(dom, clean);

    assert.equal(result.querySelector('script'), null);
    assert.equal(result.querySelector('[onclick], [onmouseover], [onerror], [onload]'), null);
    assert.equal(result.querySelector('[cdata_tag], [cdata_data], [_ue_custom_node_], [_src], [_href]'), null);
    assert.equal(result.querySelector('a').hasAttribute('href'), false);
    assert.equal(result.querySelector('p').querySelector('strong').textContent, 'bold');
    const styled = result.querySelector('span');
    assert.equal(styled.style.color, 'red');
    assert.doesNotMatch(styled.getAttribute('style') || '', /url\(|var\(/i);
    const iframe = result.querySelector('iframe');
    assert.ok(iframe, 'safe HTTP(S) iframe remains available');
    assert.equal(iframe.getAttribute('sandbox'), '');
    assert.equal(iframe.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(iframe.hasAttribute('srcdoc'), false);
    assert.equal(iframe.hasAttribute('allow'), false);
    assert.equal(result.querySelectorAll('iframe').length, 1, 'unsafe iframe scheme is dropped');
});

test('pinned DOMPurify instance is isolated from existing globals and AMD loaders', () => {
    const dom = makeDom();
    const originalGlobalPurifier = { sanitize() { return '<p>old</p>'; } };
    const amdCalls = [];
    const amdDefine = function () { amdCalls.push(Array.from(arguments)); };
    amdDefine.amd = {};
    dom.window.DOMPurify = originalGlobalPurifier;
    dom.window.define = amdDefine;

    const ue = loadSanitizer(dom);
    assert.equal(dom.window.DOMPurify, originalGlobalPurifier, 'host global is not replaced');
    assert.equal(dom.window.define, amdDefine, 'host AMD loader is not modified');
    assert.deepEqual(amdCalls, [], 'no anonymous AMD module is registered');
    assert.equal(dom.window.UEVendorDOMPurify.version, '3.4.17');
    assert.notEqual(dom.window.UEVendorDOMPurify, originalGlobalPurifier);
    assert.doesNotMatch(ue.sanitizeHtml('<img src=x onerror="alert(1)">'), /onerror/i);

    const noAmd = makeDom();
    const plainUe = loadSanitizer(noAmd);
    assert.equal(noAmd.window.UEVendorDOMPurify.version, '3.4.17');
    assert.doesNotMatch(plainUe.sanitizeHtml('<svg onload="alert(2)"></svg>'), /onload/i);
});

test('runtime wrapper embeds the verified upstream minified payload unchanged', () => {
    const upstream = fs.readFileSync(path.join(REPO_ROOT, '_src/vendor/DOMPurify/dist/purify.min.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(REPO_ROOT, '_src/vendor/DOMPurify/dist/purify.isolated.js'), 'utf8');
    const full = fs.readFileSync(path.join(REPO_ROOT, '_src/vendor/DOMPurify/dist/purify.js'), 'utf8');

    assert.ok(runtime.includes(upstream));
    assert.equal(crypto.createHash('sha256').update(upstream).digest('hex'), 'cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31');
    assert.equal(crypto.createHash('sha256').update(full).digest('hex'), 'a7b6dc750251c79c95592d6abf8908bcecb51319b0b5c4194b82222566ed29b9');
});

test('missing and unsupported DOMPurify fail closed by returning encoded text', () => {
    const dom = makeDom();
    const ue = loadSanitizer(dom);
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    dom.window.UEVendorDOMPurify = null;
    assert.equal(ue.sanitizeHtml(payload), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;');

    dom.window.UEVendorDOMPurify = {
        isSupported: false,
        sanitize() { return payload; }
    };
    assert.equal(ue.sanitizeHtml(payload), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    const rendered = parseHtml(dom, ue.sanitizeHtml(payload));
    assert.equal(rendered.querySelector('img,script'), null);
    assert.equal(rendered.textContent, payload);
});

test('URL sanitizer permits normal links and rejects dangerous and encoded executable schemes', () => {
    const dom = makeDom();
    const ue = loadSanitizer(dom);

    assert.equal(ue.sanitizeUrl('https://safe.example.test/path?q=1'), 'https://safe.example.test/path?q=1');
    assert.equal(ue.sanitizeUrl('mailto:editor@example.test'), 'mailto:editor@example.test');
    assert.equal(ue.sanitizeUrl('javascript:alert(1)'), '');
    assert.equal(ue.sanitizeUrl('javascript:alert(1)//https://safe.example.test', ['http:', 'https:']), '');
    assert.equal(ue.sanitizeUrl('data:text/html,<script>alert(1)</script>'), '');

    const encoded = parseHtml(dom, ue.sanitizeHtml('<a href="java&#x73;cript:alert(1)">encoded</a>'));
    assert.equal(encoded.querySelector('a').hasAttribute('href'), false);

    const editor = loadEditorRuntime(dom);
    let rangeRequested = false;
    editor.selection.getRange = () => {
        rangeRequested = true;
        throw new Error('invalid href must be rejected before touching the selection');
    };
    dom.window.UE.commands.link.execCommand.call(editor, 'link', { href: 'javascript:alert(2)' });
    assert.equal(rangeRequested, false);
});

test('setContent enforces sanitization and configured filterRules, and preserves normal rich content on output', () => {
    const dom = makeDom();
    const editor = loadEditorRuntime(dom, {
        filterRules: { p: { $: { title: true } } }
    });
    editor.setContent(
        '<p class="removed" title="kept">text<img src="https://images.example.test/a.png" onerror="alert(1)"></p>' +
        '<a href="javascript:alert(2)">unsafe link</a>' +
        '<script>alert(3)</script>' +
        '<div cdata_tag="script" cdata_data="alert(4)" _ue_custom_node_="true"></div>',
        false,
        true
    );

    const paragraph = editor.body.querySelector('p');
    assert.ok(paragraph);
    assert.equal(paragraph.getAttribute('title'), 'kept');
    assert.equal(paragraph.hasAttribute('class'), false, 'setContent applies configured filterRules');
    assert.equal(editor.body.querySelector('script'), null);
    assert.equal(editor.body.querySelector('[onerror], [cdata_tag], [cdata_data], [_ue_custom_node_]'), null);
    const unsafeAnchor = editor.body.querySelector('a');
    assert.ok(!unsafeAnchor || !unsafeAnchor.hasAttribute('href'));

    const richEditor = loadEditorRuntime(makeDom());
    richEditor.setContent(
        '<table><tbody><tr><td><p><strong>bold</strong></p></td></tr></tbody></table>' +
        '<p><a href="https://safe.example.test">link</a>' +
        '<img src="https://images.example.test/ok.png">' +
        '<span style="color: rgb(255, 0, 0)">styled</span></p>',
        false,
        true
    );
    const output = richEditor.getContent(null, null, true);
    const roundTrip = parseHtml(dom, output);
    assert.ok(roundTrip.querySelector('table td strong'));
    assert.equal(roundTrip.querySelector('a').getAttribute('href'), 'https://safe.example.test');
    assert.equal(roundTrip.querySelector('img').getAttribute('src'), 'https://images.example.test/ok.png');
    assert.equal(roundTrip.querySelector('span').style.color, 'rgb(255, 0, 0)');
});

test('source mode sanitizes both source editor writes and getContent before returning to visual mode', async () => {
    const dom = makeDom();
    const editor = loadEditorRuntime(dom);
    editor.setContent('<p>safe</p>', false, true);

    editor.commands.source.execCommand.call(editor);
    await new Promise(resolve => setTimeout(resolve, 0));
    const source = editor.iframe.parentNode.querySelector('textarea');
    assert.ok(source);

    editor.setContent('<img src=x onerror="alert(1)"><a href="javascript:alert(2)">x</a>');
    assert.doesNotMatch(source.value, /onerror|javascript:/i);
    assert.doesNotMatch(editor.getContent(), /onerror|javascript:/i);

    source.value = '<p>edited</p><img src=x onerror="alert(3)">';
    assert.doesNotMatch(editor.getContent(), /onerror/i);
    editor.commands.source.execCommand.call(editor);
    assert.doesNotMatch(editor.body.innerHTML, /onerror|javascript:|<script/i);
    assert.match(editor.body.textContent, /edited/);
});

test('Markdown and DOCX import previews and confirmation use sanitized DOM content', async () => {
    const dom = makeDom(
        '<!doctype html><html><body><div class="file-tip"></div><div class="file-result"></div>' +
        '<input id="contentImport"><button id="fileInputConfirm"></button><textarea id="fileInputContent"></textarea></body></html>'
    );
    const ue = loadSanitizer(dom);
    loadIntoWindow(dom, 'dialogs/contentimport/showdown.min.js');
    const jqueryCalls = [];
    dom.window.$ = function (selector) {
        const nodes = Array.from(dom.window.document.querySelectorAll(selector));
        return {
            text(value) {
                nodes.forEach(node => { node.textContent = value; });
                return this;
            },
            show() {
                nodes.forEach(node => { node.style.display = ''; });
                return this;
            },
            hide() {
                nodes.forEach(node => { node.style.display = 'none'; });
                return this;
            },
            html() {
                jqueryCalls.push('html');
                throw new Error('unsafe jQuery HTML sink used');
            }
        };
    };
    dom.window.$G = id => dom.window.document.getElementById(id);
    let inserted = '';
    dom.window.editor = {
        fireEvent() {},
        execCommand(command, html) {
            assert.equal(command, 'inserthtml');
            inserted = html;
        }
    };
    dom.window.dialog = {};
    loadIntoWindow(dom, 'dialogs/contentimport/contentimport.js');

    const edgeInput = '<!DOCTYPE html><option><img src=x onerror="alert(1)"></option><img src=x onerror="alert(2)"/>';
    dom.window.processMarkdown(edgeInput);
    const preview = dom.window.document.querySelector('.file-result');
    assert.equal(preview.querySelector('[onerror]'), null);
    assert.doesNotMatch(dom.window.contentImport.data.result, /onerror/i);
    assert.deepEqual(jqueryCalls, [], 'preview does not send sanitized HTML through jQuery .html()');
    dom.window.addOkListener();

    dom.window.FileReader = function () {};
    dom.window.FileReader.prototype.readAsArrayBuffer = function () {
        this.onload({ target: { result: new ArrayBuffer(0) } });
    };
    dom.window.mammoth = {
        images: { imgElement(callback) { return callback; } },
        convertToHtml() {
            return Promise.resolve({
                value: '<!DOCTYPE html><option><img src=x onerror="alert(5)"></option><img src=x onerror="alert(6)"/>'
            });
        }
    };
    dom.window.processWord({ name: 'unsafe.docx' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preview.querySelector('[onerror]'), null, 'DOCX conversion is sanitized before preview');
    assert.doesNotMatch(dom.window.contentImport.data.result, /onerror/i);
    dom.window.dialog.onok();
    assert.doesNotMatch(inserted, /onerror/i, 'DOCX conversion is sanitized again before insertion');

    dom.window.contentImport.data.result = '<img src=x onerror="alert(3)">';
    assert.notEqual(dom.window.dialog.onok(), false);
    assert.doesNotMatch(inserted, /onerror/i);
    assert.deepEqual(jqueryCalls, []);
    assert.equal(ue.sanitizeHtml('<img src=x onerror="alert(4)">').includes('onerror'), false);
});

test('insertframe dialog rejects dangerous URLs and sanitizes direct replacement of an existing iframe', () => {
    const markup = fs.readFileSync(path.join(REPO_ROOT, 'dialogs/insertframe/insertframe.html'), 'utf8');
    const dom = makeDom(markup);
    loadSanitizer(dom);
    const doc = dom.window.document;
    const existing = doc.createElement('iframe');
    existing.setAttribute('src', 'https://old.example.test/embed');
    doc.body.appendChild(existing);
    const alerts = [];
    let closed = false;
    dom.window.alert = message => alerts.push(message);
    dom.window.$G = id => doc.getElementById(id);
    dom.window.$focus = () => {};
    dom.window.lang = { enterAddress: 'address required' };
    dom.window.dialog = { close() { closed = true; } };
    dom.window.editor = { _iframe: existing, document: doc, execCommand() { throw new Error('existing iframe path must not bypass replacement'); } };

    const inline = Array.from(doc.querySelectorAll('script:not([src])'))
        .map(script => script.textContent)
        .find(source => source.includes('function queding'));
    assert.ok(inline);
    dom.window.eval(inline);

    dom.window.$G('url').value = 'javascript:parent.document.body.setAttribute("data-xss","1")//http://example.test';
    dom.window.dialog.onok();
    assert.equal(existing.isConnected, true, 'dangerous URL does not replace the existing frame');
    assert.equal(closed, false);
    assert.equal(alerts.length, 1);

    const sanitizer = dom.window.UE.sanitizeHtml;
    dom.window.UE.sanitizeHtml = null;
    dom.window.$G('url').value = 'https://safe.example.test/embed';
    dom.window.dialog.onok();
    assert.equal(existing.isConnected, true, 'missing content sanitizer does not replace an existing frame');
    assert.equal(closed, false);
    assert.equal(alerts.length, 2);
    dom.window.UE.sanitizeHtml = sanitizer;

    dom.window.$G('url').value = 'https://safe.example.test/embed';
    dom.window.dialog.onok();
    const replaced = doc.querySelector('iframe');
    assert.notEqual(replaced, existing);
    assert.equal(replaced.getAttribute('src'), 'https://safe.example.test/embed');
    assert.equal(replaced.getAttribute('sandbox'), '');
    assert.equal(replaced.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(replaced.hasAttribute('allow'), false);
    assert.equal(replaced.hasAttribute('srcdoc'), false);
    assert.equal(closed, true);
});
