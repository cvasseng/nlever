#!/usr/bin/env node

// nlever: A CLI tool to deploy and manage Node.js applications on a remote server.
// Chris Vasseng <hello@vasseng.com>
// https://github.com/cvasseng/nlever
// Licensed under the MIT License.

import { promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import { spawn, execSync } from 'child_process';
import { tmpdir } from 'os';
import { createReadStream } from 'fs';
import { request } from 'http';
import { request as httpsRequest } from 'https';

const CONFIG_FILE = '.env';
let config = {};

function loadConfig() {
  try {
    const envContent = readFileSync(CONFIG_FILE, 'utf8');
    envContent.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) {
        config[key.trim()] = value.trim();
      }
    });
  } catch {
    console.error('No .env file found. Please create one with:');
    console.error('NLEVER_NAME=myapp');
    console.error('NLEVER_HOST=server.lan:8080');
    console.error('NLEVER_AUTH=token (optional)');
    console.error('NLEVER_HEALTH_CHECK=/health (optional)');
    process.exit(1);
  }

  if (!config.NLEVER_NAME || !config.NLEVER_HOST) {
    console.error('Missing required config: NLEVER_NAME and NLEVER_HOST');
    process.exit(1);
  }
}

async function createArchive() {
  const timestamp = Date.now();
  const archivePath = join(tmpdir(), `nlever-${config.NLEVER_NAME}-${timestamp}.tar.gz`);
  
  console.log('Creating deployment archive...');
  
  // Default exclusions
  let exclusions = ['.git', 'node_modules', '*.log', '.env*'];
  
  // Use custom exclusions if specified
  if (config.NLEVER_EXCLUSIONS) {
    exclusions = config.NLEVER_EXCLUSIONS.split(',').map(s => s.trim());
    console.log('Using custom exclusions:', exclusions.join(', '));
  }
  
  const tarArgs = [];
  exclusions.forEach(pattern => {
    tarArgs.push(`--exclude=${pattern}`);
  });
  
  // Check if .env.nlever exists - if so, rename it to .env and exclude existing .env
  try {
    await fs.access('.env.nlever');
    tarArgs.push('--transform', 's/.env.nlever$/.env/');
    tarArgs.push('--exclude=.env');
    console.log('Using .env.nlever as .env in deployment (excluding any existing .env)');
  } catch {
    // .env.nlever doesn't exist, no-op
  }
  
  tarArgs.push('-czf', archivePath, '.');
  
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', tarArgs, { stdio: 'inherit' });
    
    tar.on('close', code => {
      if (code === 0) {
        resolve(archivePath);
      } else {
        reject(new Error(`tar failed with code ${code}`));
      }
    });
    
    tar.on('error', reject);
  });
}

function formatNetworkError(error, host, port) {
  if (error.code === 'ECONNREFUSED') {
    return `Connection refused at ${host}:${port}. Is the server running?`;
  } else if (error.code === 'ENOTFOUND') {
    return `Host not found: ${host}`;
  } else if (error.code === 'ETIMEDOUT') {
    return `Connection timeout to ${host}:${port}`;
  }
  return error.message || 'Unknown network error';
}

