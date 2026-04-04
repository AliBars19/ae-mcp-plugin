/**
 * JSON-RPC Dispatcher — routes method names to ExtendScript handler functions.
 *
 * Each handler receives (params, evalScript, log) and returns a Promise<any>.
 * The dispatcher wraps ExtendScript calls and parses JSON results.
 */
/* exported createDispatcher */

function createDispatcher(evalExtendScript, log, updateRender) {
    "use strict";

    // ── Helper: run ExtendScript and parse JSON result ──
    function evalJSON(code) {
        return evalExtendScript(code).then(function (raw) {
            if (!raw || raw === "undefined" || raw === "null") return null;
            try {
                return JSON.parse(raw);
            } catch (e) {
                // Return raw string if not JSON
                return raw;
            }
        });
    }

    // Escape a string for safe embedding in ExtendScript
    function escapeForJSX(str) {
        if (!str) return "";
        return str
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            .replace(/\0/g, "\\0")
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029");
    }

    // ── Method handlers ──
    var handlers = {
        // ─── Project ───
        "project.getInfo": function () {
            return evalJSON("__bridge_getProjectInfo()");
        },

        "project.listComps": function (params) {
            var filter = params.filter ? escapeForJSX(params.filter) : "";
            return evalJSON('__bridge_listComps("' + filter + '")');
        },

        "project.search": function (params) {
            var query = escapeForJSX(params.query || "");
            var type = escapeForJSX(params.type || "");
            return evalJSON('__bridge_searchProject("' + query + '", "' + type + '")');
        },

        // ─── Layers ───
        "layers.list": function (params) {
            var comp = escapeForJSX(params.comp || "");
            return evalJSON('__bridge_listLayers("' + comp + '")');
        },

        "layers.getProperties": function (params) {
            var comp = escapeForJSX(params.comp || "");
            var layer = escapeForJSX(params.layer || "");
            return evalJSON('__bridge_getLayerProperties("' + comp + '", "' + layer + '")');
        },

        // ─── Expressions ───
        "expressions.get": function (params) {
            var comp = escapeForJSX(params.comp || "");
            var layer = params.layer ? escapeForJSX(params.layer) : "";
            return evalJSON('__bridge_getExpressions("' + comp + '", "' + layer + '")');
        },

        "expressions.evalAtTime": function (params) {
            var comp = escapeForJSX(params.comp || "");
            var layer = escapeForJSX(params.layer || "");
            var property = escapeForJSX(params.property || "");
            var time = Number(params.time) || 0;
            return evalJSON(
                '__bridge_evalExpressionAtTime("' + comp + '", "' + layer + '", "' + property + '", ' + time + ')'
            );
        },

        "expressions.evalAtTimes": function (params) {
            var comp = escapeForJSX(params.comp || "");
            var layer = escapeForJSX(params.layer || "");
            var property = escapeForJSX(params.property || "");
            var times = JSON.stringify(params.times || []);
            return evalJSON(
                '__bridge_evalExpressionAtTimes("' + comp + '", "' + layer + '", "' + property + '", \'' + times + '\')'
            );
        },

        // ─── Execute ───
        "execute.eval": function (params) {
            var code = params.code || "";
            var start = Date.now();
            return evalExtendScript(code).then(function (result) {
                return {
                    result: result,
                    executionTime: Date.now() - start
                };
            });
        },

        "execute.runFile": function (params) {
            var filePath = escapeForJSX(params.path || "");
            var start = Date.now();
            return evalJSON(
                '(function(){ try { $.evalFile("' + filePath + '"); return JSON.stringify({success:true}); } ' +
                'catch(e) { return JSON.stringify({success:false, error:e.toString()}); } })()'
            ).then(function (result) {
                if (result) result.executionTime = Date.now() - start;
                return result;
            });
        },

        "execute.validateFile": function (params) {
            var filePath = escapeForJSX(params.path || "");
            var dryRun = params.dryRun === true;
            return evalJSON(
                '__bridge_validateJSXFile("' + filePath + '", ' + dryRun + ')'
            );
        },

        // ─── Render ───
        "render.getQueue": function () {
            return evalJSON("__bridge_getRenderQueue()");
        },

        "render.monitor": function (params) {
            var timeout = Number(params.timeout) || 60000;
            var interval = Number(params.interval) || 2000;
            return pollRender(timeout, interval);
        },

        "render.checkOutput": function (params) {
            var filePath = params.path || "";
            // Reject paths with traversal sequences
            if (filePath.indexOf("..") !== -1) {
                return Promise.reject(new Error("Path traversal not allowed"));
            }
            // Use Node.js fs for file checks (CEP has Node.js runtime)
            try {
                var fs = require("fs");
                var path = require("path");
                var resolved = path.resolve(filePath);
                var stats = fs.statSync(resolved);
                return Promise.resolve({
                    exists: true,
                    size: stats.size,
                    modified: stats.mtime.toISOString()
                });
            } catch (e) {
                return Promise.resolve({
                    exists: false
                });
            }
        },

        // ─── Context ───
        "context.read": function (params) {
            var key = params.key || null;
            try {
                var fs = require("fs");
                var path = require("path");
                var contextPath = path.join(
                    process.env.APPDATA || "",
                    "Apollova",
                    "ae-mcp-context.json"
                );
                if (!fs.existsSync(contextPath)) {
                    return Promise.resolve(key ? null : {});
                }
                var data = JSON.parse(fs.readFileSync(contextPath, "utf8"));
                return Promise.resolve(key ? data[key] : data);
            } catch (e) {
                return Promise.reject(new Error("Context read failed: " + e.message));
            }
        },

        "context.write": function (params) {
            var key = params.key;
            var value = params.value;
            if (!key) return Promise.reject(new Error("Key is required"));
            try {
                var fs = require("fs");
                var path = require("path");
                var dir = path.join(process.env.APPDATA || "", "Apollova");
                var contextPath = path.join(dir, "ae-mcp-context.json");

                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                var data = {};
                if (fs.existsSync(contextPath)) {
                    data = JSON.parse(fs.readFileSync(contextPath, "utf8"));
                }
                data[key] = value;
                data._updated = new Date().toISOString();
                fs.writeFileSync(contextPath, JSON.stringify(data, null, 2), "utf8");

                return Promise.resolve({ success: true, timestamp: data._updated });
            } catch (e) {
                return Promise.reject(new Error("Context write failed: " + e.message));
            }
        }
    };

    // ── Render polling ──
    function pollRender(timeout, interval) {
        var start = Date.now();
        return new Promise(function (resolve, reject) {
            function check() {
                if (Date.now() - start > timeout) {
                    resolve({ completed: false, timedOut: true });
                    return;
                }
                evalJSON("__bridge_getRenderQueue()").then(function (queue) {
                    if (!queue || !queue.items || queue.items.length === 0) {
                        resolve({ completed: true, items: [] });
                        return;
                    }

                    var total = queue.items.length;
                    var done = queue.items.filter(function (item) {
                        return item.status === "done" || item.status === "error";
                    }).length;

                    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    updateRender(pct, done + "/" + total + " complete");
                    log("Render progress: " + pct + "%", "info");

                    if (done >= total) {
                        updateRender(100, "Complete");
                        resolve({ completed: true, items: queue.items });
                    } else {
                        setTimeout(check, interval);
                    }
                }).catch(function (err) {
                    reject(err);
                });
            }
            check();
        });
    }

    // ── Public API ──
    return {
        handle: function (method, params) {
            var handler = handlers[method];
            if (!handler) {
                return Promise.reject(
                    new Error("Method not found: " + method)
                );
            }
            try {
                return handler(params);
            } catch (e) {
                return Promise.reject(e);
            }
        }
    };
}
