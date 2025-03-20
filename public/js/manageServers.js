/*=======================================================================
 *                     SERVER LIST MANAGEMENT (servers.ejs)
 *======================================================================*/

/**
 * Loads the server list and updates the display on servers.ejs.
 * 
 * @returns {Promise<void>}
 */
async function loadServers() {
    try {
        const response = await fetch("/api/servers");
        const servers = await response.json();
        const currentPage = document.body.dataset.page;

        if (currentPage === "servers") {
            updateClusterList(servers);
            loadClusterOptions(servers);
        }
    } catch (error) {
        console.error("Error loading servers:", error);
    }
}

/**
 * Updates the cluster list displayed on servers.ejs.
 * 
 * @param {Array} servers - List of servers.
 * @returns {void}
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
 * Updates the cluster options in the add/edit server form.
 * 
 * @param {Array} servers - List of servers.
 * @returns {void}
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

/*=======================================================================
 *                     MAPS MANAGEMENT
 *======================================================================*/

/**
 * Loads the list of available maps from the API.
 * 
 * @returns {Promise<void>}
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
 *                     SERVER ACTIONS
 *======================================================================*/

/**
 * Deletes a server with confirmation.
 * 
 * @param {string} serverName - Name of the server to delete.
 * @returns {Promise<void>}
 */
async function deleteServer(serverName) {
    const confirmDelete = confirm(`Are you sure you want to delete the server: ${serverName}?`);
    if (!confirmDelete) return;

    await fetch(`/api/servers/${serverName}`, { method: "DELETE" });
    loadServers();
}

/**
 * Edits an existing server and fills the form fields with its data.
 * 
 * @param {string} serverName - Name of the server to edit.
 * @returns {Promise<void>}
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