async function httpRequest(method, path, options = {}) {
  const [host, port = '80'] = config.NLEVER_HOST.split(':');
  const isHttps = port === '443' || config.NLEVER_HOST.startsWith('https://');
  const requestFn = isHttps ? httpsRequest : request;
  
  const headers = options.headers || {};
  if (config.NLEVER_AUTH) {
    headers['Authorization'] = `Bearer ${config.NLEVER_AUTH}`;
  }

  return new Promise((resolve, reject) => {
    const req = requestFn({
      hostname: host,
      port: parseInt(port),
      path,
      method,
      headers,
      timeout: options.timeout || 30000
    }, res => {
      if (options.stream) {
        resolve({ res, req });
      } else if (options.pipe) {
        res.pipe(options.pipe);
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      } else {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    });
    
    req.on('error', error => {
      const errorMsg = formatNetworkError(error, host, port);
      if (options.onError) {
        options.onError(errorMsg);
      } else {
        console.error(`✗ Request failed: ${errorMsg}`);
      }
      reject(error);
    });
    
    if (options.stream) {
      resolve({ req });
    } else if (!options.body) {
      req.end();
    }
  });
}

async function push() {
  try {
    execSync('which tar', { stdio: 'ignore' });
  } catch {
    console.error('tar command not found. Please install tar first.');
    process.exit(1);
  }

  const archivePath = await createArchive();
  const fileSize = (await fs.stat(archivePath)).size;
  
  console.log(`Uploading ${(fileSize / 1024 / 1024).toFixed(2)} MB...`);
  
  let path = `/deploy/${config.NLEVER_NAME}`;
  if (config.NLEVER_HEALTH_CHECK) {
    path += `?health_check=${encodeURIComponent(config.NLEVER_HEALTH_CHECK)}`;
  }
  
  try {
    const { req } = await httpRequest('POST', path, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize
      },
      timeout: 300000,
      stream: true,
      onError: async (errorMsg) => {
        await fs.unlink(archivePath);
        console.error(`\n✗ Upload failed: ${errorMsg}`);
      }
    });

    let uploadedBytes = 0;
    let lastProgress = 0;
    
    const stream = createReadStream(archivePath);
    stream.on('data', chunk => {
      uploadedBytes += chunk.length;
      const progress = Math.floor((uploadedBytes / fileSize) * 100);
      if (progress > lastProgress) {
        process.stdout.write(`\rUploading... ${progress}%`);
        lastProgress = progress;
      }
    });
    
    return new Promise((resolve, reject) => {
      req.on('response', res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', async () => {
          await fs.unlink(archivePath);
          
          if (res.statusCode === 200) {
            console.log('\n✓ Deployment successful');
            resolve();
          } else {
            try {
              const error = JSON.parse(body);
              console.error(`\n✗ Deployment failed: ${error.error}`);
            } catch {
              console.error(`\n✗ Deployment failed with status ${res.statusCode}`);
            }
            reject();
          }
        });
      });
      
      stream.pipe(req);
    });
  } catch (error) {
    throw error;
  }
}

async function rollback() {
  const { statusCode, body } = await httpRequest('POST', `/rollback/${config.NLEVER_NAME}`);
  
  if (statusCode === 200) {
    console.log('✓ Rollback successful');
  } else {
    try {
      const error = JSON.parse(body);
      console.error(`✗ Rollback failed: ${error.error}`);
    } catch {
      console.error(`✗ Rollback failed with status ${statusCode}`);
    }
    throw new Error('Rollback failed');
  }
}

async function status() {
  const { statusCode, body } = await httpRequest('GET', `/status/${config.NLEVER_NAME}`);
  
  if (statusCode === 200) {
    const status = JSON.parse(body);
    console.log(`App: ${status.name}`);
    console.log(`Status: ${status.pm2.status}`);
    console.log(`CPU: ${status.pm2.cpu}%`);
    console.log(`Memory: ${Math.round(status.pm2.memory / 1024 / 1024)} MB`);
    console.log(`Uptime: ${new Date(status.pm2.uptime).toISOString()}`);
    console.log(`Restarts: ${status.pm2.restarts}`);
  } else {
    try {
      const error = JSON.parse(body);
      console.error(`✗ ${error.error}`);
    } catch {
      console.error(`✗ Failed with status ${statusCode}`);
    }
    throw new Error('Status check failed');
  }
}

async function logs() {
  const lines = process.argv[3] || '100';
  
  const { statusCode } = await httpRequest('GET', `/logs/${config.NLEVER_NAME}?lines=${lines}`, {
    pipe: process.stdout
  });
  
  if (statusCode !== 200) {
    console.error(`\n✗ Failed to get logs with status ${statusCode}`);
    throw new Error('Failed to get logs');
  }
}

async function stop() {
  const { statusCode, body } = await httpRequest('POST', `/stop/${config.NLEVER_NAME}`);
  
  if (statusCode === 200) {
    console.log('✓ App stopped successfully');
  } else {
    try {
      const error = JSON.parse(body);
      console.error(`✗ Stop failed: ${error.error}`);
    } catch {
      console.error(`✗ Stop failed with status ${statusCode}`);
    }
    throw new Error('Stop failed');
  }
}

