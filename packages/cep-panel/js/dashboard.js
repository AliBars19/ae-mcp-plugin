/**
 * Pipeline Dashboard — polls %APPDATA%/Apollova/ae-mcp-context.json
 * for pipeline status and renders it in the CEP panel.
 */
(function () {
    "use strict";

    var fs = require("fs");
    var path = require("path");

    var CONTEXT_FILE = path.join(process.env.APPDATA || "", "Apollova", "ae-mcp-context.json");
    var POLL_INTERVAL = 5000;
    var pollTimer = null;

    function readPipelineStatus() {
        try {
            if (!fs.existsSync(CONTEXT_FILE)) return null;
            var data = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
            return data.pipeline_status || null;
        } catch (e) {
            return null;
        }
    }

    function updateDashboard() {
        var pipelineBar = document.getElementById("pipelineBar");
        var pipelineStatus = document.getElementById("pipelineStatus");
        var pipelineSection = document.getElementById("pipelineSection");

        if (!pipelineBar || !pipelineStatus) return;

        var status = readPipelineStatus();

        if (!status) {
            pipelineSection.style.display = "none";
            return;
        }

        pipelineSection.style.display = "block";

        var progress = Number(status.progress) || 0;
        pipelineBar.style.width = Math.min(100, Math.max(0, progress)) + "%";

        var parts = [];
        if (status.template) parts.push(status.template);
        if (status.currentJob && status.totalJobs) {
            parts.push("Job " + status.currentJob + "/" + status.totalJobs);
        }
        if (status.stage) parts.push(status.stage);
        if (status.eta) parts.push("ETA: " + status.eta);

        pipelineStatus.textContent = parts.join(" — ") || "Processing...";
    }

    function startPolling() {
        if (pollTimer) return;
        updateDashboard();
        pollTimer = setInterval(updateDashboard, POLL_INTERVAL);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // Auto-start polling when loaded
    startPolling();

    // Export for potential external use
    window.__dashboard = {
        start: startPolling,
        stop: stopPolling,
        update: updateDashboard
    };
})();
