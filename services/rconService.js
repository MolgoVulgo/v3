const Rcon = require('rcon');

/*=======================================================================
 *                      RCON CONNECTION & COMMANDS
 *======================================================================*/

/**
 * Connects to the Ark ASA server via RCON protocol.
 * 
 * @param {string} host - IP address of the Ark ASA server.
 * @param {number} port - RCON port of the server.
 * @param {string} password - RCON password.
 * @returns {Promise<Rcon>} - Connected Rcon instance.
 */
function connectRcon(host, port, password) {
    return new Promise((resolve, reject) => {
        const client = new Rcon(host, port, password);

        client.on('auth', () => resolve(client));
        client.on('error', (err) => reject(err));

        client.connect();
    });
}

/**
 * Retrieves the number of connected players on an Ark ASA server via RCON.
 * 
 * @param {string} host - IP address of the server.
 * @param {number} port - RCON port.
 * @param {string} password - RCON password.
 * @returns {Promise<number>} - Number of connected players.
 */
async function getPlayersCount(host, port, password) {
    try {
        const client = await connectRcon(host, port, password);
        return new Promise((resolve, reject) => {
            client.send('listplayers', (response) => {
                client.disconnect();
                const match = response.match(/\d+ players?/);
                resolve(match ? parseInt(match[0]) : 0);
            });
        });
    } catch (error) {
        console.error(`RCON Error: ${error.message}`);
        return 0;
    }
}

/**
 * Sends a custom RCON command to the Ark ASA server.
 * 
 * @param {string} host - IP address of the server.
 * @param {number} port - RCON port.
 * @param {string} password - RCON password.
 * @param {string} command - Command to execute.
 * @returns {Promise<string>} - Server response.
 */
async function sendRconCommand(host, port, password, command) {
    try {
        const client = await connectRcon(host, port, password);
        return new Promise((resolve, reject) => {
            client.send(command, (response) => {
                client.disconnect();
                resolve(response);
            });
        });
    } catch (error) {
        console.error(`RCON Error: ${error.message}`);
        return 'Error executing command';
    }
}

module.exports = {
    getPlayersCount,
    sendRconCommand,
};
