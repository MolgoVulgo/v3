/**
 * Format memory bytes to GB string
 */
function formatMemory(used, total) {
    const usedGB = (used / (1024 ** 3)).toFixed(2);
    const totalGB = (total / (1024 ** 3)).toFixed(2);
    return `${usedGB} / ${totalGB}`;
}

/**
 * Format CPU usage as percentage
 */
function formatCPU(cpuUsage) {
    if (typeof cpuUsage === 'number' && !isNaN(cpuUsage)) {
        return cpuUsage.toFixed(2);
    }
    return "N/A";
}

/**
 * Met à jour les stats CPU/MEM du host
 */
function updateHostStats(cpu, memory) {
    const cpuElement = document.getElementById("cpu-usage");
    const memElement = document.getElementById("memory-host");

    if (cpuElement) cpuElement.textContent = formatCPU(cpu) + "%";
    if (memElement && memory) {
        memElement.textContent = formatMemory(memory.used, memory.total) + " GB";
    }
}

/**
 * Update a server card with new status/metrics
 */
function updateCardFromStatus(serverName, status, cpu, memory) {
    const statusElement = document.getElementById(`status-hidden-${serverName}`);
    if (statusElement) statusElement.textContent = status;

    const badgeElement = document.getElementById(`status-badge-${serverName}`);
    if (badgeElement) {
        badgeElement.classList.remove("bg-success", "bg-warning", "bg-secondary");
    
        if (status === "running") {
            badgeElement.classList.add("bg-success");
        } else if (status === "startup") {
            badgeElement.classList.add("bg-warning");
        } else {
            badgeElement.classList.add("bg-secondary");
        }
    
        badgeElement.textContent = status;
    }

    const cpuElement = document.getElementById(`cpu-${serverName}`);
    if (cpuElement && cpu !== undefined) {
        cpuElement.textContent = formatCPU(cpu);
    }

    const memElement = document.getElementById(`memory-${serverName}`);
    if (memElement && memory) {
        memElement.textContent = formatMemory(memory.used, memory.total);
    }

    // Affichage dynamique
    const metrics = document.getElementById(`metrics-${serverName}`);
    if (metrics) {
        metrics.classList.toggle("d-none", status === "off");
    }

    const players = document.getElementById(`players-${serverName}-wrapper`);
    if (players) {
        players.classList.toggle("d-none", status !== "running");
    }

    const tabs = document.getElementById(`tabs-${serverName}`);
    const msg = document.getElementById(`state-msg-${serverName}`);
    if (tabs && msg) {
        tabs.classList.toggle("d-none", status !== "running");
        msg.classList.toggle("d-none", status === "running");
    }

    const btnStart = document.querySelector(`.btn-start[data-server="${serverName}"]`);
    const btnStop = document.querySelector(`.btn-stop[data-server="${serverName}"]`);
    const btnRestart = document.querySelector(`.btn-restart[data-server="${serverName}"]`);
    if (btnStart) btnStart.disabled = status !== "off";
    if (btnStop) btnStop.disabled = status !== "running";
    if (btnRestart) btnRestart.disabled = status !== "running";

}

/**
 * Trigger UI refresh after manual server action
 */
function updateServerStatus(serverName) {
    console.debug(`🔄 Refreshing status for server: ${serverName}`);
    const cpuElement = document.getElementById(`cpu-${serverName}`);
    const memElement = document.getElementById(`memory-${serverName}`);
    const logElement = document.getElementById(`log-${serverName}`);
    const statusElement = document.getElementById(`status-hidden-${serverName}`);

    if (cpuElement) cpuElement.textContent = "N/A";
    if (memElement) memElement.textContent = "N/A";
    if (logElement) logElement.textContent = "Initializing...";
    if (statusElement) statusElement.textContent = "startup";

    const headerElement = document.getElementById(`server-name-${serverName}`);
    if (headerElement) {
        headerElement.classList.remove("bg-success", "bg-warning", "bg-secondary");
        headerElement.classList.add("bg-warning");
    }
}

