/*=======================================================================
 *                     SERVER LIST MANAGEMENT (index.ejs)
 *======================================================================*/

/**
 * Loads the server list and updates the display on index.ejs.
 * 
 * @returns {Promise<void>}
 */
async function loadServers() {
    try {
        const response = await fetch("/api/server");
        const servers = await response.json();
        const currentPage = document.body.dataset.page;

        if (currentPage === "index") {
            updateServersTable(servers);
        }
    } catch (error) {
        console.error("Error loading servers:", error);
    }
}

/**
 * Dynamically updates the display of servers in index.ejs.
 * 
 * @param {Array} servers - List of servers to display.
 * @returns {Promise<void>}
 */
let hasLoadedServers = false;

async function updateServersTable(servers) {
    if (hasLoadedServers) return;
    hasLoadedServers = true;

    const container = document.getElementById("servers-container");
    container.innerHTML = "";

    try {
        const response = await fetch("/templates/serverCard.hbs");
        const templateSource = await response.text();
        const template = Handlebars.compile(templateSource);

        const groupedServers = {};
        servers.forEach(server => {
            if (!groupedServers[server.CLUSTER_ID]) {
                groupedServers[server.CLUSTER_ID] = [];
            }
            if (!groupedServers[server.CLUSTER_ID].some(s => s.SERVER_NAME === server.SERVER_NAME)) {
                groupedServers[server.CLUSTER_ID].push(server);
            }
        });

        Object.keys(groupedServers).forEach(clusterId => {
            groupedServers[clusterId].sort((a, b) => a.SERVER_NAME.localeCompare(b.SERVER_NAME, undefined, { numeric: true }));
        });

        Object.keys(groupedServers).sort().forEach(clusterId => {
            groupedServers[clusterId].forEach((server, index, array) => {
                server.isFirstInCluster = index === 0;
                server.isLastInCluster = index === array.length - 1;

                const serverHTML = template(server);
                container.innerHTML += serverHTML;
            });
        });

        attachServerControls();
    } catch (error) {
        console.error("Error loading template:", error);
    }
}

/*=======================================================================
 *                     SERVER ACTIONS (START/STOP/RESTART)
 *======================================================================*/

/**
 * Attaches events to Start, Stop, Restart buttons.
 * 
 * @returns {void}
 */
function attachServerControls() {
    document.body.addEventListener("click", async (event) => {
        const button = event.target.closest("button");
        if (!button) return;

        const serverName = button.dataset.server;
        if (!serverName) return;

        console.log(`🔹 Button clicked: ${button.className}, Server: ${serverName}`);

        if (button.classList.contains("btn-start")) {
            await startServer(serverName);
        } else if (button.classList.contains("btn-stop")) {
            await stopServer(serverName);
        } else if (button.classList.contains("btn-restart")) {
            await restartServer(serverName);
        }
    });
}

/**
 * Starts a specific Ark server.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {Promise<void>}
 */
async function startServer(serverName) {
    try {
        const response = await fetch(`/api/server/${serverName}/action/start`, { method: "POST" });
        if (!response.ok) throw new Error(`Error starting server ${serverName}`);
        updateServerStatus(serverName);
    } catch (error) {
        console.error("Failed to start server:", error);
    }
}

/**
 * Stops a specific Ark server.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {Promise<void>}
 */
async function stopServer(serverName) {
    try {
        const response = await fetch(`/api/server/${serverName}/action/stop`, { method: "POST" });
        if (!response.ok) throw new Error(`Error stopping server ${serverName}`);
        updateServerStatus(serverName);
    } catch (error) {
        console.error("Failed to stop server:", error);
    }
}

/**
 * Restarts a specific Ark server.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {Promise<void>}
 */
async function restartServer(serverName) {
    try {
        const response = await fetch(`/api/server/${serverName}/action/restart`, { method: "POST" });
        if (!response.ok) throw new Error(`Error restarting server ${serverName}`);
        updateServerStatus(serverName);
    } catch (error) {
        console.error("Failed to restart server:", error);
    }
}

/*=======================================================================
 *                     STATUS UPDATES (Monitoring)
 *======================================================================*/

/**
 * Formats memory bytes to GB string.
 * @param {number} used - Memory used in bytes.
 * @param {number} total - Total memory in bytes.
 * @returns {string}
 */
function formatMemory(used, total) {
    const usedGB = (used / (1024 ** 3)).toFixed(2);
    const totalGB = (total / (1024 ** 3)).toFixed(2);
    //return `${usedGB} / ${totalGB}`;
    return `${usedGB}`;
}

/**
 * Formats CPU usage float to percentage (no % symbol, it's in HTML)
 * @param {number} cpuUsage
 * @returns {string}
 */
function formatCPU(cpuUsage) {
    if (typeof cpuUsage === 'number' && !isNaN(cpuUsage)) {
        return cpuUsage.toFixed(2);
    }
    return "N/A";
}

/*=======================================================================
 *                     INITIALIZATION
 *======================================================================*/

document.addEventListener("DOMContentLoaded", async () => {
    await loadServers();
    //await refreshAllServersStatus();

    // Auto-refresh every 10s
    setInterval(() => {
        //refreshAllServersStatus();
    }, 10000); // 10 sec
});


// Message handler
socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);

    // Status updates pushed
    if (data.type === 'statusUpdate' && data.servers) {
        Object.keys(data.servers).forEach(serverName => {
            const serverData = data.servers[serverName];

            // Update status
            const statusElement = document.getElementById(`status-hidden-${serverName}`);
            if (statusElement) statusElement.textContent = serverData.status;

            const headerElement = document.getElementById(`server-name-${serverName}`);
            if (headerElement) {
                headerElement.classList.remove("bg-success", "bg-warning", "bg-secondary");

                if (serverData.status === "running") {
                    headerElement.classList.add("bg-success");
                } else if (serverData.status === "startup") {
                    headerElement.classList.add("bg-warning");
                } else {
                    headerElement.classList.add("bg-secondary");
                }
            }

            // Update CPU
            const cpuElement = document.getElementById(`cpu-${serverName}`);
            if (cpuElement && serverData.CPU_USAGE !== undefined) {
                cpuElement.textContent = formatCPU(serverData.CPU_USAGE);
            }

            // Update Memory
            const memElement = document.getElementById(`memory-${serverName}`);
            if (memElement && serverData.MEMORY_USAGE) {
                memElement.textContent = formatMemory(
                    serverData.MEMORY_USAGE.used,
                    serverData.MEMORY_USAGE.total
                );
            }
        });
    }

    // Log updates (déjà en place)
    if (data.type === 'log' && data.serverName && data.state) {
        const logElement = document.getElementById(`log-${data.serverName}`);
        if (logElement) {
            logElement.textContent += `\n${data.state}`;
            logElement.scrollTop = logElement.scrollHeight;
        }
    }
});