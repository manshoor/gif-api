FROM node:18-bullseye-slim

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PUPPETEER_HEADLESS=new
# Add explicit sandbox configuration
ENV CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox
ENV NPM_CONFIG_LOGLEVEL=warn
ENV CI=true


# Install required dependencies including canvas dependencies
RUN apt-get update && apt-get install -y \
    dbus \
    dbus-x11 \
    pulseaudio \
    alsa-utils \
    libasound2 \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    ffmpeg \
    # Graphics and X11 dependencies
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libcups2 \
    libxrandr2 \
    libatk1.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libxss1 \
    libnss3 \
    # Canvas dependencies
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    # Additional utilities
    procps \
    wget \
    git \
    # Clean up
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
#RUN npm install --omit=dev
RUN npm install -g npm@10.2.4

# Development dependencies
#RUN npm install --global nodemon
#RUN npm install && npm cache clean --force

# Production dependencies
RUN npm i --only=production && npm cache clean --force


# Copy app source
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p temp_screenshots public/gifs \
    && chown -R node:node /usr/src/app

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Start the application
# Development command
#CMD [ "npm", "run", "dev" ]
# Production command
CMD [ "npm", "run", "start" ]