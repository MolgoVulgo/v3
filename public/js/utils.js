/*=======================================================================
 *                      UTILITY FUNCTIONS FOR SERVERS
 *======================================================================*/

/**
 * Generates a unique Cluster ID.
 * 
 * @returns {string} - Generated unique Cluster ID.
 */
function generateClusterId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Determines the next available value (max + 1) for PORT and RCON_PORT 
 * based on existing servers.
 * 
 * @returns {Promise<{nextPort: number, nextRconPort: number}>} - Object containing next available ports.
 */
async function getNextAvailablePorts() {
    const response = await fetch("/api/servers");
    const servers = await response.json();

    let maxPort = 7777; // Base value
    let maxRconPort = 27020; // Base value

    servers.forEach(server => {
        if (server.PORT > maxPort) maxPort = server.PORT;
        if (server.RCON_PORT > maxRconPort) maxRconPort = server.RCON_PORT;
    });

    return { nextPort: maxPort + 1, nextRconPort: maxRconPort + 1 };
}
