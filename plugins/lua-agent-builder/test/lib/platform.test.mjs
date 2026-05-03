import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPlatform, nodeInstallCommand, readOSReleaseId } from '../../lib/platform.mjs';

describe('readOSReleaseId', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'osrelease-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('extracts unquoted ID', async () => {
    const path = join(tmpDir, 'os-release');
    writeFileSync(path, 'NAME="Ubuntu"\nID=ubuntu\nVERSION="22.04"\n');
    expect(await readOSReleaseId(path)).toBe('ubuntu');
  });

  test('extracts double-quoted ID', async () => {
    const path = join(tmpDir, 'os-release');
    writeFileSync(path, 'ID="fedora"\n');
    expect(await readOSReleaseId(path)).toBe('fedora');
  });

  test('returns "unknown" when file is missing', async () => {
    expect(await readOSReleaseId(join(tmpDir, 'nonexistent'))).toBe('unknown');
  });

  test('returns "unknown" when ID line is missing', async () => {
    const path = join(tmpDir, 'os-release');
    writeFileSync(path, 'NAME="Some OS"\nVERSION="1.0"\n');
    expect(await readOSReleaseId(path)).toBe('unknown');
  });
});


describe('detectPlatform', () => {
  test('returns current platform info shape', async () => {
    const info = await detectPlatform();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(typeof info.release).toBe('string');
    expect(typeof info.isWSL).toBe('boolean');
  });

  test('uses injected readOSReleaseFn when on linux', async () => {
    if (process.platform !== 'linux') {
      // On non-linux, the readOSReleaseFn isn't called — distro stays null
      const info = await detectPlatform({ readOSReleaseFn: async () => 'ubuntu' });
      expect(info.distro).toBeNull();
    } else {
      const info = await detectPlatform({ readOSReleaseFn: async () => 'fedora' });
      expect(info.distro).toBe('fedora');
    }
  });

  test('isWSL is false on macOS/Windows regardless of release string', async () => {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const info = await detectPlatform();
      expect(info.isWSL).toBe(false);
    }
  });
});

describe('nodeInstallCommand', () => {
  test('macOS → brew install', () => {
    expect(nodeInstallCommand({ platform: 'darwin', distro: null })).toEqual({
      type: 'direct',
      command: 'brew install node@20',
    });
  });

  test('Windows → winget install', () => {
    const result = nodeInstallCommand({ platform: 'win32', distro: null });
    expect(result.type).toBe('direct');
    expect(result.command).toContain('winget install');
    expect(result.command).toContain('OpenJS.NodeJS.LTS');
  });

  test('Ubuntu → sudo apt nodesource', () => {
    const result = nodeInstallCommand({ platform: 'linux', distro: 'ubuntu' });
    expect(result.type).toBe('sudo');
    expect(result.command).toContain('deb.nodesource.com');
    expect(result.command).toContain('apt-get install');
  });

  test('Debian → same as Ubuntu', () => {
    const result = nodeInstallCommand({ platform: 'linux', distro: 'debian' });
    expect(result.type).toBe('sudo');
    expect(result.command).toContain('deb.nodesource.com');
  });

  test('Fedora → sudo dnf rpm-nodesource', () => {
    const result = nodeInstallCommand({ platform: 'linux', distro: 'fedora' });
    expect(result.type).toBe('sudo');
    expect(result.command).toContain('rpm.nodesource.com');
    expect(result.command).toContain('dnf install');
  });

  test('RHEL → same as Fedora', () => {
    const result = nodeInstallCommand({ platform: 'linux', distro: 'rhel' });
    expect(result.command).toContain('dnf install');
  });

  test('CentOS → same as Fedora', () => {
    const result = nodeInstallCommand({ platform: 'linux', distro: 'centos' });
    expect(result.command).toContain('dnf install');
  });

  test('Arch → sudo pacman', () => {
    expect(nodeInstallCommand({ platform: 'linux', distro: 'arch' })).toEqual({
      type: 'sudo',
      command: 'sudo pacman -S --noconfirm nodejs npm',
    });
  });

  test('unknown linux distro → nvm fallback (sudo-less)', () => {
    const result = nodeInstallCommand({ platform: 'linux', distro: 'unknown' });
    expect(result.type).toBe('direct');
    expect(result.command).toContain('nvm-sh/nvm');
    expect(result.command).toContain('nvm install 20');
  });

  test('unsupported platform returns unsupported', () => {
    expect(nodeInstallCommand({ platform: 'aix', distro: null })).toEqual({
      type: 'unsupported',
      command: null,
    });
  });
});
