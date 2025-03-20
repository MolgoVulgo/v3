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
        const response = await fetch("/api/servers");
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
        const response = await fetch(`/api/servers/${serverName}/start`, { method: "POST" });
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
        const response = await fetch(`/api/servers/${serverName}/stop`, { method: "POST" });
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
        const response = await fetch(`/api/servers/${serverName}/restart`, { method: "POST" });
        if (!response.ok) throw new Error(`Error restarting server ${serverName}`);
        updateServerStatus(serverName);
    } catch (error) {
        console.error("Failed to restart server:", error);
    }
}

/*=======================================================================
 *                     STATUS UPDATES
 *======================================================================*/

/**
 * Updates the server's visual status on the dashboard.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {Promise<void>}
 */
async function updateServerStatus(serverName) {
    try {
        const response = await fetch(`/api/servers/${serverName}/status`);
        if (!response.ok) throw new Error("Failed to fetch server status");

        const data = await response.json();
        const statusElement = document.getElementById(`status-hidden-${serverName}`);

        if (!statusElement) return;

        statusElement.textContent = data.state;

        const headerElement = document.getElementById(`server-name-${serverName}`);
        headerElement.classList.remove("bg-success", "bg-warning", "bg-secondary");

        if (data.state === "running") {
            headerElement.classList.add("bg-success");
        } else if (data.state === "startup") {
            headerElement.classList.add("bg-warning");
        } else {
            headerElement.classList.add("bg-secondary");
        }

    } catch (error) {
        console.error(`Error updating server status for ${serverName}:`, error);
    }
}

/**
 * Refreshes all servers' status on the dashboard.
 * 
 * @returns {Promise<void>}
 */
async function refreshAllServersStatus() {
    const response = await fetch("/api/servers");
    const servers = await response.json();
    servers.forEach(server => {
        updateServerStatus(server.SERVER_NAME);
    });
}
