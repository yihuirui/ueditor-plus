/**
 * Shared HTML sanitizer for untrusted editor content.
 * The isolated, pinned DOMPurify instance is loaded immediately after this
 * file in editor_api.js. It is separate from page globals and AMD loaders.
 */
(function (global) {
    var UE = global.UE;
    var hookedPurifier = null;
    var sanitizerConfig = {
        FORBID_TAGS: [
            "script",
            "style",
            "object",
            "embed",
            "applet",
            "base",
            "meta",
            "link",
            "template",
            "noscript"
        ],
        FORBID_ATTR: [
            "cdata_tag",
            "cdata_data",
            "_ue_custom_node_",
            "_src",
            "_href",
            "srcdoc",
            "allow",
            "allowfullscreen",
            "allowpaymentrequest",
            "credentialless"
        ],
        ADD_TAGS: ["iframe"],
        ADD_ATTR: [
            "sandbox",
            "referrerpolicy",
            "loading",
            "scrolling",
            "frameborder",
            "align",
            "width",
            "height"
        ],
        ALLOW_UNKNOWN_PROTOCOLS: false,
        RETURN_TRUSTED_TYPE: false
    };

    function toString(value) {
        return value === null || value === undefined ? "" : String(value);
    }

    // This is an HTML text encoder used only for the fail-closed fallback.
    // It does not attempt to sanitize or preserve markup.
    function escapeAsText(value) {
        return toString(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function resolveHttpUrl(value) {
        if (!value || !global.document || !global.document.createElement) {
            return "";
        }
        try {
            var anchor = global.document.createElement("a");
            anchor.href = String(value);
            var protocol = (anchor.protocol || "").toLowerCase();
            if (protocol === "http:" || protocol === "https:") {
                return anchor.href;
            }
        } catch (e) {
        }
        return "";
    }

    function secureInlineStyle(node) {
        if (!node || node.nodeType !== 1 || !node.hasAttribute("style")) {
            return;
        }
        var document = node.ownerDocument || global.document;
        var parser = document && document.createElement
            ? document.createElement("span")
            : null;
        if (!parser || !parser.style) {
            node.removeAttribute("style");
            return;
        }

        // Parse declarations with the browser CSS parser and serialize only
        // valid, non-dynamic declarations. This preserves normal inline text
        // formatting while removing URL functions and legacy script hooks.
        parser.setAttribute("style", node.getAttribute("style"));
        var style = parser.style;
        var declarations = [];
        for (var i = 0; i < style.length; i++) {
            var property = style.item(i);
            var value = style.getPropertyValue(property);
            var normalized = String(value).toLowerCase();
            if (
                property === "behavior" ||
                property === "-moz-binding" ||
                normalized.indexOf("url(") !== -1 ||
                normalized.indexOf("var(") !== -1 ||
                normalized.indexOf("expression(") !== -1 ||
                normalized.indexOf("-moz-binding") !== -1
            ) {
                continue;
            }
            var priority = style.getPropertyPriority(property);
            declarations.push(
                property + ":" + value + (priority ? " !important" : "")
            );
        }
        if (declarations.length) {
            node.setAttribute("style", declarations.join("; "));
        } else {
            node.removeAttribute("style");
        }
    }

    function secureSanitizedElement(node) {
        secureInlineStyle(node);
        if (
            !node ||
            node.nodeType !== 1 ||
            String(node.tagName || "").toLowerCase() !== "iframe"
        ) {
            return;
        }
        var safeSrc = resolveHttpUrl(node.getAttribute("src"));
        if (!safeSrc) {
            if (node.parentNode) {
                node.parentNode.removeChild(node);
            }
            return;
        }
        node.setAttribute("src", safeSrc);
        node.setAttribute("sandbox", "");
        node.setAttribute("referrerpolicy", "no-referrer");
        node.removeAttribute("srcdoc");
        node.removeAttribute("allow");
        node.removeAttribute("allowfullscreen");
        node.removeAttribute("allowpaymentrequest");
        node.removeAttribute("credentialless");
    }

    function getPurifier() {
        var purifier = global.UEVendorDOMPurify;
        // DOMPurify returns the original string unchanged when it cannot use
        // a supported DOM. Treat that state as unavailable, never as safe.
        if (
            !purifier ||
            purifier.isSupported !== true ||
            typeof purifier.sanitize !== "function"
        ) {
            return null;
        }
        if (hookedPurifier !== purifier && typeof purifier.addHook === "function") {
            purifier.addHook("afterSanitizeAttributes", secureSanitizedElement);
            hookedPurifier = purifier;
        }
        return purifier;
    }

    if (!UE) {
        return;
    }

    UE.sanitizeHtml = function (html) {
        var input = toString(html);
        try {
            var purifier = getPurifier();
            if (!purifier) {
                return escapeAsText(input);
            }
            var clean = purifier.sanitize(input, sanitizerConfig);
            return typeof clean === "string" ? clean : escapeAsText(input);
        } catch (e) {
            return escapeAsText(input);
        }
    };

    // Sanitize a URL through DOMPurify's URI policy. An optional protocol
    // allowlist is resolved with the browser URL parser, not a regex.
    UE.sanitizeUrl = function (url, allowedProtocols) {
        var input = toString(url);
        if (!input || !global.document || !global.document.createElement) {
            return "";
        }
        try {
            var safeAnchorHtml = UE.sanitizeHtml(
                '<a href="' + escapeAsText(input) + '">link</a>'
            );
            var container = global.document.createElement("div");
            container.innerHTML = safeAnchorHtml;
            var anchor = container.firstChild;
            if (
                !anchor ||
                String(anchor.tagName || "").toLowerCase() !== "a" ||
                !anchor.hasAttribute("href")
            ) {
                return "";
            }
            var safeUrl = anchor.getAttribute("href");
            if (allowedProtocols) {
                var resolved = global.document.createElement("a");
                resolved.href = safeUrl;
                var protocol = (resolved.protocol || "").toLowerCase();
                var allowed = false;
                for (var i = 0; i < allowedProtocols.length; i++) {
                    if (protocol === String(allowedProtocols[i]).toLowerCase()) {
                        allowed = true;
                        break;
                    }
                }
                if (!allowed) {
                    return "";
                }
                return resolved.href;
            }
            return safeUrl;
        } catch (e) {
            return "";
        }
    };
})(window);
