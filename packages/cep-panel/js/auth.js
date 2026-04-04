/**
 * Shared secret authentication for the WebSocket bridge.
 * Generates a crypto-random token on first run, stored at %APPDATA%/Apollova/bridge-secret.json.
 * Both the CEP panel and MCP server read from the same file.
 */
(function () {
    "use strict";

    var crypto = require("crypto");
    var fs = require("fs");
    var path = require("path");

    var SECRET_DIR = path.join(process.env.APPDATA || "", "Apollova");
    var SECRET_FILE = path.join(SECRET_DIR, "bridge-secret.json");

    function loadOrCreateSecret() {
        try {
            if (fs.existsSync(SECRET_FILE)) {
                var data = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
                if (data && data.token && typeof data.token === "string") {
                    return data.token;
                }
            }
        } catch (e) {
            // Corrupted file — regenerate
        }

        // Generate new secret
        var token = crypto.randomBytes(32).toString("hex");
        try {
            if (!fs.existsSync(SECRET_DIR)) {
                fs.mkdirSync(SECRET_DIR, { recursive: true });
            }
            fs.writeFileSync(SECRET_FILE, JSON.stringify({ token: token, created: new Date().toISOString() }, null, 2), "utf8");
        } catch (e) {
            // If we can't write, still return the token for this session
        }
        return token;
    }

    function validateToken(received, expected) {
        if (!received || !expected) return false;
        try {
            var a = Buffer.from(String(received));
            var b = Buffer.from(String(expected));
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch (e) {
            return false;
        }
    }

    // Export for use in main.js
    window.__bridgeAuth = {
        loadOrCreateSecret: loadOrCreateSecret,
        validateToken: validateToken
    };
})();
