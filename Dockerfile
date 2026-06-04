# Minimal image for the coread app (web/API + remote MCP).
# The full node:lts image is used so the native better-sqlite3 module can be
# built/installed without extra setup. Startup command is left to compose.
FROM node:lts

WORKDIR /app

# Install dependencies first to leverage Docker layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and build the web assets into ./public.
COPY . .
RUN npm run build

# No CMD on purpose: each compose service supplies its own command.
