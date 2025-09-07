#!/usr/bin/env node

// nlever: A CLI tool to deploy and manage Node.js applications on a remote server.
// Chris Vasseng <hello@vasseng.com>
// Licensed under the MIT License.

import { createServer } from 'http';
import { promises as fs } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';

const PORT = process.env.NLEVER_PORT || 8080;
const BASE_DIR = process.env.NLEVER_BASE_DIR || '/var/www';
const AUTH_TOKEN = process.env.NLEVER_AUTH_TOKEN;

let apps = {};
const REGISTRY_FILE = join(BASE_DIR, '.nlever-apps.json');

async function loadRegistry() {
  try {
    const data = await fs.readFile(REGISTRY_FILE, 'utf8');
    apps = JSON.parse(data);
  } catch {
    apps = {};
  }
}

async function saveRegistry() {
  await fs.mkdir(BASE_DIR, { recursive: true });
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(apps, null, 2));
}

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization;
  return header && header === `Bearer ${AUTH_TOKEN}`;
}

function parsepm2Status(status) {
  const lines = status.split('\n');
  const info = {
    pm2_env: { status: 'unknown', pm_uptime: Date.now(), restart_time: 0 },
    monit: { cpu: 0, memory: 0 }
  };
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('status')) {
      const match = trimmed.match(/status\s*[│|]\s*(\w+)/);
      if (match) info.pm2_env.status = match[1];
    } else if (trimmed.includes('cpu')) {
      const match = trimmed.match(/(\d+(?:\.\d+)?)%/);
      if (match) info.monit.cpu = parseFloat(match[1]);
    } else if (trimmed.includes('memory')) {
      const match = trimmed.match(/(\d+(?:\.\d+)?)\s*(kb|mb|gb)/i);
      if (match) {
        let mem = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === 'kb') mem *= 1024;
        else if (unit === 'mb') mem *= 1024 * 1024;
        else if (unit === 'gb') mem *= 1024 * 1024 * 1024;
        info.monit.memory = mem;
      }
    } else if (trimmed.includes('restarts')) {
      const match = trimmed.match(/(\d+)/);
      if (match) info.pm2_env.restart_time = parseInt(match[1]);
    }
  }
  
  return info;
}

