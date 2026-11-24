const fs = require('node:fs');
const path = require('node:path');

function createLogger(directory, { maxBytes = 5 * 1024 * 1024, backups = 3, filename = 'imageworks.log', mirror = true } = {}) {
  const file = path.join(directory, filename);
  return function log(level, event, details = {}) {
    const record = { timestamp: new Date().toISOString(), level, event, ...details };
    if (details.error instanceof Error) {
      const error = details.error;
      record.error = { message: error.message, code: error.code, stack: error.stack,
        command: error.command, exitCode: error.exitCode, signal: error.signal,
        stdout: error.stdout, stderr: error.stderr };
    }
    const line = JSON.stringify(record) + '\n';
    if (mirror) (level === 'error' ? process.stderr : process.stdout).write(line);
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        for (let n = backups; n >= 1; n--) {
          const source = n === 1 ? file : `${file}.${n - 1}`;
          const target = `${file}.${n}`;
          if (fs.existsSync(source)) {
            fs.rmSync(target, { force: true });
            fs.renameSync(source, target);
          }
        }
      }
      fs.appendFileSync(file, line, { mode: 0o640 });
    } catch (error) {
      process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error',
        event: 'log.write_failed', file, message: error.message }) + '\n');
    }
  };
}

module.exports = { createLogger };
