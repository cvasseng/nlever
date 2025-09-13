#!/usr/bin/env node

// nlever: A CLI tool to deploy and manage Node.js applications on a remote server.
// Chris Vasseng <hello@vasseng.com>
// https://github.com/cvasseng/nlever
// Licensed under the MIT License.

import { createServer, request } from 'http';
import { promises as fs } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';

const PORT = process.env.NLEVER_PORT || 8081;
let BASE_DIR = process.env.NLEVER_BASE_DIR || '/var/www';
const AUTH_TOKEN = process.env.NLEVER_AUTH_TOKEN;
const PROXY_MODE = process.env.NLEVER_PROXY === 'yes';
const PROXY_PORT = process.env.NLEVER_PROXY_PORT || (PROXY_MODE ? 8080 : null);
const APP_LISTINGS = process.env.NLEVER_APP_LISTINGS !== 'no';
const ADMIN_IPS = process.env.NLEVER_ADMIN_IPS_ALLOW;
const PROXY_IPS = process.env.NLEVER_PROXY_IPS_ALLOW;

let apps = {};
let REGISTRY_FILE = join(BASE_DIR, '.nlever-apps.json');
const rateLimitMap = new Map(); // IP -> {count, lastReset}

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

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function getClientIP(req) {
  let ip = req.connection.remoteAddress || req.socket.remoteAddress || '127.0.0.1';
  // Handle IPv6-mapped IPv4 addresses
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.lastReset > 60000) {
    // First request or reset window (1 minute)
    rateLimitMap.set(ip, { count: 1, lastReset: now });
    return true;
  }
  
  if (entry.count >= 10) {
    // Rate limit exceeded (10 requests per minute)
    return false;
  }
  
  entry.count++;
  return true;
}

function checkIPWhitelist(ip, whitelist) {
  if (!whitelist) return true; // No whitelist configured, allow all
  
  if (whitelist === '*') return true; // Wildcard allows all
  
  const allowedIPs = whitelist.split(',').map(ip => ip.trim());
  return allowedIPs.includes(ip);
}

function sanitizeAppName(appName) {
  // Only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
    throw new Error('Invalid app name format');
  }
  return appName;
}

function sanitizeForLog(input) {
  // Remove control characters, newlines, etc.
  return String(input).replace(/[\r\n\t\x00-\x1f\x7f-\x9f]/g, '');
}

function getAppPaths(appName, timestamp = null) {
  const base = join(BASE_DIR, appName);
  const paths = {
    base,
    current: join(base, 'current'),
    previous: join(base, 'previous'),
    releases: join(base, 'releases'),
    lock: join(base, '.nlever-deploying'),
    pm2Config: join(base, 'pm2.config.json')
  };
  
  if (timestamp) {
    paths.release = join(paths.releases, timestamp.toString());
  }
  
  return paths;
}


function getPM2ProcessInfo(pm2Name) {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    
    const process = processes.find(p => p.name === pm2Name);
    if (!process) {
      return {
        pm2_env: { status: 'stopped', pm_uptime: Date.now(), restart_time: 0 },
        monit: { cpu: 0, memory: 0 }
      };
    }
    
    return {
      pm2_env: {
        status: process.pm2_env.status,
        pm_uptime: process.pm2_env.pm_uptime || Date.now(),
        restart_time: process.pm2_env.restart_time || 0
      },
      monit: {
        cpu: process.monit.cpu || 0,
        memory: process.monit.memory || 0
      }
    };
  } catch {
    return {
      pm2_env: { status: 'unknown', pm_uptime: Date.now(), restart_time: 0 },
      monit: { cpu: 0, memory: 0 }
    };
  }
}

