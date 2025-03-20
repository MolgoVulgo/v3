/**
 * Sends a UI notification.
 * @param {string} message - Notification message.
 * @param {string} type - Bootstrap alert type (success, danger, warning, info).
 */
function notifyUser(message, type) {
    console.log(`[UI NOTIFICATION] ${message}`);
}

module.exports = { notifyUser };
