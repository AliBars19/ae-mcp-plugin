/**
 * AE MCP Bridge — CEP Panel Entry Point
 *
 * Starts a WebSocket server on 127.0.0.1:9741 that accepts JSON-RPC
 * requests from the MCP server and routes them to ExtendScript via
 * csInterface.evalScript().
 */
/* global CSInterface */

(function () {
    "use strict";

    var cs = new CSInterface();
    var WS_PORT = 9741;

    // ── UI refs ──
    var statusDot   = document.getElementById("statusDot");
    var statusLabel  = document.getElementById("statusLabel");
    var clientCount  = document.getElementById("clientCount");
    var cmdCount     = document.getElementById("cmdCount");
    var renderBar    = document.getElementById("renderBar");
    var renderStatus = document.getElementById("renderStatus");
    var logArea      = document.getElementById("logArea");

    var clients     = new Set();
    var totalCmds   = 0;

    var commandHistory = [];
    var MAX_HISTORY = 50;

    function addToHistory(method, params, duration, success) {
        commandHistory.unshift({
            method: method,
            params: Object.keys(params || {}),
            timestamp: new Date().toLocaleTimeString(),
            duration: duration + "ms",
            success: success
        });
        if (commandHistory.length > MAX_HISTORY) {
            commandHistory.pop();
        }
        updateHistoryUI();
    }

    function updateHistoryUI() {
        var historyEl = document.getElementById("historyArea");
        if (!historyEl) return;
        historyEl.innerHTML = "";
        for (var i = 0; i < Math.min(commandHistory.length, 10); i++) {
            var cmd = commandHistory[i];
            var el = document.createElement("div");
            el.className = "history-entry " + (cmd.success ? "success" : "error");
            el.textContent = cmd.timestamp + " " + cmd.method + " (" + cmd.duration + ")";
            historyEl.appendChild(el);
        }
    }

    // ── Logging ──
    function log(msg, type) {
        type = type || "info";
        var ts = new Date().toLocaleTimeString();
        var el = document.createElement("div");
        el.className = "log-entry " + type;
        el.textContent = "[" + ts + "] " + msg;
        logArea.appendChild(el);
        logArea.scrollTop = logArea.scrollHeight;
        // Keep last 200 entries
        while (logArea.children.length > 200) {
            logArea.removeChild(logArea.firstChild);
        }
    }

    function updateClientCount() {
        clientCount.textContent = String(clients.size);
        if (clients.size > 0) {
            statusDot.classList.remove("reconnecting");
            statusDot.classList.add("connected");
            statusLabel.textContent = clients.size + " client(s) connected";
        } else {
            statusDot.classList.remove("connected");
            statusLabel.textContent = "Waiting for connection...";
        }
    }

    // ── ExtendScript bridge ──
    function evalExtendScript(code) {
        return new Promise(function (resolve, reject) {
            cs.evalScript(code, function (result) {
                if (result === "EvalScript error.") {
                    reject(new Error("ExtendScript evaluation error"));
                } else {
                    resolve(result);
                }
            });
        });
    }

    // ── Dispatcher (imported) ──
    var dispatcher = null;

    function loadDispatcher() {
        // dispatcher.js must be loaded after main.js sets up evalExtendScript
        var script = document.createElement("script");
        script.src = "js/dispatcher.js";
        script.onload = function () {
            if (typeof window.createDispatcher === "function") {
                dispatcher = window.createDispatcher(evalExtendScript, log, updateRender);
                log("Dispatcher loaded", "success");
            }
        };
        document.head.appendChild(script);
    }

    // ── Render progress update ──
    function updateRender(progress, status) {
        renderBar.style.width = Math.min(100, Math.max(0, progress)) + "%";
        renderStatus.textContent = status || "Idle";
    }

    // ── WebSocket server ──
    function startServer() {
        try {
            var WebSocketServer = require("ws").Server;
            var wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT, maxPayload: 10 * 1024 * 1024 });

            wss.on("listening", function () {
                log("WebSocket server listening on 127.0.0.1:" + WS_PORT, "success");
            });

            wss.on("connection", function (socket) {
                clients.add(socket);
                updateClientCount();
                log("Client connected (" + clients.size + " total)", "info");

                // Auth state for this socket
                var authenticated = false;
                var authTimeout = setTimeout(function () {
                    if (!authenticated) {
                        log("Auth timeout — disconnecting client", "error");
                        socket.close(4001, "Authentication timeout");
                    }
                }, 5000);

                // Check if auth is disabled via env
                var authDisabled = process.env.AE_MCP_AUTH === "0";
                if (authDisabled) {
                    authenticated = true;
                    clearTimeout(authTimeout);
                    log("Auth disabled (AE_MCP_AUTH=0)", "info");
                }

                socket.on("message", function (raw) {
                    // Handle auth message
                    if (!authenticated) {
                        try {
                            var authMsg = JSON.parse(raw.toString());
                            if (authMsg.type === "auth" && authMsg.token) {
                                var secret = window.__bridgeAuth.loadOrCreateSecret();
                                if (window.__bridgeAuth.validateToken(authMsg.token, secret)) {
                                    authenticated = true;
                                    clearTimeout(authTimeout);
                                    log("Client authenticated", "success");
                                    socket.send(JSON.stringify({ type: "auth", success: true }));
                                } else {
                                    log("Invalid auth token", "error");
                                    socket.close(4001, "Invalid token");
                                }
                            } else {
                                log("Expected auth message, got: " + (authMsg.method || "unknown"), "error");
                                socket.close(4001, "Authentication required");
                            }
                        } catch (e) {
                            socket.close(4001, "Invalid auth message");
                        }
                        return;
                    }

                    totalCmds++;
                    cmdCount.textContent = String(totalCmds);

                    var request;
                    try {
                        request = JSON.parse(raw.toString());
                    } catch (e) {
                        socket.send(JSON.stringify({
                            jsonrpc: "2.0",
                            id: null,
                            error: { code: -32700, message: "Parse error" }
                        }));
                        return;
                    }

                    if (!request.method || !request.id) {
                        socket.send(JSON.stringify({
                            jsonrpc: "2.0",
                            id: request.id || null,
                            error: { code: -32600, message: "Invalid request" }
                        }));
                        return;
                    }

                    log(request.method, "info");

                    if (!dispatcher) {
                        socket.send(JSON.stringify({
                            jsonrpc: "2.0",
                            id: request.id,
                            error: { code: -32603, message: "Dispatcher not ready" }
                        }));
                        return;
                    }

                    var startTime = Date.now();
                    dispatcher.handle(request.method, request.params || {})
                        .then(function (result) {
                            var duration = Date.now() - startTime;
                            addToHistory(request.method, request.params, duration, true);
                            socket.send(JSON.stringify({
                                jsonrpc: "2.0",
                                id: request.id,
                                result: result
                            }));
                        })
                        .catch(function (err) {
                            var duration = Date.now() - startTime;
                            addToHistory(request.method, request.params, duration, false);
                            log("Error: " + err.message, "error");
                            socket.send(JSON.stringify({
                                jsonrpc: "2.0",
                                id: request.id,
                                error: { code: -32603, message: err.message }
                            }));
                        });
                });

                socket.on("close", function () {
                    clearTimeout(authTimeout);
                    clients.delete(socket);
                    updateClientCount();
                    if (clients.size === 0) {
                        statusDot.classList.add("reconnecting");
                        statusDot.classList.remove("connected");
                        statusLabel.textContent = "Reconnecting...";
                    }
                    log("Client disconnected (" + clients.size + " remaining)", "info");
                });

                socket.on("error", function (err) {
                    log("Socket error: " + err.message, "error");
                });
            });

            wss.on("error", function (err) {
                log("Server error: " + err.message, "error");
            });

        } catch (err) {
            log("Failed to start server: " + err.message, "error");
        }
    }

    // ── Init ──
    log("Initializing AE MCP Bridge...", "info");
    loadDispatcher();
    startServer();
})();