async function acquireLock(appName) {
  const paths = getAppPaths(appName);
  try {
    await fs.mkdir(paths.base, { recursive: true });
    
    try {
      const stat = await fs.stat(paths.lock);
      const lockAge = Date.now() - stat.mtime.getTime();
      if (lockAge > 600000) { // 10 minutes
        await fs.unlink(paths.lock);
      } else {
        throw new Error('Deployment already in progress');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    
    await fs.writeFile(paths.lock, Date.now().toString());
  } catch (error) {
    throw error;
  }
}

async function releaseLock(appName) {
  const paths = getAppPaths(appName);
  try {
    await fs.unlink(paths.lock);
  } catch {}
}

function getAppPort(appName) {
  if (!PROXY_MODE) return 8080; // Default port when not in proxy mode
  
  if (apps[appName]?.port) {
    return apps[appName].port;
  }
  
  // Simple port allocation starting from 3001
  const usedPorts = Object.values(apps).map(app => app.port).filter(Boolean);
  let port = 3001;
  while (usedPorts.includes(port)) port++;
  return port;
}

async function deploy(req, res, appName) {
  let rollbackNeeded = false;
  let previousLink = null;
  const safeAppName = sanitizeAppName(appName);
  
  try {
    await acquireLock(safeAppName);
    
    const url = new URL(`http://localhost${req.url}`);
    const healthCheck = url.searchParams.get('health_check');
    
    const assignedPort = PROXY_MODE ? getAppPort(safeAppName) : null;
    
    const timestamp = Date.now();
    const paths = getAppPaths(safeAppName, timestamp);
    previousLink = paths.previous;
    
    await fs.mkdir(paths.release, { recursive: true });
    
    const tempFile = join(tmpdir(), `nlever-${appName}-${timestamp}.tar.gz`);
    
    const fileStream = createWriteStream(tempFile);
    await pipeline(req, fileStream);

    await new Promise((resolve, reject) => {
      const extract = spawn('tar', ['-xzf', tempFile, '-C', paths.release], {
        timeout: 60000
      });
      extract.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed: ${code}`)));
      extract.on('error', reject);
    });

    await fs.unlink(tempFile);
    
    const extractedFiles = await fs.readdir(paths.release);
    console.log(`Extracted files to ${sanitizeForLog(paths.release)}:`, extractedFiles.slice(0, 10).map(sanitizeForLog));

    let currentTarget = null;
    try {
      currentTarget = await fs.readlink(paths.current);
    } catch {}

    if (currentTarget) {
      try {
        await fs.unlink(paths.previous);
      } catch {}
      await fs.symlink(currentTarget, paths.previous);
    }

    try {
      await fs.unlink(paths.current);
    } catch {}
    await fs.symlink(paths.release, paths.current);

    const packageJsonPath = join(paths.release, 'package.json');
    
    const pm2Env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      NODE_ENV: process.env.NODE_ENV || 'production',
      LANG: process.env.LANG || 'en_US.UTF-8'
    };
    
    if (PROXY_MODE) {
      pm2Env.PORT = assignedPort.toString();
    }

    let pm2Config = {
      name: `nlever-${safeAppName}`,
      cwd: paths.current,
      env: pm2Env
    };
    
    try {
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      console.log(`Found package.json for ${sanitizeForLog(safeAppName)}:`, JSON.stringify({
        name: pkg.name,
        main: pkg.main,
        scripts: pkg.scripts
      }, null, 2));
      
      if (pkg.scripts?.start) {
        pm2Config.script = 'npm';
        pm2Config.args = ['run', 'start'];
        console.log(`Using npm run start for ${sanitizeForLog(safeAppName)}`);
      } else if (pkg.main) {
        pm2Config.script = pkg.main;
        console.log(`Using main entry point: ${sanitizeForLog(pkg.main)} for ${sanitizeForLog(safeAppName)}`);
      } else {
        pm2Config.script = 'index.js';
        console.log(`Using default index.js for ${sanitizeForLog(safeAppName)}`);
      }
    } catch (err) {
      console.log(`No package.json found for ${sanitizeForLog(safeAppName)}, using default index.js. Error:`, sanitizeForLog(err.message));
      pm2Config.script = 'index.js';
    }

    // Install dependencies
    try {
      await fs.access(packageJsonPath);
      console.log(`Installing dependencies for ${sanitizeForLog(safeAppName)}...`);
      
      let installCmd = 'npm install';
      try {
        await fs.access(join(paths.release, 'yarn.lock'));
        installCmd = 'yarn install --frozen-lockfile';
        console.log('Found yarn.lock, using yarn');
      } catch {
        console.log('Using npm install');
      }
      
      execSync(installCmd, { 
        cwd: paths.release, 
        timeout: 300000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      console.log(`Dependencies installed successfully for ${sanitizeForLog(safeAppName)}`);
    } catch (err) {
      console.log(`Skipping dependency installation for ${sanitizeForLog(safeAppName)}:`, sanitizeForLog(err.message));
    }

    try {
      execSync(`pm2 describe nlever-${safeAppName}`, { stdio: 'ignore' });
      console.log(`Restarting existing PM2 app: nlever-${sanitizeForLog(safeAppName)}`);
      execSync(`pm2 restart nlever-${safeAppName} --update-env`, { timeout: 30000 });
    } catch {
      console.log(`Starting new PM2 app nlever-${sanitizeForLog(safeAppName)} with config:`, JSON.stringify(pm2Config, null, 2));
      await fs.writeFile(paths.pm2Config, JSON.stringify({ apps: [pm2Config] }, null, 2));
      
      try {
        const result = execSync(`pm2 start ${paths.pm2Config}`, { timeout: 30000, encoding: 'utf8' });
        console.log(`PM2 start output:`, sanitizeForLog(result));
      } catch (e) {
        console.error(`PM2 start failed for nlever-${sanitizeForLog(safeAppName)}:`, e.message);
        if (e.stdout) console.error('Stdout:', sanitizeForLog(e.stdout.toString()));
        if (e.stderr) console.error('Stderr:', sanitizeForLog(e.stderr.toString()));
        throw new Error(`PM2 start failed: ${e.message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`Checking PM2 status for nlever-${sanitizeForLog(safeAppName)}...`);
    try {
      execSync(`pm2 describe nlever-${safeAppName}`, { encoding: 'utf8' });
      console.log(`PM2 describe succeeded for nlever-${sanitizeForLog(safeAppName)}`);
    } catch (err) {
      console.error(`PM2 describe failed for nlever-${sanitizeForLog(safeAppName)}:`, err.message);
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
          const healthRes = await new Promise((resolve, reject) => {
            const req = request({
              hostname: 'localhost',
              port: assignedPort,
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
    const releases = await fs.readdir(paths.releases);
    for (const release of releases) {
      if (release !== timestamp.toString()) {
        const oldRelease = join(paths.releases, release);
        await fs.rm(oldRelease, { recursive: true, force: true });
      }
    }

    apps[safeAppName] = {
      lastDeploy: timestamp,
      pm2Name: `nlever-${safeAppName}`,
      healthCheck,
      ...(PROXY_MODE && { port: assignedPort })
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
        const rollbackPaths = getAppPaths(safeAppName);
        const previousTarget = await fs.readlink(previousLink);
        await fs.unlink(rollbackPaths.current);
        await fs.symlink(previousTarget, rollbackPaths.current);
        
        execSync(`pm2 restart nlever-${safeAppName} --update-env`, { timeout: 30000 });
      } catch {}
    }

    sendError(res, 500, error.message);
  } finally {
    await releaseLock(safeAppName);
  }
}

async function rollback(req, res, appName) {
  const safeAppName = sanitizeAppName(appName);
  const paths = getAppPaths(safeAppName);
  
  try {
    const previousTarget = await fs.readlink(paths.previous);
    const currentTarget = await fs.readlink(paths.current);
    
    await fs.unlink(paths.current);
    await fs.symlink(previousTarget, paths.current);
    
    await fs.unlink(paths.previous);
    await fs.symlink(currentTarget, paths.previous);
    
    execSync(`pm2 restart nlever-${safeAppName} --update-env`, { timeout: 30000 });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Rollback successful' }));
  } catch (error) {
    sendError(res, 404, 'No previous version to rollback to');
  }
}

async function getStatus(req, res, appName) {
  try {
    const safeAppName = sanitizeAppName(appName);
    const info = getPM2ProcessInfo(`nlever-${safeAppName}`);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: sanitizeForLog(appName),
      pm2: {
        status: info.pm2_env.status,
        cpu: info.monit.cpu,
        memory: info.monit.memory,
        uptime: info.pm2_env.pm_uptime,
        restarts: info.pm2_env.restart_time
      }
    }));
  } catch {
    sendError(res, 404, 'App not found');
  }
}

async function getLogs(req, res, appName) {
  try {
    const safeAppName = sanitizeAppName(appName);
    const url = new URL(`http://localhost${req.url}`);
    const lines = url.searchParams.get('lines') || '100';
    const safeLines = /^\d+$/.test(lines) ? lines : '100';
    
    const logs = execSync(`pm2 logs nlever-${safeAppName} --nostream --lines ${safeLines}`, { 
      encoding: 'utf8',
      timeout: 5000
    });
    
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(logs);
  } catch {
    sendError(res, 404, 'App not found');
  }
}

async function stopApp(req, res, appName) {
  try {
    const safeAppName = sanitizeAppName(appName);
    execSync(`pm2 stop nlever-${safeAppName}`, { timeout: 30000 });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'App stopped successfully' }));
  } catch {
    sendError(res, 404, 'App not found or failed to stop');
  }
}

async function restartApp(req, res, appName) {
  try {
    const safeAppName = sanitizeAppName(appName);
    execSync(`pm2 restart nlever-${safeAppName}`, { timeout: 30000 });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'App restarted successfully' }));
  } catch {
    sendError(res, 404, 'App not found or failed to restart');
  }
}

