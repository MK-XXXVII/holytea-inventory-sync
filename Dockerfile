FROM node:22-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the source
COPY . .

# Set env var for production
ENV NODE_ENV=production

# Default command: run the worker once and exit
CMD ["node", "index.mjs"]
