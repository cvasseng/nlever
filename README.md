# nlever

Zero-dependency Node.js deployment tool. Push code through HTTP to any VM without git hooks, SSH keys, or CI/CD setup. Meant for simple apps in a trusted network.

nlever is considered feature-complete and stable, but is still early in its life.

## Quick Start

Defaults are fairly sensible, so after installing, you should be able to:

```bash

# Install server (requires that pm2 is also installed globally)
nlever-server --install

# Enable auto-start on boot (one-time setup, requires sudo)
sudo pm2 startup

# Set up the client
nlever init # Set up your project (run in your project directory)
nano .env  # Edit to set your server host for NLEVER_HOST
nlever push  # Deploy! App will now run on NLEVER_HOST.
```

## What's up with the name?

It's a triple-pun: "N" is for Node.js, "lever" as in a simple machine to lift heavy things, as in Norwegian for "lives", and finally as in Norwegian for "deliver".

## Installation

```bash
npm install -g nlever

# On deployment servers also install PM2
npm install -g pm2
```

## Server Setup

On your deployment server:

```bash
# Install and start the nlever server
nlever-server --install

# Enable auto-start on boot (one-time setup, requires sudo)
sudo pm2 startup

# Or manually with environment variables
NLEVER_PORT=8081 \
NLEVER_BASE_DIR=/var/www \
NLEVER_AUTH_TOKEN=your-secret-token \
NLEVER_PROXY=yes \
NLEVER_PROXY_PORT=8080 \
nlever-server --install

# Then enable auto-start
sudo pm2 startup
```

**Important:** The `sudo pm2 startup` command is needed only once per server to enable automatic restart after reboots. Without it, you'll need to manually restart nlever-server after each reboot.

To uninstall:
```bash
nlever-server --uninstall
```

## Client Usage

In your Node.js project directory:

```bash
# Initialize nlever configuration
nlever init

# Edit .env to set your server host
nano .env
```

Or manually create a `.env` file:

```env
NLEVER_NAME=myapp
NLEVER_HOST=server.lan              # Port defaults to 8081 if not specified
NLEVER_AUTH=your-secret-token       # Optional, must match server
NLEVER_HEALTH_CHECK=/health         # Optional, endpoint to verify deployment
NLEVER_EXCLUSIONS=.git,node_modules,*.log  # Optional, custom exclusion patterns
```

### Deployment-Specific Environment Variables

If you need different environment variables for deployment vs development, create a `.env.nlever` file instead of (or alongside) `.env`:

```env
# .env.nlever - deployment-specific environment
NODE_ENV=production
DATABASE_URL=postgres://prod-server/myapp
API_BASE_URL=https://api.example.com
```

When `nlever push` runs:
- If `.env.nlever` exists, it will be renamed to `.env` in the deployment archive
- Any existing `.env` file will be ignored and excluded from the deployment
- This allows you to keep separate configs for development (`.env`) and production (`.env.nlever`)

**Main Usage**
```bash
# Deploy current directory
nlever push

# Check deployment status
nlever status

# View application logs
nlever logs
nlever logs 500  # Last 500 lines

# Download complete log file
nlever logs-download

# Rollback to previous version
nlever rollback

# Stop the app
nlever stop

# Restart the app  
nlever restart

# Completely remove the app
nlever destroy
```

## How It Works

1. **Push**: Creates tar.gz of your project (default excludes: .git, node_modules, *.log, .env*)
2. **Deploy**: Extracts to timestamped release directory
3. **Install**: Runs npm/yarn install to install dependencies
4. **Activate**: Updates symlinks atomically (current → new release)
5. **PM2**: Restarts or starts your app with PM2
6. **Health Check**: Optionally waits for health endpoint to return 200
7. **Cleanup**: Removes old releases, keeping only the current working version

## Features

- **Atomic Deployments** - Zero-downtime using symlinks
- **Auto-Rollback** - Reverts on PM2 failure or health check failure
- **Concurrent Deploy Protection** - Lock files prevent simultaneous deployments
- **PM2 Integration** - Automatic process management
- **Health Checks** - Verify deployment success with custom endpoint
- **Dependency Management** - Automatic npm/yarn install
- **App Management** - Stop, restart, and destroy commands
- **Proxy Mode** - Route apps through server paths (e.g., `server.com/myapp`)
- **Minimal Dependencies** - Only requires Node.js, tar, and PM2

## Directory Structure

On the server, the apps are stored as such:

```
<NLEVER_BASE_DIR>/
├── .nlever-apps.json      # App registry
├── myapp/
│   ├── current/           → releases/1693847234/
│   ├── previous/          → releases/1693847123/
│   ├── .nlever-deploying  # Lock file (when deploying)
│   └── releases/
│       └── 1693847234/    # Current release
```

## Proxy Mode

When `NLEVER_PROXY=yes` is set on the server, nlever enables a built-in HTTP proxy that routes requests through server paths:

- **Without proxy** (`NLEVER_PROXY=no`, default): Apps run on their default ports.
- **With proxy** (`NLEVER_PROXY=yes`): Apps are assigned unique ports and accessible via server paths.

### Separate Ports for Security

Proxy mode runs two separate HTTP servers:
- **API Server** (`NLEVER_PORT`, default 8081): Handles deployments, management commands - restrict with firewall
- **Proxy Server** (`NLEVER_PROXY_PORT`, default 8080): Handles public app traffic - open to public

