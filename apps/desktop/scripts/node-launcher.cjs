// The renderer server must not survive an abruptly terminated supervisor.
const parent = Number(process.env.TRADING_MAX_DESKTOP_SUPERVISOR_PID);
if (!Number.isInteger(parent) || parent < 2 || process.ppid !== parent) {
  throw new Error('The desktop web server requires its owning supervisor');
}
setInterval(() => {
  if (process.ppid !== parent) process.exit(1);
}, 300).unref();
require('./web/server.js');