async function acquireLock(appName) {
  const lockFile = join(BASE_DIR, appName, '.nlever-deploying');
  try {
    await fs.mkdir(join(BASE_DIR, appName), { recursive: true });
    
    try {
      const stat = await fs.stat(lockFile);
      const lockAge = Date.now() - stat.mtime.getTime();
      if (lockAge > 600000) { // 10 minutes
        await fs.unlink(lockFile);
      } else {
        throw new Error('Deployment already in progress');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    
    await fs.writeFile(lockFile, Date.now().toString());
  } catch (error) {
    throw error;
  }
}

async function releaseLock(appName) {
  const lockFile = join(BASE_DIR, appName, '.nlever-deploying');
  try {
    await fs.unlink(lockFile);
  } catch {}
}

async function deploy(req, res, appName) {
  let rollbackNeeded = false;
  let previousLink = null;
  
  try {
    await acquireLock(appName);
    
    const url = new URL(`http://localhost${req.url}`);
    const healthCheck = url.searchParams.get('health_check');
    
    const timestamp = Date.now();
    const releaseDir = join(BASE_DIR, appName, 'releases', timestamp.toString());
    const currentLink = join(BASE_DIR, appName, 'current');
    previousLink = join(BASE_DIR, appName, 'previous');
    
    await fs.mkdir(releaseDir, { recursive: true });
    
    const tempFile = join(tmpdir(), `nlever-${appName}-${timestamp}.tar.gz`);
    
    const fileStream = createWriteStream(tempFile);
    await pipeline(req, fileStream);

    await new Promise((resolve, reject) => {
      const extract = spawn('tar', ['-xzf', tempFile, '-C', releaseDir], {
        timeout: 60000
      });
      extract.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed: ${code}`)));
      extract.on('error', reject);
    });

    await fs.unlink(tempFile);
    
    const extractedFiles = await fs.readdir(releaseDir);
    console.log(`Extracted files to ${releaseDir}:`, extractedFiles.slice(0, 10));

    let currentTarget = null;
    try {
      currentTarget = await fs.readlink(currentLink);
    } catch {}

    if (currentTarget) {
      try {
        await fs.unlink(previousLink);
      } catch {}
      await fs.symlink(currentTarget, previousLink);
    }

    try {
      await fs.unlink(currentLink);
    } catch {}
    await fs.symlink(releaseDir, currentLink);

    const packageJsonPath = join(releaseDir, 'package.json');
    
    const filteredEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      NODE_ENV: process.env.NODE_ENV || 'production',
      LANG: process.env.LANG || 'en_US.UTF-8'
    };
    
    let pm2Config = {
      name: `nlever-${appName}`,
      cwd: currentLink,
      env: filteredEnv
    };
    
    try {
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      console.log(`Found package.json for ${appName}:`, JSON.stringify({
        name: pkg.name,
        main: pkg.main,
        scripts: pkg.scripts
      }, null, 2));
      
      if (pkg.scripts?.start) {
        pm2Config.script = 'npm';
        pm2Config.args = ['run', 'start'];
        console.log(`Using npm run start for ${appName}`);
      } else if (pkg.main) {
        pm2Config.script = pkg.main;
        console.log(`Using main entry point: ${pkg.main} for ${appName}`);
      } else {
        pm2Config.script = 'index.js';
        console.log(`Using default index.js for ${appName}`);
      }
    } catch (err) {
      console.log(`No package.json found for ${appName}, using default index.js. Error:`, err.message);
      pm2Config.script = 'index.js';
    }

    // Install dependencies
    try {
      await fs.access(packageJsonPath);
      console.log(`Installing dependencies for ${appName}...`);
      
      let installCmd = 'npm install';
      try {
        await fs.access(join(releaseDir, 'yarn.lock'));
        installCmd = 'yarn install --frozen-lockfile';
        console.log('Found yarn.lock, using yarn');
      } catch {
        console.log('Using npm install');
      }
      
      execSync(installCmd, { 
        cwd: releaseDir, 
        timeout: 300000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      console.log(`Dependencies installed successfully for ${appName}`);
    } catch (err) {
      console.log(`Skipping dependency installation for ${appName}:`, err.message);
    }

    const pm2Name = `nlever-${appName}`;
    
    try {
      execSync(`pm2 describe ${pm2Name}`, { stdio: 'ignore' });
      console.log(`Restarting existing PM2 app: ${pm2Name}`);
      execSync(`pm2 restart ${pm2Name} --update-env`, { timeout: 30000 });
    } catch {
      const configFile = join(BASE_DIR, appName, 'pm2.config.json');
      console.log(`Starting new PM2 app ${pm2Name} with config:`, JSON.stringify(pm2Config, null, 2));
      await fs.writeFile(configFile, JSON.stringify({ apps: [pm2Config] }, null, 2));
      
      try {
        const result = execSync(`pm2 start ${configFile}`, { timeout: 30000, encoding: 'utf8' });
        console.log(`PM2 start output:`, result);
      } catch (e) {
        console.error(`PM2 start failed for ${pm2Name}:`, e.message);
        if (e.stdout) console.error('Stdout:', e.stdout.toString());
        if (e.stderr) console.error('Stderr:', e.stderr.toString());
        throw new Error(`PM2 start failed: ${e.message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`Checking PM2 status for ${pm2Name}...`);
    try {
      const describeOutput = execSync(`pm2 describe ${pm2Name}`, { encoding: 'utf8' });
      console.log(`PM2 describe succeeded for ${pm2Name}`);
    } catch (err) {
      console.error(`PM2 describe failed for ${pm2Name}:`, err.message);
      rollbackNeeded = true;
      throw new Error('PM2 process failed to start');
    }

    if (healthCheck) {
      const maxAttempts = 10;
      const delays = [1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000];
      let healthy = false;
      
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, delays[i]));
        
        try {
          const port = 3000; // Default port
          const healthRes = await new Promise((resolve, reject) => {
            const req = createServer().request({
              hostname: 'localhost',
              port,
              path: healthCheck,
              method: 'GET',
              timeout: 5000
            }, resolve);
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('Health check timeout')));
            req.end();
          });
          
          if (healthRes.statusCode === 200) {
            healthy = true;
            break;
          }
        } catch {}
      }
      
      if (!healthy) {
        rollbackNeeded = true;
        throw new Error('Health check failed');
      }
    }

    // Cleanup old releases
    const releasesDir = join(BASE_DIR, appName, 'releases');
    const releases = await fs.readdir(releasesDir);
    for (const release of releases) {
      if (release !== timestamp.toString()) {
        const oldRelease = join(releasesDir, release);
        await fs.rm(oldRelease, { recursive: true, force: true });
      }
    }

    apps[appName] = {
      lastDeploy: timestamp,
      pm2Name,
      healthCheck
    };
    await saveRegistry();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true, 
      timestamp,
      message: 'Deployment successful'
    }));

  } catch (error) {
    if (rollbackNeeded && previousLink) {
      try {
        const previousTarget = await fs.readlink(previousLink);
        await fs.unlink(join(BASE_DIR, appName, 'current'));
        await fs.symlink(previousTarget, join(BASE_DIR, appName, 'current'));
        
        const pm2Name = `nlever-${appName}`;
        execSync(`pm2 restart ${pm2Name} --update-env`, { timeout: 30000 });
      } catch {}
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  } finally {
    await releaseLock(appName);
  }
}

async function rollback(req, res, appName) {
  const previousLink = join(BASE_DIR, appName, 'previous');
  const currentLink = join(BASE_DIR, appName, 'current');
  
  try {
    const previousTarget = await fs.readlink(previousLink);
    const currentTarget = await fs.readlink(currentLink);
    
    await fs.unlink(currentLink);
    await fs.symlink(previousTarget, currentLink);
    
    await fs.unlink(previousLink);
    await fs.symlink(currentTarget, previousLink);
    
    const pm2Name = `nlever-${appName}`;
    execSync(`pm2 restart ${pm2Name} --update-env`, { timeout: 30000 });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Rollback successful' }));
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No previous version to rollback to' }));
  }
}

