FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY server.js .

# Expose port
EXPOSE 3000

# Set environment variable (can be overridden at runtime)
ENV PORT=3000

# Start the server
CMD ["npm", "start"]
