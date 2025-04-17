/**
 * @fileoverview Service specifically for sending RCON commands to ARK servers,
 * by leveraging the dockerService to execute commands inside the container.
 * @version 3.0.0 Refactored to use dockerService.executeCommandInContainer
 */

// Importe SEULEMENT la fonction nécessaire de dockerService
const { executeCommandInContainer } = require('./dockerService');

const ASA_CTRL_PATH = "asa-ctrl"; // Ajuster si nécessaire

/**
 * Sends an RCON command via 'asa-ctrl rcon --exec'.
 * @param {string} serverName - The logical name of the server.
 * @param {string} command - The RCON command string (e.g., "ListPlayers").
 * @returns {Promise<string>} A promise resolving to the command's output (stdout).
 * @throws {Error} If the command execution fails.
 */
async function sendRconCommand(serverName, command) {
    const containerName = `ARK-ASA-${serverName}`;
    // ===> CORRECTION: Ajout de --exec <===
    const commandArray = [ASA_CTRL_PATH, "rcon", "--exec", command];
    const user = 'gameserver';
    // ===> CORRECTION: Spécifier TTY=true car la commande user l'utilise <===
    const useTty = true;

    console.log(`[RCON Service][${serverName}] Requesting dockerService to execute: ${commandArray.join(' ')} (TTY: ${useTty})`);

    try {
        // Appelle la fonction centralisée avec l'option TTY
        const result = await executeCommandInContainer(containerName, commandArray, user, useTty);
        return result;
    } catch (error) {
        console.error(`❌ [RCON Service][${serverName}] Failed to send RCON command "${command}" via dockerService:`, error.message);
        throw error; // Propager l'erreur
    }
}

// getPlayersCount utilise maintenant implicitement la bonne structure via sendRconCommand
async function getPlayersCount(serverName) {
    try {
        // ... (le code de getPlayersCount reste le même, il appelle le sendRconCommand corrigé) ...
        // Retourne playerCount en cas de succès, null en cas d'échec (comme défini précédemment)
        console.debug(`[RCON Service][${serverName}] Executing ListPlayers for liveness check...`);
        const response = await sendRconCommand(serverName, "ListPlayers"); // Appelle la version corrigée
        console.debug(`[RCON Service][${serverName}] ListPlayers raw response:\n${response}`);
        const trimmedResponse = response.trim();
        if (!trimmedResponse || trimmedResponse.toLowerCase().includes("no players connected")) { return 0; }
        const lines = trimmedResponse.split('\n');
        const playerLines = lines.filter(line => /^\d+\.\s/.test(line.trim()));
        const playerCount = playerLines.length;
        console.debug(`[RCON Service][${serverName}] getPlayersCount: Detected ${playerCount} players.`);
        return playerCount;
    } catch (error) {
         console.warn(`[RCON Service][${serverName}] ListPlayers failed for liveness check: ${error.message}`);
         return null; // Retourne null en cas d'échec de sendRconCommand
    }
}


module.exports = {
    sendRconCommand,
    getPlayersCount // Exporte la nouvelle fonction
};