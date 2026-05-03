// Per tech spec §17.3.
// Platform detection used by /lua-doctor and the SessionStart hooks.

import os from 'node:os';
import { readFile } from 'node:fs/promises';

/**
 * @returns {Promise<{platform: NodeJS.Platform, arch: string, release: string, distro: string|null, isWSL: boolean}>}
 */
export async function detectPlatform({ readOSReleaseFn = readOSReleaseId } = {}) {
  const platform = process.platform;
  const arch = process.arch;
  const release = os.release();
  const isWSL = platform === 'linux' && /microsoft/i.test(release);

  let distro = null;
  if (platform === 'linux' && !isWSL) {
    distro = await readOSReleaseFn();
  }

  return { platform, arch, release, distro, isWSL };
}

/**
 * Exported for unit tests. Reads /etc/os-release and extracts the ID field.
 * Returns 'unknown' on file-read failure or unparseable content.
 */
export async function readOSReleaseId(path = '/etc/os-release') {
  try {
    const content = await readFile(path, 'utf8');
    const match = content.match(/^ID=("?)([a-z]+)\1/m);
    return match ? match[2] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Returns the recommended Node-install command for the detected platform.
 *
 * @param {{platform: string, distro: string|null, arch?: string}} info
 * @returns {{type: 'direct'|'sudo'|'unsupported', command: string|null}}
 */
export function nodeInstallCommand({ platform, distro }) {
  if (platform === 'darwin') {
    return { type: 'direct', command: 'brew install node@20' };
  }
  if (platform === 'win32') {
    return {
      type: 'direct',
      command: 'winget install --silent --accept-package-agreements OpenJS.NodeJS.LTS',
    };
  }
  if (platform === 'linux') {
    if (distro === 'ubuntu' || distro === 'debian') {
      return {
        type: 'sudo',
        command: 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs',
      };
    }
    if (distro === 'fedora' || distro === 'rhel' || distro === 'centos') {
      return {
        type: 'sudo',
        command: 'curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs',
      };
    }
    if (distro === 'arch') {
      return { type: 'sudo', command: 'sudo pacman -S --noconfirm nodejs npm' };
    }
    // Universal sudo-less fallback: nvm
    return {
      type: 'direct',
      command: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && nvm install 20',
    };
  }
  return { type: 'unsupported', command: null };
}