async function startServer(serverName) {
    try {
        const response = await fetch(`/api/server/${serverName}/action/start`, {
            method: "POST"
        });
        if (!response.ok) throw new Error(`Error starting server ${serverName}`);
        updateServerStatus(serverName);
    } catch (err) {
        console.error("Failed to start server:", err.message);
    }
}

async function stopServer(serverName) {
    try {
        const response = await fetch(`/api/server/${serverName}/action/stop`, {
            method: "POST"
        });
        if (!response.ok) throw new Error(`Error stopping server ${serverName}`);
        updateServerStatus(serverName);
    } catch (err) {
        console.error("Failed to stop server:", err.message);
    }
}

async function restartServer(serverName) {
    try {
        const response = await fetch(`/api/server/${serverName}/action/restart`, {
            method: "POST"
        });
        if (!response.ok) throw new Error(`Error restarting server ${serverName}`);
        updateServerStatus(serverName);
    } catch (err) {
        console.error("Failed to restart server:", err.message);
    }
}

function attachServerControls() {
    document.body.addEventListener("click", async (event) => {
        const button = event.target.closest("button");
        if (!button) return;

        const serverName = button.dataset.server;
        if (!serverName) return;

        if (button.classList.contains("btn-start")) {
            await startServer(serverName);
        } else if (button.classList.contains("btn-stop")) {
            await stopServer(serverName);
        } else if (button.classList.contains("btn-restart")) {
            await restartServer(serverName);
        }
    });
}

socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'statusUpdate' && data.servers) {
        Object.keys(data.servers).forEach(serverName => {
            const serverData = data.servers[serverName];
            updateCardFromStatus(serverName, serverData.status, serverData.CPU_USAGE, serverData.MEMORY_USAGE);
        });
    }

    if (
        data.type === "monitoring" &&
        data.scope === "server" &&
        data.event === "status" &&
        data.target
    ) {
        const serverName = data.target;
        const status = data.data.status;
        const cpu = data.data.CPU_USAGE;
        const memory = data.data.MEMORY_USAGE;
        updateCardFromStatus(serverName, status, cpu, memory);
    }

    if (
        data.type === "monitoring" &&
        data.scope === "host" &&
        data.event === "stats" &&
        data.target === "host"
    ) {
        const cpu = parseFloat(data.data?.CPU_USAGE);
        const memory = data.data?.MEMORY_USAGE;
        updateHostStats(cpu, memory);
    }

    if (data.type === 'log' && data.serverName && data.state) {
        const logElement = document.getElementById(`log-${data.serverName}`);
        if (logElement) {
            logElement.textContent += `\n${data.state}`;
            logElement.scrollTop = logElement.scrollHeight;
        }
    }

    if (
        data.type === "monitoring" &&
        data.scope === "server" &&
        data.event === "log" &&
        data.target &&
        data.data?.message
    ) {
        const logElement = document.getElementById(`log-${data.target}`);
        if (logElement) {
            logElement.textContent += `\n${data.data.message}`;
            logElement.scrollTop = logElement.scrollHeight;
        }
    }

    if (
        data.type === "monitoring" &&
        data.scope === "container" &&
        data.event === "stats" &&
        data.target &&
        data.data
      ) {
        const serverName = data.target;
        const cpu = parseFloat(data.data?.CPU_USAGE);
        const memoryUsed = data.data?.MEMORY_USAGE?.used;
        const memoryGB = memoryUsed ? (memoryUsed / (1024 ** 3)).toFixed(2) : 'N/A';
      
        const cpuEl = document.getElementById(`cpu-${serverName}`);
        const memoryEl = document.getElementById(`memory-${serverName}`);
      
        if (cpuEl) cpuEl.textContent = cpu.toFixed(2);
        if (memoryEl) memoryEl.textContent = memoryGB;
      }

});

document.addEventListener("DOMContentLoaded", () => {
    attachServerControls();
});
