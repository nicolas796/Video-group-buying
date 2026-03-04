const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const BACKUP_LIMIT = 10;

function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function getBackupName(baseName) {
  return `${baseName}.backup.${nowTimestamp()}.json`;
}

function matchesBackupPattern(baseName, candidate) {
  return candidate.startsWith(`${baseName}.backup.`) && candidate.endsWith('.json');
}

function safeResolve(dir, fileName) {
  const resolved = path.resolve(dir, fileName);
  const dirRoot = path.resolve(dir);
  const allowedPrefix = dirRoot.endsWith(path.sep) ? dirRoot : `${dirRoot}${path.sep}`;
  if (resolved !== dirRoot && !resolved.startsWith(allowedPrefix)) {
    throw new Error('Invalid backup path');
  }
  return resolved;
}

function pruneBackupsSync(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter(name => matchesBackupPattern(base, name))
      .map(name => {
        const filePath = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(filePath).mtimeMs;
        } catch (_) {
          // Ignore stat errors
        }
        return { name, filePath, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (error) {
    return;
  }

  if (entries.length <= BACKUP_LIMIT) return;
  const stale = entries.slice(BACKUP_LIMIT);
  stale.forEach(entry => {
    try {
      fs.unlinkSync(entry.filePath);
    } catch (error) {
      console.error(`[Backup] Failed to remove old backup ${entry.filePath}: ${error.message}`);
    }
  });
}

async function pruneBackupsAsync(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  let entries;
  try {
    const names = await fsp.readdir(dir);
    entries = await Promise.all(names
      .filter(name => matchesBackupPattern(base, name))
      .map(async name => {
        const filePath = path.join(dir, name);
        try {
          const stats = await fsp.stat(filePath);
          return { name, filePath, mtime: stats.mtimeMs };
        } catch {
          return { name, filePath, mtime: 0 };
        }
      }));
    entries.sort((a, b) => b.mtime - a.mtime);
  } catch (error) {
    return;
  }

  if (entries.length <= BACKUP_LIMIT) return;
  const stale = entries.slice(BACKUP_LIMIT);
  await Promise.all(stale.map(async entry => {
    try {
      await fsp.unlink(entry.filePath);
    } catch (error) {
      console.error(`[Backup] Failed to remove old backup ${entry.filePath}: ${error.message}`);
    }
  }));
}

function createBackupSync(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backupName = getBackupName(base);
  const backupPath = path.join(dir, backupName);
  try {
    fs.copyFileSync(filePath, backupPath);
    pruneBackupsSync(filePath);
    return backupPath;
  } catch (error) {
    console.error(`[Backup] Failed to create backup for ${filePath}: ${error.message}`);
    return null;
  }
}

async function createBackupAsync(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    return null;
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backupName = getBackupName(base);
  const backupPath = path.join(dir, backupName);
  try {
    await fsp.copyFile(filePath, backupPath);
    await pruneBackupsAsync(filePath);
    return backupPath;
  } catch (error) {
    console.error(`[Backup] Failed to create backup for ${filePath}: ${error.message}`);
    return null;
  }
}

function listBackupsSync(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    return fs.readdirSync(dir)
      .filter(name => matchesBackupPattern(base, name))
      .map(name => {
        const file = path.join(dir, name);
        const stats = fs.statSync(file);
        return {
          name,
          path: file,
          createdAt: stats.mtime.toISOString(),
          size: stats.size
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    console.error(`[Backup] Failed to list backups for ${filePath}: ${error.message}`);
    return [];
  }
}

function resolveBackupPath(filePath, backupName) {
  const dir = path.dirname(filePath);
  if (!matchesBackupPattern(path.basename(filePath), backupName)) {
    throw new Error('Invalid backup name');
  }
  const resolved = safeResolve(dir, backupName);
  if (!fs.existsSync(resolved)) {
    throw new Error('Backup file not found');
  }
  return resolved;
}

module.exports = {
  createBackupSync,
  createBackupAsync,
  listBackupsSync,
  resolveBackupPath,
  BACKUP_LIMIT
};
