/*=======================================================================
 *                  DEFAULT PORT FIELDS INITIALIZATION
 *======================================================================*/

document.addEventListener("DOMContentLoaded", async () => {
    await updatePortFields();
});

/**
 * Updates the default values for PORT and RCON_PORT fields dynamically.
 */
async function updatePortFields() {
    const { nextPort, nextRconPort } = await getNextAvailablePorts();
    document.getElementById("port").value = nextPort;
    document.getElementById("rcon-port").value = nextRconPort;
}

/*=======================================================================
 *                             FORM HANDLING
 *======================================================================*/

/**
 * Resets a specific form by its ID.
 * @param {string} formId - ID of the form to reset.
 */
async function resetForm(formId) {
    const form = document.getElementById(formId);
    if (!form) return;

    form.reset();

    // Update port fields dynamically if it's the server form
    if (formId === "server-form") {
        await updatePortFields();
    }
}

/**
 * Handles the form submission for adding or editing a server.
 */
document.getElementById("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const serverData = {
        SERVER_NAME: document.getElementById("server-name").value,
        MAP_NAME: document.getElementById("map-name").value,
        PORT: parseInt(document.getElementById("port").value),
        RCON_PORT: parseInt(document.getElementById("rcon-port").value),
        MAX_PLAYERS: parseInt(document.getElementById("max-players").value),
        MODS: document.getElementById("mods").value || "",
        CLUSTER_ID: document.getElementById("cluster-id").value === "new"
            ? generateClusterId()
            : document.getElementById("cluster-id").value,
        ENABLED: document.getElementById("enabled").checked
    };

    await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serverData)
    });

    resetForm("server-form");
    loadServers();
});
