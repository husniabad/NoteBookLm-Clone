# Start with a Node.js version that matches your local environment
FROM node:24-slim

# Set the working directory
WORKDIR /app

# Install the necessary system software for pdf2pic
RUN apt-get update && apt-get install -y --no-install-recommends \
    graphicsmagick \
    poppler-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy your package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy the rest of your app's code
COPY . .

# Build your Next.js app
RUN npm run build

# Expose the port and set the start command
EXPOSE 3000
CMD ["npm", "start"]