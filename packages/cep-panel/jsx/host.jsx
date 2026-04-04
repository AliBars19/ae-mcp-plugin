/**
 * AE MCP Bridge — Host ExtendScript
 *
 * Core functions loaded into After Effects' ExtendScript engine.
 * These are called by the CEP panel via csInterface.evalScript().
 *
 * All functions return JSON strings for safe transport back to JS.
 */

// Note: JSON polyfill removed — this extension requires AE 2024+ (manifest.xml)
// which ships with native JSON support. The eval-based polyfill was a security risk.


// ── Project Info ──
function __bridge_getProjectInfo() {
    try {
        var proj = app.project;
        var numComps = 0;
        var numFolders = 0;
        for (var i = 1; i <= proj.numItems; i++) {
            var item = proj.item(i);
            if (item instanceof CompItem) numComps++;
            else if (item instanceof FolderItem) numFolders++;
        }
        return JSON.stringify({
            name: proj.file ? proj.file.name : "(Untitled)",
            path: proj.file ? proj.file.fsName : null,
            numItems: proj.numItems,
            numComps: numComps,
            numFolders: numFolders,
            aeVersion: app.version,
            buildName: app.buildName
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── List Compositions ──
function __bridge_listComps(filter) {
    try {
        var comps = [];
        var re = filter ? new RegExp(filter, "i") : null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (!(item instanceof CompItem)) continue;
            if (re && !re.test(item.name)) continue;
            comps.push({
                name: item.name,
                id: item.id,
                width: item.width,
                height: item.height,
                duration: item.duration,
                frameRate: item.frameRate,
                numLayers: item.numLayers
            });
        }
        return JSON.stringify(comps);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Search Project ──
function __bridge_searchProject(query, type) {
    try {
        var results = [];
        var re = query ? new RegExp(query, "i") : null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (re && !re.test(item.name)) continue;

            var itemType = "unknown";
            if (item instanceof CompItem) itemType = "comp";
            else if (item instanceof FolderItem) itemType = "folder";
            else if (item instanceof FootageItem) itemType = "footage";

            if (type && itemType !== type) continue;

            results.push({
                name: item.name,
                id: item.id,
                type: itemType,
                parentFolder: item.parentFolder ? item.parentFolder.name : null
            });
        }
        return JSON.stringify(results);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── List Layers ──
function __bridge_listLayers(compName) {
    try {
        var comp = __findComp(compName);
        if (!comp) return JSON.stringify({ error: "Comp not found: " + compName });

        var layers = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            var layerType = "unknown";
            if (layer instanceof TextLayer) layerType = "text";
            else if (layer instanceof ShapeLayer) layerType = "shape";
            else if (layer instanceof CameraLayer) layerType = "camera";
            else if (layer instanceof LightLayer) layerType = "light";
            else if (layer instanceof AVLayer) layerType = "av";

            var hasExpression = false;
            try {
                hasExpression = __layerHasExpressions(layer);
            } catch (_) {}

            layers.push({
                index: i,
                name: layer.name,
                type: layerType,
                enabled: layer.enabled,
                inPoint: layer.inPoint,
                outPoint: layer.outPoint,
                hasAudio: (layer instanceof AVLayer) ? layer.hasAudio : false,
                hasExpression: hasExpression,
                locked: layer.locked
            });
        }
        return JSON.stringify(layers);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Get Layer Properties ──
function __bridge_getLayerProperties(compName, layerNameOrIndex) {
    try {
        var comp = __findComp(compName);
        if (!comp) return JSON.stringify({ error: "Comp not found: " + compName });

        var layer = __findLayer(comp, layerNameOrIndex);
        if (!layer) return JSON.stringify({ error: "Layer not found: " + layerNameOrIndex });

        var props = {
            name: layer.name,
            index: layer.index,
            enabled: layer.enabled,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            startTime: layer.startTime,
            locked: layer.locked
        };

        // Transform properties
        try {
            var transform = layer.property("Transform");
            if (transform) {
                props.position = __getPropertyValue(transform.property("Position"));
                props.scale = __getPropertyValue(transform.property("Scale"));
                props.rotation = __getPropertyValue(transform.property("Rotation"));
                props.opacity = __getPropertyValue(transform.property("Opacity"));
                props.anchorPoint = __getPropertyValue(transform.property("Anchor Point"));
            }
        } catch (_) {}

        // Source text (for text layers)
        try {
            var sourceText = layer.property("Source Text");
            if (sourceText) {
                var doc = sourceText.value;
                props.sourceText = {
                    text: doc.text,
                    fontSize: doc.fontSize,
                    font: doc.font,
                    hasExpression: sourceText.expressionEnabled,
                    expression: sourceText.expressionEnabled ? sourceText.expression : null
                };
            }
        } catch (_) {}

        // Effects list
        try {
            var effects = layer.property("Effects");
            if (effects && effects.numProperties > 0) {
                props.effects = [];
                for (var i = 1; i <= effects.numProperties; i++) {
                    var eff = effects.property(i);
                    props.effects.push({
                        name: eff.name,
                        matchName: eff.matchName,
                        enabled: eff.enabled
                    });
                }
            }
        } catch (_) {}

        // Source info (for footage layers)
        try {
            if (layer.source) {
                props.source = {
                    name: layer.source.name,
                    duration: layer.source.duration || null,
                    width: layer.source.width || null,
                    height: layer.source.height || null
                };
            }
        } catch (_) {}

        return JSON.stringify(props);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Get Expressions ──
function __bridge_getExpressions(compName, layerNameOrIndex) {
    try {
        var comp = __findComp(compName);
        if (!comp) return JSON.stringify({ error: "Comp not found: " + compName });

        var expressions = [];

        if (layerNameOrIndex) {
            // Single layer
            var layer = __findLayer(comp, layerNameOrIndex);
            if (!layer) return JSON.stringify({ error: "Layer not found: " + layerNameOrIndex });
            __collectExpressions(layer, "", expressions);
        } else {
            // All layers in comp
            for (var i = 1; i <= comp.numLayers; i++) {
                __collectExpressions(comp.layer(i), "", expressions);
            }
        }

        return JSON.stringify(expressions);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Evaluate Expression at Time ──
function __bridge_evalExpressionAtTime(compName, layerNameOrIndex, propertyPath, time) {
    try {
        var comp = __findComp(compName);
        if (!comp) return JSON.stringify({ error: "Comp not found: " + compName });

        var layer = __findLayer(comp, layerNameOrIndex);
        if (!layer) return JSON.stringify({ error: "Layer not found: " + layerNameOrIndex });

        var prop = __navigateProperty(layer, propertyPath);
        if (!prop) return JSON.stringify({ error: "Property not found: " + propertyPath });

        var value = prop.valueAtTime(time, false);

        return JSON.stringify({
            value: value,
            time: time,
            propertyPath: propertyPath,
            hasExpression: prop.expressionEnabled,
            expressionError: prop.expressionError || null
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Evaluate Expression at Multiple Times ──
function __bridge_evalExpressionAtTimes(compName, layerNameOrIndex, propertyPath, timesJSON) {
    try {
        var comp = __findComp(compName);
        if (!comp) return JSON.stringify({ error: "Comp not found: " + compName });
        var layer = __findLayer(comp, layerNameOrIndex);
        if (!layer) return JSON.stringify({ error: "Layer not found: " + layerNameOrIndex });
        var prop = __navigateProperty(layer, propertyPath);
        if (!prop) return JSON.stringify({ error: "Property not found: " + propertyPath });

        var times = JSON.parse(timesJSON);
        var results = [];
        for (var i = 0; i < times.length; i++) {
            try {
                var val = prop.valueAtTime(times[i], false);
                results.push({ time: times[i], value: val, error: null });
            } catch (e) {
                results.push({ time: times[i], value: null, error: e.toString() });
            }
        }
        return JSON.stringify(results);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Validate JSX File ──
function __bridge_validateJSXFile(filePath, dryRun) {
    try {
        var file = new File(filePath);
        if (!file.exists) {
            return JSON.stringify({
                valid: false,
                errors: ["File not found: " + filePath],
                warnings: []
            });
        }

        file.open("r");
        var code = file.read();
        file.close();

        var errors = [];
        var warnings = [];

        // Basic syntax check via eval in a controlled scope
        try {
            // Wrap in function to catch syntax errors without executing
            new Function(code);
        } catch (e) {
            errors.push("Syntax error: " + e.toString());
        }

        // Check for common issues
        if (code.indexOf("applyTemplate") !== -1) {
            warnings.push("applyTemplate() found — removed from AE 2023+, use default output module");
        }
        if (code.indexOf("renderQueue.render()") !== -1 && code.indexOf("exitAfterLaunchAndEval") === -1) {
            warnings.push("renderQueue.render() without exitAfterLaunchAndEval — may cause hangs in headless mode");
        }
        if (code.indexOf("app.quit()") !== -1) {
            warnings.push("app.quit() found — use app.exitAfterLaunchAndEval instead (quit crashes after heavy renders)");
        }
        if (code.indexOf("{{") !== -1) {
            warnings.push("Unresolved template placeholders found ({{ }})");
        }

        // Experimental dry-run via undo
        if (dryRun && errors.length === 0) {
            try {
                app.beginUndoGroup("MCP_DRY_RUN");
                $.evalFile(file);
                app.endUndoGroup();
                app.executeCommand(16); // Edit > Undo
            } catch (e) {
                errors.push("Dry-run execution error: " + e.toString());
                try { app.endUndoGroup(); } catch (_) {}
                try { app.executeCommand(16); } catch (_) {}
            }
        }

        return JSON.stringify({
            valid: errors.length === 0,
            errors: errors,
            warnings: warnings,
            lines: code.split("\n").length
        });
    } catch (e) {
        return JSON.stringify({ valid: false, errors: [e.toString()], warnings: [] });
    }
}


// ── Render Queue ──
function __bridge_getRenderQueue() {
    try {
        var rq = app.project.renderQueue;
        var items = [];
        for (var i = 1; i <= rq.numItems; i++) {
            var item = rq.item(i);
            var statusMap = {};
            statusMap[RQItemStatus.QUEUED] = "queued";
            statusMap[RQItemStatus.RENDERING] = "rendering";
            statusMap[RQItemStatus.DONE] = "done";
            statusMap[RQItemStatus.ERR_STOPPED] = "error";
            statusMap[RQItemStatus.USER_STOPPED] = "stopped";
            statusMap[RQItemStatus.UNQUEUED] = "unqueued";
            statusMap[RQItemStatus.NEEDS_OUTPUT] = "needs_output";

            var outputPath = "";
            try {
                if (item.numOutputModules > 0) {
                    outputPath = item.outputModule(1).file.fsName;
                }
            } catch (_) {}

            items.push({
                index: i,
                compName: item.comp ? item.comp.name : "unknown",
                status: statusMap[item.status] || "unknown",
                outputPath: outputPath,
                startTime: item.comp ? item.comp.workAreaStart : 0,
                duration: item.comp ? item.comp.workAreaDuration : 0
            });
        }
        return JSON.stringify({ numItems: rq.numItems, items: items });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}


// ── Save Comp Frame as PNG ──
function __bridge_saveCompFrame(compName, time, outputPath) {
    try {
        var comp = __findComp(compName);
        if (!comp) return JSON.stringify({ success: false, error: "Comp not found: " + compName });

        var outFile = new File(outputPath);
        // Ensure output directory exists
        var outDir = outFile.parent;
        if (!outDir.exists) outDir.create();

        // saveFrameToPng available in AE 2024+
        if (typeof comp.saveFrameToPng === "function") {
            comp.saveFrameToPng(time, outFile);
            return JSON.stringify({
                success: true,
                path: outFile.fsName,
                width: comp.width,
                height: comp.height,
                time: time
            });
        } else {
            return JSON.stringify({
                success: false,
                error: "saveFrameToPng not available (requires AE 2024+)"
            });
        }
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}


// ═══════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════

function __findComp(name) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem && item.name === name) return item;
    }
    return null;
}

function __findLayer(comp, nameOrIndex) {
    // Try by index first
    var idx = parseInt(nameOrIndex, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= comp.numLayers) {
        return comp.layer(idx);
    }
    // Try by name
    try { return comp.layer(nameOrIndex); } catch (_) {}
    return null;
}

function __getPropertyValue(prop) {
    if (!prop) return null;
    try { return prop.value; } catch (_) { return null; }
}

function __layerHasExpressions(layer) {
    // Check common property groups for expressions
    var groups = ["Transform", "Effects", "Source Text"];
    for (var g = 0; g < groups.length; g++) {
        try {
            var group = layer.property(groups[g]);
            if (!group) continue;
            if (group.expressionEnabled) return true;
            if (group.numProperties) {
                for (var p = 1; p <= group.numProperties; p++) {
                    var prop = group.property(p);
                    if (prop && prop.expressionEnabled) return true;
                }
            }
        } catch (_) {}
    }
    return false;
}

function __collectExpressions(layer, prefix, results) {
    var layerName = layer.name;
    var propGroups = ["Transform", "Effects", "Source Text", "Masks", "Material Options"];

    for (var g = 0; g < propGroups.length; g++) {
        try {
            var group = layer.property(propGroups[g]);
            if (!group) continue;
            __scanPropertyGroup(group, layerName, propGroups[g], results);
        } catch (_) {}
    }
}

function __scanPropertyGroup(group, layerName, path, results) {
    try {
        if (group.expressionEnabled) {
            results.push({
                layerName: layerName,
                propertyPath: path,
                expression: group.expression,
                enabled: group.expressionEnabled,
                hasError: group.expressionError ? true : false,
                error: group.expressionError || null
            });
        }
    } catch (_) {}

    try {
        if (group.numProperties) {
            for (var i = 1; i <= group.numProperties; i++) {
                var sub = group.property(i);
                if (sub) __scanPropertyGroup(sub, layerName, path + "/" + sub.name, results);
            }
        }
    } catch (_) {}
}

function __navigateProperty(layer, path) {
    if (!path) return null;
    var parts = path.split("/");
    var current = layer;
    for (var i = 0; i < parts.length; i++) {
        if (!current || !current.property) return null;
        try {
            current = current.property(parts[i]);
        } catch (_) {
            return null;
        }
    }
    return current;
}