This separation allows you to:
- Block API port (8081) from public access via firewall rules
- Keep proxy port (8080) open for public app traffic
- Use different authentication for each service

### Example with Proxy Mode

With `NLEVER_PORT=8081` and `NLEVER_PROXY_PORT=8080`:
- **Management**: `http://example.com:8081/deploy/myapp` (restricted)
- **App Access**: `http://example.com:8080/myapp` (public)
- Apps automatically receive `PORT=assigned_port` environment variable

### Port Management
- App ports are assigned starting from 3001 (3001, 3002, 3003...)
- Port assignments persist across server restarts
- Destroyed apps free their assigned ports

### Proxy Headers for Apps
When proxy mode is enabled, applications receive standard proxy headers to help them work correctly behind the proxy:

- `X-Forwarded-Prefix: /{appname}` - The path prefix the app is served under
- `X-Forwarded-For: <client-ip>` - Original client IP address
- `X-Real-IP: <client-ip>` - Alternative client IP header (some frameworks prefer this)
- `X-Forwarded-Proto: http` - Original protocol used by the client

Apps can use these headers to:
- Build correct absolute URLs using the forwarded prefix
- Log real client IPs instead of localhost
- Detect the original protocol for security purposes

**Example usage in an Express app:**
```javascript
app.use((req, res, next) => {
  const basePrefix = req.headers['x-forwarded-prefix'] || '';
  const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Use basePrefix for URL generation
  res.locals.apiUrl = `${basePrefix}/api`;
  res.locals.assetsUrl = `${basePrefix}/static`;
  
  next();
});
```

### App Listings and Custom Home Page

When proxy mode is enabled, you can control what appears at the root URL (`/`):

**App Listings (set `NLEVER_APP_LISTINGS=yes`):**
- **`/`** - Shows HTML page with clickable list of deployed apps
- **`/app_toc`** - Returns JSON: `{"apps": ["app1", "app2", ...]}`

**Custom Home Page:**
- Deploy an app named `nlever_home` to completely customize the root page
- The `nlever_home` app will handle all requests to `/` 
- JSON endpoint `/app_toc` continues to work for programmatic access
- This allows you to create custom dashboards, landing pages, or admin interfaces

**No Listings (default):**
- **`/`** - Returns 404 when `NLEVER_APP_LISTINGS` is set to something other than `yes`
- Apps are only accessible via their direct URLs (`/myapp`)

## Security Features

### Rate Limiting
The admin API endpoints are automatically rate limited to **10 requests per minute per IP address**. When exceeded, requests return `429 Too Many Requests`.

### IP Whitelisting
Control access to nlever services using IP allowlists:

**Admin API Protection:**
```bash
# Only allow specific IPs to access deployment/management endpoints
NLEVER_ADMIN_IPS_ALLOW=192.168.1.10,192.168.1.20,127.0.0.1
```

**Proxy Protection:**
```bash
# Control public app access (use * to allow all)
NLEVER_PROXY_IPS_ALLOW=*
# Or restrict to specific networks
NLEVER_PROXY_IPS_ALLOW=10.0.0.100,10.0.0.101,192.168.1.50
```

If whitelist variables are not set, all IPs are allowed by default.

## API Endpoints

These are the management endpoints exposed by `nlever-server`:

- `POST /deploy/:appname?health_check=/health` - Deploy application
- `POST /rollback/:appname` - Rollback to previous version
- `POST /stop/:appname` - Stop application
- `POST /restart/:appname` - Restart application  
- `POST /destroy/:appname` - Completely remove application
- `GET /status/:appname` - Get PM2 process status
- `GET /logs/:appname?lines=100` - Get application logs
- `GET /logs-download/:appname` - Download complete log file

When proxy mode is enabled, the proxy server (on `NLEVER_PROXY_PORT`) routes:
- `GET /:appname/*` - Proxy requests to the application

## Environment Variables

### Server
- `NLEVER_PORT` - API server port (default: 8081)
- `NLEVER_BASE_DIR` - Base directory for apps (default: /var/www, fallback: ~/nlever-apps)
- `NLEVER_AUTH_TOKEN` - Bearer token for authentication (optional)
- `NLEVER_PROXY` - Enable proxy mode: `yes` or `no` (default: no)
- `NLEVER_PROXY_PORT` - Proxy server port when proxy mode enabled (default: 8080)
- `NLEVER_APP_LISTINGS` - Enable app listing UI and `/app_toc` JSON endpoint: `yes` or unset (default: unset)
- `NLEVER_ADMIN_IPS_ALLOW` - Comma-separated IP whitelist for admin API (optional, allows all if unset)
- `NLEVER_PROXY_IPS_ALLOW` - Comma-separated IP whitelist for proxy server (optional, allows all if unset)

### Client
- `NLEVER_NAME` - Application name
- `NLEVER_HOST` - Server host:port (port defaults to 8081 if not specified)
- `NLEVER_AUTH` - Authentication token (optional)
- `NLEVER_HEALTH_CHECK` - Health endpoint path (optional)
- `NLEVER_EXCLUSIONS` - Custom exclusion patterns, comma-separated (optional, overrides defaults)

## Requirements

- Node.js ≥ 14.0.0
- `tar` command available
- PM2 installed on deployment servers

## License

MIT.