async function restart() {
  const { statusCode, body } = await httpRequest('POST', `/restart/${config.NLEVER_NAME}`);
  
  if (statusCode === 200) {
    console.log('✓ App restarted successfully');
  } else {
    try {
      const error = JSON.parse(body);
      console.error(`✗ Restart failed: ${error.error}`);
    } catch {
      console.error(`✗ Restart failed with status ${statusCode}`);
    }
    throw new Error('Restart failed');
  }
}

async function destroy() {
  const { statusCode, body } = await httpRequest('POST', `/destroy/${config.NLEVER_NAME}`);
  
  if (statusCode === 200) {
    console.log('✓ App destroyed successfully');
  } else {
    try {
      const error = JSON.parse(body);
      console.error(`✗ Destroy failed: ${error.error}`);
    } catch {
      console.error(`✗ Destroy failed with status ${statusCode}`);
    }
    throw new Error('Destroy failed');
  }
}

async function init() {
  let envContent = '';
  let existingVars = {};
  
  // Read existing .env file if it exists
  try {
    envContent = await fs.readFile(CONFIG_FILE, 'utf8');
    
    // Parse existing variables
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([A-Z_]+)=/);
      if (match) {
        existingVars[match[1]] = true;
      }
    });
  } catch {
    // No existing .env file
  }
  
  let appName = '';
  
  // Try to read app name from package.json
  try {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    if (packageJson.name) {
      appName = packageJson.name;
      console.log(`✓ Found app name from package.json: ${appName}`);
    }
  } catch {
    // No package.json or no name field
  }
  
  const newVars = [];
  
  // Add required variables if they don't exist
  if (!existingVars.NLEVER_NAME) {
    newVars.push(`NLEVER_NAME=${appName}`);
  }
  
  if (!existingVars.NLEVER_HOST) {
    newVars.push('NLEVER_HOST=');
  }
  
  // Add optional variables as comments if they don't exist
  if (!existingVars.NLEVER_AUTH) {
    newVars.push('# NLEVER_AUTH=your-secret-token       # Optional, must match server');
  }
  
  if (!existingVars.NLEVER_HEALTH_CHECK) {
    newVars.push('# NLEVER_HEALTH_CHECK=/health         # Optional, endpoint to verify deployment');
  }
  
  if (!existingVars.NLEVER_EXCLUSIONS) {
    newVars.push('# NLEVER_EXCLUSIONS=.git,node_modules,*.log  # Optional, custom exclusion patterns');
  }
  
  if (newVars.length === 0) {
    console.log('✓ .env file already has all nlever variables');
    return;
  }
  
  // Append new variables
  if (envContent && !envContent.endsWith('\n')) {
    envContent += '\n';
  }
  
  if (envContent) {
    envContent += '\n# nlever configuration\n';
  }
  
  envContent += newVars.join('\n') + '\n';
  
  await fs.writeFile(CONFIG_FILE, envContent);
  
  console.log('✓ Created/updated .env file with nlever configuration');
  console.log('✗ Remember to set NLEVER_HOST before deploying');
}

async function run() {
  const command = process.argv[2];
  
  // Init doesn't need config loaded
  if (command === 'init') {
    try {
      await init();
    } catch (error) {
      console.error('✗ Init failed:', error.message);
      process.exit(1);
    }
    return;
  }
  
  loadConfig();
  
  try {
    switch (command) {
      case 'push':
        await push();
        break;
      case 'rollback':
        await rollback();
        break;
      case 'status':
        await status();
        break;
      case 'logs':
        await logs();
        break;
      case 'stop':
        await stop();
        break;
      case 'restart':
        await restart();
        break;
      case 'destroy':
        await destroy();
        break;
      default:
        console.log('Usage: nlever <command>');
        console.log('Commands:');
        console.log('  init      - Initialize .env file with nlever configuration');
        console.log('  push      - Deploy current directory');
        console.log('  rollback  - Rollback to previous version');
        console.log('  status    - Check app status');
        console.log('  logs [n]  - Get app logs (default 100 lines)');
        console.log('  stop      - Stop the app');
        console.log('  restart   - Restart the app');
        console.log('  destroy   - Completely remove the app');
        process.exit(1);
    }
  } catch (error) {
    process.exit(1);
  }
}

run();
