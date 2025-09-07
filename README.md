# nlever

Zero-dependency Node.js deployment tool. Push code through HTTP to any VM without git hooks, SSH keys, or CI/CD setup.

## What's up with the name?

It's a triple-pun: "N" is for Node.js, "lever" as in a simple machine to lift heavy things, "lever" as in Norwegian for "lives" and Norwegian for "deliver".

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

# Or manually with environment variables
NLEVER_PORT=8080 \
NLEVER_BASE_DIR=/var/www \
NLEVER_AUTH_TOKEN=your-secret-token \
nlever-server --install
```

To uninstall:
```bash
nlever-server --uninstall
```

## Client Usage

In your Node.js project directory, create a `.env` file:

```env
NLEVER_NAME=myapp
NLEVER_HOST=server.lan:8080
NLEVER_AUTH=your-secret-token       # Optional, must match server
NLEVER_HEALTH_CHECK=/health         # Optional, endpoint to verify deployment
```

Deploy your application:

```bash
# Deploy current directory
nlever push

# Check deployment status
nlever status

# View application logs
nlever logs
nlever logs 500  # Last 500 lines

# Rollback to previous version
nlever rollback
```

## How It Works

1. **Push**: Creates tar.gz of your project (excluding .git, node_modules, logs, .env)
2. **Deploy**: Extracts to timestamped release directory
3. **Activate**: Updates symlinks atomically (current → new release)
4. **PM2**: Restarts or starts your app with PM2
5. **Health Check**: Optionally waits for health endpoint to return 200
6. **Cleanup**: Removes old releases, keeping only the current working version

## Features

- **Atomic Deployments** - Zero-downtime using symlinks
- **Auto-Rollback** - Reverts on PM2 failure or health check failure
- **Concurrent Deploy Protection** - Lock files prevent simultaneous deployments
- **PM2 Integration** - Automatic process management
- **Health Checks** - Verify deployment success with custom endpoint
- **Minimal Dependencies** - Only requires Node.js, tar, and PM2

## Directory Structure

On the server:
```
/var/www/
├── .nlever-apps.json      # App registry
├── myapp/
│   ├── current/           → releases/1693847234/
│   ├── previous/          → releases/1693847123/
│   ├── .nlever-deploying  # Lock file (when deploying)
│   └── releases/
│       └── 1693847234/    # Current release
```

## API Endpoints

- `POST /deploy/:appname?health_check=/health` - Deploy application
- `POST /rollback/:appname` - Rollback to previous version  
- `GET /status/:appname` - Get PM2 process status
- `GET /logs/:appname?lines=100` - Get application logs

## Environment Variables

### Server
- `NLEVER_PORT` - Server port (default: 8080)
- `NLEVER_BASE_DIR` - Base directory for apps (default: /var/www)
- `NLEVER_AUTH_TOKEN` - Bearer token for authentication (optional)

### Client
- `NLEVER_NAME` - Application name
- `NLEVER_HOST` - Server host:port
- `NLEVER_AUTH` - Authentication token (optional)
- `NLEVER_HEALTH_CHECK` - Health endpoint path (optional)

## Requirements

- Node.js ≥ 14.0.0
- `tar` command available
- PM2 installed on deployment servers

## License

MIT
