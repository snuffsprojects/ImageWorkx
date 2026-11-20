const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function fingerprint(file) {
  const stat = await fs.stat(file);
  return `${stat.size}:${stat.mtimeMs}`;
}

async function planMove(archive, processedRoot) {
  const name = path.basename(archive);
  const part = name.match(/^(.*)\.part\d+\.rar$/i);
  const stem = name.replace(/\.rar$/i, '');
  const siblings = await fs.readdir(path.dirname(archive), { withFileTypes: true });
  const files = [];
  for (const entry of siblings) {
    if (!entry.isFile()) continue;
    const otherPart = entry.name.match(/^(.*)\.part\d+\.rar$/i);
    const oldPart = entry.name.match(/^(.*)\.r\d+$/i);
    if (entry.name !== name && !(part && otherPart && part[1].toLowerCase() === otherPart[1].toLowerCase()) && !(/\.rar$/i.test(name) && !part && oldPart && stem.toLowerCase() === oldPart[1].toLowerCase())) continue;
    files.push({ source: path.join(path.dirname(archive), entry.name), signature: await fingerprint(path.join(path.dirname(archive), entry.name)) });
  }
  // Keep the first volume until last, so a failed move can be retried by the scanner.
  files.sort((a, b) => Number(a.source === archive) - Number(b.source === archive));
  return { destination: path.join(processedRoot, `${name.slice(0, 100)}-${crypto.randomUUID()}`), files };
}

async function executeMove(plan) {
  await fs.mkdir(plan.destination, { recursive: true });
  for (const file of plan.files) {
    const destination = path.join(plan.destination, path.basename(file.source));
    let signature;
    try { signature = await fingerprint(file.source); }
    catch (error) {
      if (error.code === 'ENOENT' && await fingerprint(destination) === file.signature) continue;
      throw error;
    }
    if (signature !== file.signature) throw new Error(`Archive changed since import; leaving it in Inbox: ${path.basename(file.source)}`);
    // Hard linking first prevents overwriting an existing archive, even on retries.
    try { await fs.link(file.source, destination); }
    catch (error) {
      if (error.code !== 'EEXIST' || await fingerprint(destination) !== file.signature) throw error;
    }
    await fs.unlink(file.source);
  }
}

module.exports = { planMove, executeMove };
