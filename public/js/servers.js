/*=======================================================================
 *                            SERVER LOADING & DISPLAY
 *======================================================================*/

/**
 * Loads the list of servers and updates the display based on the page.
 */
async function loadServers() {
    try {
        const response = await fetch("/api/servers");
        const servers = await response.json();
        const currentPage = document.body.dataset.page;

        switch (currentPage) {
            case "index":
                updateServersTable(servers);
                break;
            case "servers":
                updateClusterList(servers);
                loadClusterOptions(servers);
                break;
            default:
                console.warn("Unknown page, no update performed.");
        }
    } catch (error) {
        console.error("Error while loading servers:", error);
    }
}

/**
 * Dynamically updates server cards in index.ejs.
 * @param {Array} servers - List of servers to display.
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
        console.error("Error while loading server template:", error);
    }
}

/**
 * Updates the cluster list display (used in servers.ejs).
 * @param {Array} servers - List of servers.
 */
function updateClusterList(servers) {
    const clusterList = document.getElementById("cluster-list");
    clusterList.innerHTML = "";

    const groups = servers.reduce((acc, server) => {
        (acc[server.CLUSTER_ID] = acc[server.CLUSTER_ID] || []).push(server);
        return acc;
    }, {});

    Object.keys(groups).forEach(clusterId => {
        const groupContainer = document.createElement("div");
        groupContainer.className = "cluster-group";

        const title = document.createElement("h3");
        title.textContent = `Cluster ID: ${clusterId}`;
        groupContainer.appendChild(title);

        const ul = document.createElement("ul");
        groups[clusterId].forEach(server => {
            const li = document.createElement("li");
            li.innerHTML = `
                ${server.SERVER_NAME} (${server.MAP_NAME})
                <button onclick="editServer('${server.SERVER_NAME}')">Edit</button>
                <button onclick="deleteServer('${server.SERVER_NAME}')">Delete</button>
            `;
            ul.appendChild(li);
        });

        groupContainer.appendChild(ul);
        clusterList.appendChild(groupContainer);
    });
}

/**
 * Populates the cluster ID dropdown in the add/edit form.
 * @param {Array} servers - List of servers.
 */
function loadClusterOptions(servers) {
    const clusterSelect = document.getElementById("cluster-id");
    clusterSelect.innerHTML = "";

    const existingClusters = new Set(servers.map(server => server.CLUSTER_ID));

    existingClusters.forEach(clusterId => {
        const option = document.createElement("option");
        option.value = clusterId;
        option.textContent = clusterId;
        clusterSelect.appendChild(option);
    });

    const newOption = document.createElement("option");
    newOption.value = "new";
    newOption.textContent = "Generate New ID";
    clusterSelect.appendChild(newOption);
}

/**
 * Loads the list of available maps from API.
 */
async function loadMaps() {
    const response = await fetch("/api/maps");
    const maps = await response.json();
    const mapSelect = document.getElementById("map-name");

    mapSelect.innerHTML = "";

    maps.forEach(map => {
        const option = document.createElement("option");
        option.value = map;
        option.textContent = map;
        mapSelect.appendChild(option);
    });
}

/*=======================================================================
 *                           SERVER CRUD ACTIONS
 *======================================================================*/

/**
 * Deletes a server after confirmation.
 * @param {string} serverName - Server name.
 */
async function deleteServer(serverName) {
    const confirmDelete = confirm(`Are you sure you want to delete the server: ${serverName}?`);
    if (!confirmDelete) return;

    await fetch(`/api/servers/${serverName}`, { method: "DELETE" });
    loadServers();
}

/**
 * Loads server details into the form for editing.
 * @param {string} serverName - Server name.
 */
async function editServer(serverName) {
    const response = await fetch(`/api/servers/${serverName}`);
    const server = await response.json();

    document.getElementById("server-name").value = server.SERVER_NAME;
    document.getElementById("map-name").value = server.MAP_NAME;
    document.getElementById("port").value = server.PORT;
    document.getElementById("rcon-port").value = server.RCON_PORT;
    document.getElementById("max-players").value = server.MAX_PLAYERS;
    document.getElementById("mods").value = server.MODS || "";
    document.getElementById("cluster-id").value = server.CLUSTER_ID;
    document.getElementById("enabled").checked = server.ENABLED;
}

/*=======================================================================
 *                         SERVER ACTION CONTROLS
 *======================================================================*/

/**
 * Attaches events to Start, Stop, Restart buttons.
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
 * Starts an Ark ASA server.
 * @param {string} serverName - Server name.
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
 * Stops an Ark ASA server.
 * @param {string} serverName - Server name.
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
 * Restarts an Ark ASA server.
 * @param {string} serverName - Server name.
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

/**
 * Updates server status visually in the dashboard.
 * @param {string} serverName - Server name.
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
 * Updates all servers' status in the dashboard.
 */
async function refreshAllServersStatus() {
    const response = await fetch("/api/servers");
    const servers = await response.json();
    servers.forEach(server => {
        updateServerStatus(server.SERVER_NAME);
    });
}