async function getStatus(req, res, appName) {
  try {
    const pm2Name = `nlever-${appName}`;
    const status = execSync(`pm2 describe ${pm2Name}`, { encoding: 'utf8' });
    const info = parsepm2Status(status);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: appName,
      pm2: {
        status: info.pm2_env.status,
        cpu: info.monit.cpu,
        memory: info.monit.memory,
        uptime: info.pm2_env.pm_uptime,
        restarts: info.pm2_env.restart_time
      }
    }));
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
  }
}

async function getLogs(req, res, appName) {
  try {
    const url = new URL(`http://localhost${req.url}`);
    const lines = url.searchParams.get('lines') || '100';
    
    const pm2Name = `nlever-${appName}`;
    const logs = execSync(`pm2 logs ${pm2Name} --nostream --lines ${lines}`, { 
      encoding: 'utf8',
      timeout: 5000
    });
    
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(logs);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
  }
}

async function stopApp(req, res, appName) {
  try {
    const pm2Name = `nlever-${appName}`;
    execSync(`pm2 stop ${pm2Name}`, { timeout: 30000 });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'App stopped successfully' }));
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found or failed to stop' }));
  }
}

async function restartApp(req, res, appName) {
  try {
    const pm2Name = `nlever-${appName}`;
    execSync(`pm2 restart ${pm2Name}`, { timeout: 30000 });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'App restarted successfully' }));
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found or failed to restart' }));
  }
}

async function destroyApp(req, res, appName) {
  try {
    const pm2Name = `nlever-${appName}`;
    
    try {
      execSync(`pm2 delete ${pm2Name}`, { timeout: 30000 });
    } catch {}
    
    const appDir = join(BASE_DIR, appName);
    try {
      await fs.rm(appDir, { recursive: true, force: true });
    } catch {}
    
    delete apps[appName];
    await saveRegistry();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'App destroyed successfully' }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to destroy app' }));
  }
}

async function handleRequest(req, res) {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const urlParts = req.url.split('?')[0].split('/').filter(Boolean);
  const [action, appName] = urlParts;

  if (!appName || !action) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
    return;
  }

  try {
    if (req.method === 'POST' && action === 'deploy') {
      await deploy(req, res, appName);
    } else if (req.method === 'POST' && action === 'rollback') {
      await rollback(req, res, appName);
    } else if (req.method === 'POST' && action === 'stop') {
      await stopApp(req, res, appName);
    } else if (req.method === 'POST' && action === 'restart') {
      await restartApp(req, res, appName);
    } else if (req.method === 'POST' && action === 'destroy') {
      await destroyApp(req, res, appName);
    } else if (req.method === 'GET' && action === 'status') {
      await getStatus(req, res, appName);
    } else if (req.method === 'GET' && action === 'logs') {
      await getLogs(req, res, appName);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function install() {
  try {
    const serverPath = process.argv[1];
    const pm2Config = {
      name: 'nlever-server',
      script: serverPath,
      env: {
        NLEVER_PORT: PORT,
        NLEVER_BASE_DIR: process.env.NLEVER_BASE_DIR || BASE_DIR,
        ...(AUTH_TOKEN && { NLEVER_AUTH_TOKEN: AUTH_TOKEN })
      },
      autorestart: true,
      watch: false
    };
    
    const configFile = '/tmp/nlever-server-pm2.json';
    await fs.writeFile(configFile, JSON.stringify({ apps: [pm2Config] }, null, 2));
    
    execSync(`pm2 start ${configFile}`, { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'inherit' });
    execSync('pm2 startup', { stdio: 'inherit' });
    
    await fs.unlink(configFile);
    
    console.log('✓ nlever-server installed and started with PM2');
    console.log('✓ PM2 startup script created');
    console.log(`✓ Server running on port ${PORT}`);
  } catch (error) {
    console.error('✗ Installation failed:', error.message);
    process.exit(1);
  }
}

async function uninstall() {
  try {
    execSync('pm2 delete nlever-server', { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'inherit' });
    console.log('✓ nlever-server stopped and removed from PM2');
  } catch (error) {
    console.error('✗ Uninstallation failed:', error.message);
    process.exit(1);
  }
}

// Check write permissions and fallback if needed
async function init() {
  try {
    await fs.access(BASE_DIR, fs.constants.W_OK);
  } catch {
    console.log(`No write access to ${BASE_DIR}, using ~/nlever-apps`);
    process.env.NLEVER_BASE_DIR = join(process.env.HOME, 'nlever-apps');
  }
  
  await loadRegistry();
  
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`nlever server listening on port ${PORT}`);
    console.log(`Base directory: ${process.env.NLEVER_BASE_DIR || BASE_DIR}`);
    console.log(`Auth: ${AUTH_TOKEN ? 'Enabled' : 'Disabled'}`);
  });
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--install')) {
  install();
} else if (args.includes('--uninstall')) {
  uninstall();
} else {
  init().catch(console.error);
}