async function destroyApp(req, res, appName) {
  try {
    const safeAppName = sanitizeAppName(appName);
    try {
      execSync(`pm2 delete nlever-${safeAppName}`, { timeout: 30000 });
    } catch {}
    
    const paths = getAppPaths(safeAppName);
    try {
      await fs.rm(paths.base, { recursive: true, force: true });
    } catch {}
    
    delete apps[safeAppName];
    await saveRegistry();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'App destroyed successfully' }));
  } catch (error) {
    sendError(res, 500, 'Failed to destroy app');
  }
}

async function proxyRequest(req, res, appName, proxyPath) {
  const app = apps[appName];
  if (!app || !app.port) {
    sendError(res, 404, 'App not found or not in proxy mode');
    return;
  }

  try {
    const proxyReq = request({
      hostname: 'localhost',
      port: app.port,
      path: proxyPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${app.port}`,
        'x-forwarded-prefix': `/${appName}`,
        'x-forwarded-for': req.connection.remoteAddress || req.socket.remoteAddress,
        'x-real-ip': req.connection.remoteAddress || req.socket.remoteAddress,
        'x-forwarded-proto': 'http'
      }
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error for %s: %s', sanitizeForLog(appName), sanitizeForLog(err.message));
      if (!res.headersSent) {
        sendError(res, 502, 'Proxy target unreachable');
      }
    });

    proxyReq.on('response', (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    req.pipe(proxyReq);
  } catch (error) {
    sendError(res, 500, 'Proxy error');
  }
}

async function handleApiRequest(req, res) {
  const clientIP = getClientIP(req);
  
  // Check IP whitelist first
  if (!checkIPWhitelist(clientIP, ADMIN_IPS)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  
  // Check rate limit
  if (!checkRateLimit(clientIP)) {
    sendError(res, 429, 'Too Many Requests');
    return;
  }
  
  if (!checkAuth(req)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  const urlParts = req.url.split('?')[0].split('/').filter(Boolean);
  const [action, appName] = urlParts;

  if (!appName || !action) {
    sendError(res, 400, 'Invalid request');
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
      sendError(res, 404, 'Not found');
    }
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleProxyRequest(req, res) {
  const clientIP = getClientIP(req);
  
  // Check IP whitelist for proxy
  if (!checkIPWhitelist(clientIP, PROXY_IPS)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  const fullUrl = req.url.split('?')[0];
  const urlParts = fullUrl.split('/').filter(Boolean);
  
  if (urlParts.length === 0) {
    if (apps['nlever_home']) {
      await proxyRequest(req, res, 'nlever_home', '/');
      return;
    }
    
    if (APP_LISTINGS) {
      // Root path - show app listing
      const appList = Object.keys(apps).map(name => 
        `<li><a href="/${name}/">${name}</a></li>`
      ).join('');
      
      const html = `<!DOCTYPE html>
<html><head><title>nlever app listing</title></head>
<body><h1>Deployed Apps</h1><ul>${appList}</ul></body></html>`;
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      sendError(res, 404, 'Not found');
    }
    return;
  }

  // Special route for JSON app listing
  if (urlParts.length === 1 && urlParts[0] === 'app_toc') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apps: Object.keys(apps) }));
    return;
  }

  const [appName] = urlParts;
  
  if (!apps[appName]) {
    sendError(res, 404, 'App not found');
    return;
  }

  const proxyPath = '/' + urlParts.slice(1).join('/') + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
  
  try {
    await proxyRequest(req, res, appName, proxyPath);
  } catch (error) {
    sendError(res, 500, error.message);
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
    
    try {
      execSync('pm2 startup', { stdio: 'inherit' });
      console.log('✓ PM2 startup script created');
    } catch {
      console.log('⚠ PM2 startup script creation failed (requires root privileges)');
      console.log('  Run "sudo pm2 startup" once for auto-start on boot');
    }
    
    await fs.unlink(configFile);
    
    console.log('✓ nlever-server installed and started with PM2');
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
    // Try to create the directory first, then test write access
    await fs.mkdir(BASE_DIR, { recursive: true });
    await fs.access(BASE_DIR, fs.constants.W_OK);
  } catch {
    console.log(`Cannot create or write to ${BASE_DIR}, using ~/nlever-apps`);
    BASE_DIR = join(process.env.HOME, 'nlever-apps');
    process.env.NLEVER_BASE_DIR = BASE_DIR;
    REGISTRY_FILE = join(BASE_DIR, '.nlever-apps.json');
  }
  
  await loadRegistry();
  
  // API server (always runs)
  const apiServer = createServer(handleApiRequest);
  apiServer.listen(PORT, () => {
    console.log(`nlever API server listening on port ${PORT}`);
    console.log(`Base directory: ${process.env.NLEVER_BASE_DIR || BASE_DIR}`);
    console.log(`Auth: ${AUTH_TOKEN ? 'Enabled' : 'Disabled'}`);
    console.log(`Proxy mode: ${PROXY_MODE ? 'Enabled' : 'Disabled'}`);
    
    if (PROXY_MODE && PROXY_PORT) {
      console.log(`Proxy server will listen on port ${PROXY_PORT}`);
    }
  });
  
  // Proxy server (only when proxy mode is enabled)
  if (PROXY_MODE && PROXY_PORT) {
    const proxyServer = createServer(handleProxyRequest);
    proxyServer.listen(PROXY_PORT, () => {
      console.log(`nlever proxy server listening on port ${PROXY_PORT}`);
    });
  }
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
