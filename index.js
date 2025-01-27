const express = require('express');
const puppeteer = require('puppeteer');
const morgan = require('morgan');
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {exec, execSync} = require('child_process');
const cors = require('cors');
const UserAgent = require('user-agents');

const config = {
    server: {
        port: parseInt(process.env.PORT) || 3000,
        host: process.env.HOST || 'localhost'
    },
    viewport: {
        width: parseInt(process.env.VIEWPORT_WIDTH) || 1920,
        height: parseInt(process.env.VIEWPORT_HEIGHT) || 1080
    },
    screenshot: {
        delay: parseFloat(process.env.SCREENSHOT_DELAY) || 3.5,
        defaultDuration: parseInt(process.env.DEFAULT_DURATION) || 15,
        format: {
            default: process.env.SCREENSHOT_DEFAULT_FORMAT || 'jpeg',
            allowed: ['jpeg', 'png']
        },
        quality: {
            default: parseInt(process.env.SCREENSHOT_DEFAULT_QUALITY) || 80,
            min: 1,
            max: 100
        },
        dimensions: {
            default: {
                width: parseInt(process.env.SCREENSHOT_DEFAULT_WIDTH) || 1920,
                height: parseInt(process.env.SCREENSHOT_DEFAULT_HEIGHT) || 1080
            },
            min: {
                width: parseInt(process.env.SCREENSHOT_MIN_WIDTH) || 100,
                height: parseInt(process.env.SCREENSHOT_MIN_HEIGHT) || 100
            },
            max: {
                width: parseInt(process.env.SCREENSHOT_MAX_WIDTH) || 3840,
                height: parseInt(process.env.SCREENSHOT_MAX_HEIGHT) || 2160
            }
        }
    },
    gif: {
        quality: parseInt(process.env.GIF_QUALITY) || 10
    },
    dirs: {
        screenshots: process.env.SCREENSHOTS_DIR || 'public/screenshots',
        gifs: process.env.GIFS_DIR || 'public/gifs'
    },
    browser: {
        maxInstances: parseInt(process.env.MAX_BROWSER_INSTANCES) || 5,
        timeout: parseInt(process.env.BROWSER_TIMEOUT) || 30000
    },
    request: {
        timeout: parseInt(process.env.PAGE_TIMEOUT) || 120000 // 2 minutes
    },
    cleanup: {
        fileAge: parseInt(process.env.CLEANUP_FILE_AGE) || 24 * 60 * 60 * 1000, // 24 hours
        interval: parseInt(process.env.CLEANUP_INTERVAL) || 60 * 60 * 1000 // 1 hour
    }
};

// Parse API keys from environment variable
const API_KEYS = JSON.parse(process.env.API_KEYS || '{}');

// Initialize Express app
const app = express();
const rateLimits = new Map();
let activeBrowsers = new Set();

// Set up logging directory
const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
}

// Create write streams for logging
const accessLogStream = fs.createWriteStream(path.join(logDirectory, 'access.log'), { flags: 'a' });
const errorLogStream = fs.createWriteStream(path.join(logDirectory, 'error.log'), { flags: 'a' });

// Use morgan for logging HTTP requests
app.use(morgan('combined', { stream: accessLogStream }));

// Error handling middleware
app.use((err, req, res, next) => {
    errorLogStream.write(`${new Date().toISOString()} - ${err.stack}\n`);
    res.status(500).send('Something broke!');
});

const setupProcessErrorHandlers = () => {
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught Exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    // Handle memory warnings
    process.on('warning', (warning) => {
        logger.warn('Process warning:', warning);
        // Add warning to the logs
        if(warning.name === 'MemoryWarning') {
            checkMemoryUsage();
        }
    });
};

// Logging utility
const logger = {
    info: (message, meta = {}) => {
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            message,
            ...meta
        }));
    },
    warn: (message, meta = {}) => { // Add this method
        console.warn(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'warn',
            message,
            ...meta
        }));
    },
    error: (message, error, meta = {}) => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'error',
            message,
            error: error.message,
            stack: error.stack,
            ...meta
        }));
    }
};

// Middleware
app.use(express.json());
app.use(cors());

// Add correlation ID to requests
app.use((req, res, next) => {
    req.correlationId = crypto.randomBytes(16).toString('hex');
    next();
});

app.use(async (err, req, res, next) => {
    if (!res.headersSent) {
        logger.error('Application error:', {
            error: err.message,
            stack: err.stack,
            correlationId: req.correlationId
        });

        res.status(500).json({
            error: 'Internal server error',
            message: err.message,
            correlationId: req.correlationId
        });
    }
});

// Helper Functions
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const validateUrl = (url) => {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
        return false;
    }
};

const fileExists = async (filePath) => {
    try {
        await fsPromises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
};

const safeDeleteFile = async (filePath) => {
    try {
        if(await fileExists(filePath)) {
            await fsPromises.unlink(filePath);
            return true;
        }
    } catch(error) {
        if(error.code !== 'ENOENT') {
            logger.error(`Error deleting file ${filePath}`, error);
        }
    }
    return false;
};

const ensureDirectory = async (dirPath) => {
    try {
        await fsPromises.mkdir(dirPath, {recursive: true});
    } catch(error) {
        if(error.code !== 'EEXIST') {
            throw error;
        }
    }
};
async function ensureDirectoryExists(dir) {
    try {
        await fsPromises.access(dir);
    } catch {
        await fsPromises.mkdir(dir, { recursive: true });
        logger.info('Created directory', { dir });
    }
}
const withRetry = async (operation, maxRetries = 3) => {
    let lastError;
    for(let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch(error) {
            lastError = error;
            await delay(1000 * Math.pow(2, i)); // Exponential backoff
        }
    }
    throw lastError;
};

// Initialize directories
const initializeDirectories = async () => {
    const screenshotsDir = path.join(__dirname, config.dirs.screenshots);
    const gifsDir = path.join(__dirname, config.dirs.gifs);
    try {
        await Promise.all([
            ensureDirectory(screenshotsDir),
            ensureDirectory(gifsDir),
            ensureDirectory(path.join(__dirname, 'temp'))
        ]);
    } catch(error) {
        logger.error('Error creating directories', error);
        process.exit(1);
    }
};

// Process management functions
const killChromiumProcesses = async () => {
    try {
        // First try using process signals
        const chromiumPs = execSync('ps aux | grep -i chrom').toString();
        const processes = chromiumPs.split('\n')
                                    .filter(line => line.includes('chromium') || line.includes('chrome'))
                                    .map(line => line.split(/\s+/)[1])
                                    .filter(Boolean);

        for(const pid of processes) {
            try {
                process.kill(parseInt(pid), 'SIGTERM');
            } catch(e) {
                // Ignore errors for processes we can't kill
                logger.info(`Could not kill process ${pid}`, e);
            }
        }
    } catch(error) {
        logger.error('Error in kill chromium processes', error);
    }
};

const cleanupZombieProcesses = async () => {
    /*
        try {
            // Fix the command syntax
            execSync(`ps -A -ostat,ppid | grep -e '[zZ]' | awk '{print $2}' | xargs -r kill -9`);
        } catch(error) {
            if(error.status !== 1) {
                logger.error('Error cleaning zombie processes', error);
            }
        }
    */

    try {
        const result = execSync('ps aux | grep -i chrome').toString();
        const zombieProcesses = result.split('\n')
                                      .filter(line => line.includes('<defunct>'))
                                      .map(line => line.split(/\s+/)[1]);

        if (zombieProcesses.length > 0) {
            logger.info(`Cleaning up ${zombieProcesses.length} zombie processes`);
            zombieProcesses.forEach(pid => {
                try {
                    process.kill(parseInt(pid), 'SIGKILL');
                } catch (e) {
                    // Ignore errors for already dead processes
                }
            });
        }
    } catch (error) {
        logger.error('Error in zombie process cleanup:', error);
    }
};

const cleanupBrowsers = async () => {
    logger.info(`Cleaning up browsers. Active count: ${activeBrowsers.size}`);
    try {
        // Close all browser instances first
        for(const browser of activeBrowsers) {
            try {
                const pages = await browser.pages();
                await Promise.all(pages.map(page => page.close().catch(() => {})));
                await browser.close().catch(() => {});
            } catch(error) {
                logger.error('Error closing browser', error);
            }finally {
                activeBrowsers.delete(browser);
            }
        }
        activeBrowsers.clear();

        // Then kill any remaining processes
        await killChromiumProcesses();
    } catch(error) {
        logger.error('Error in cleanup', error);
    }
};
// Memory monitoring
const checkMemoryUsage = () => {
    const used = process.memoryUsage();
    const threshold = 1024 * 1024 * 1024; // 1GB

    if(used.heapUsed > threshold) {
        logger.info('High memory usage detected', {memoryUsage: used});
        if(global.gc) {
            global.gc();
        }
    }
};

// Browser management
const createBrowserInstance = async () => {
    // First, clean up any existing zombie processes
    try {
        execSync('pkill -f "chrome_crashpad" || true');
    } catch (e) {
        logger.error('Error cleaning up crashpad processes:', e);
    }
    if(activeBrowsers.size >= config.browser.maxInstances) {
        // Force cleanup of old instances
        await cleanupBrowsers();
        await delay(1000); // Give some time for cleanup
    }

    const browser = await puppeteer.launch({
        headless: process.env.PUPPETEER_HEADLESS,
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        timeout: parseInt(process.env.BROWSER_LAUNCH_TIMEOUT) || 60000, // Increased timeout
        pipe: true,
        ignoreHTTPSErrors: true,
        dumpio: true,
        env: {
            ...process.env,
            DISABLE_CRASHPAD: "true",
            DBUS_SESSION_BUS_ADDRESS: '/dev/null',
            NO_PROXY: 'localhost,127.0.0.1',
            CHROMIUM_FLAGS: '--disable-gpu,--no-sandbox,--disable-dev-shm-usage',
            LANGUAGE: 'en-US,en'
        },
        args: [
            '--user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 11_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.198 Safari/537.36"',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-skip-list',
            '--autoplay-policy=user-gesture-required',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-client-side-phishing-detection',
            '--disable-backgrounding-occluded-windows',
            '--enable-automation',
            '--disable-ipc-flooding-protection',
            '--start-maximized', // Start in maximized state
            '--proxy-server="direct://"',
            '--proxy-bypass-list=*',
            `--window-size=${config.viewport.width},${config.viewport.height + 120}`,
            '--no-zygote',
            '--single-process',
            '--disable-web-security',
            '--disable-features=site-per-process',
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '--disable-gpu-memory-buffer-video-frames',
            //
            '--disable-dbus',
            '--disable-features=VizDisplayCompositor',
            '--disable-features=AudioServiceOutOfProcess',
            //
            '--disable-notifications',
            '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
            '--font-render-hinting=none',
            // Network-specific flags
            '--disable-http2', // Disable HTTP/2 to prevent protocol errors
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--no-first-run',
            '--safebrowsing-disable-auto-update',
            // Memory and process flags
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-features=ScriptStreaming',
            '--js-flags="--max-old-space-size=512"',
            '--disable-gpu-sandbox',
            '--disable-software-rasterizer',
            '--no-default-browser-check',
            '--no-experiments',
            '--single-process', // Use single process to avoid complications
            // Window and rendering flags
            '--hide-scrollbars',
            '--mute-audio',
            // Error reporting and crash handling
            '--disable-crashpad',
            '--disable-crash-reporter',
            '--disable-features=CrashpadReporter,CrashReporter',
            '--disable-breakpad',
            '--no-crash-upload',
            // webcrt flags
            '--disable-webrtc-hw-encoding',
            '--disable-webrtc-hw-decoding',
            '--disable-webrtc-multiple-routes',
            '--disable-webrtc-hw-vp8-encoding',
            // Add TLS 1.3 support
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--disable-features=TranslateUI',
            '--disable-blink-features=AutomationControlled',
            '--disable-device-discovery-notifications',
            '--disable-session-crashed-bubble'
        ]
    });

    // Add error handling for browser disconnection
    browser.on('disconnected', async () => {
        logger.info('Browser disconnected, cleaning up...');
        activeBrowsers.delete(browser);
        try {
            execSync('pkill -f "chrome_crashpad" || true');
        } catch (e) {
            logger.error('Error cleaning up after browser disconnect:', e);
        }
        await cleanupZombieProcesses();
    });

    return browser;
};

// Add this new function
const createPageWithTimeout = async (browser) => {
    const page = await browser.newPage();

    // Set a default timeout for all operations
    page.setDefaultTimeout(30000);

    // Set up error handling
    page.on('console', msg => {
        logger.info('Browser console:', {
            type: msg.type(),
            text: msg.text(),
            location: msg.location()?.url  // Add source location if available
        });
    });

    page.on('requestfailed', request => {
        logger.error('Failed request:', {
            url: request.url(),
            errorText: request.failure()?.errorText || 'Unknown error',
            method: request.method(),
            resourceType: request.resourceType()
        });
    });

    // Add page error handler
    page.on('pageerror', error => {
        logger.error('Page error:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
    });

    // Add response error handler
    page.on('response', response => {
        if (!response.ok()) {
            logger.error('Failed response:', {
                url: response.url(),
                status: response.status(),
                statusText: response.statusText(),
                headers: response.headers()
            });
        }
    });

    return page;
};
// Rate limiting functions
const isRateLimitExceeded = (apiKey) => {
    const today = new Date().toDateString();
    const key = `${apiKey}_${today}`;
    const count = rateLimits.get(key) || 0;
    return count >= API_KEYS[apiKey].rateLimit;
};

const incrementRateLimit = (apiKey) => {
    const today = new Date().toDateString();
    const key = `${apiKey}_${today}`;
    rateLimits.set(key, (rateLimits.get(key) || 0) + 1);
};

const getNextResetTime = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
};

// Middleware
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;

    if(!apiKey) {
        return res.status(401).json({error: 'API key is required'});
    }

    if(!API_KEYS[apiKey]) {
        return res.status(401).json({error: 'Invalid API key'});
    }

    if(isRateLimitExceeded(apiKey)) {
        return res.status(429).json({
            error: 'Rate limit exceeded',
            limit: API_KEYS[apiKey].rateLimit,
            reset: getNextResetTime()
        });
    }

    incrementRateLimit(apiKey);
    next();
};

// Routes
app.use('/public', express.static('public'));
// Apply API key validation to all other routes
app.use(['/create-video'], validateApiKey);

app.use('/public/screenshots', express.static(path.join(__dirname, config.dirs.screenshots)));
// Health check endpoint
app.get('/health', (req, res) => {
    const formatBytes = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    };

    const formatUptime = (seconds) => {
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);

        return parts.join(' ');
    };

    const memoryUsage = process.memoryUsage();
    const now = new Date();

    const health = {
        status: 'OK',
        timestamp: now.toLocaleString(),
        server: {
            uptime: formatUptime(process.uptime()),
            startedAt: new Date(Date.now() - (process.uptime() * 1000)).toLocaleString(),
            // nodeVersion: process.version,
            // platform: process.platform
        },
        memory: {
            rss: formatBytes(memoryUsage.rss),
            heapTotal: formatBytes(memoryUsage.heapTotal),
            heapUsed: formatBytes(memoryUsage.heapUsed),
            external: formatBytes(memoryUsage.external)
        },
        browser: {
            activeInstances: activeBrowsers.size,
            maxInstances: config.browser.maxInstances
        },
        configuration: {
            // port: config.server.port,
            environment: process.env.NODE_ENV || 'development',
            viewport: `${config.viewport.width}x${config.viewport.height}`
        }
    };

    // Add directory status
    const getDirectoryStats = async () => {
        try {
            const screenshotsDir = path.join(__dirname, config.dirs.screenshots);
            const gifsDir = path.join(__dirname, config.dirs.gifs);
            const tempDir = path.join(__dirname, 'temp');

            const [screenshotFiles, gifFiles, tempFiles] = await Promise.all([
                fsPromises.readdir(screenshotsDir).catch(() => []),
                fsPromises.readdir(gifsDir).catch(() => []),
                fsPromises.readdir(tempDir).catch(() => [])
            ]);

            return {
                screenshots: {
                    count: screenshotFiles.filter(file => !shouldSkipFile(file)).length,
                    directory: config.dirs.screenshots
                },
                gifs: {
                    count: gifFiles.filter(file => !shouldSkipFile(file)).length,
                    directory: config.dirs.gifs
                },
                temp: {
                    count: tempFiles.filter(file => !shouldSkipFile(file)).length,
                    directory: 'temp'
                }
            };
        } catch (error) {
            return {
                error: 'Failed to get directory stats'
            };
        }
    };
    getDirectoryStats().then(dirStats => {
        health.storage = dirStats;
        res.json(health);
    }).catch(error => {
        health.storage = { error: error.message };
        res.json(health);
    });
});
// Helper function to capture frames
async function captureFrames(client, totalFrames, maxDuration) {
    const frames = [];
    let isCapturing = true;
    let startTime = Date.now();

    try {
        logger.info('Starting screencast', {
            totalFrames,
            maxDuration,
            timestamp: startTime
        });

        await client.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 90,
            maxWidth: config.viewport.width,
            maxHeight: config.viewport.height,
            everyNthFrame: 1
        });

        const framePromise = new Promise((resolve, reject) => {
            const frameHandler = async (event) => {
                try {
                    if(!isCapturing) return;

                    const { data, sessionId, metadata } = event;
                    frames.push(data);

                    // Acknowledge frame receipt
                    await client.send('Page.screencastFrameAck', { sessionId });

                    if (frames.length % 10 === 0) {
                        logger.info('Frame capture progress', {
                            frameCount: frames.length,
                            totalFrames,
                            timestamp: Date.now(),
                            elapsed: (Date.now() - startTime) / 1000
                        });
                    }

                    if(frames.length >= totalFrames) {
                        isCapturing = false;
                        client.off('Page.screencastFrame', frameHandler);
                        resolve();
                    }
                } catch (error) {
                    logger.error('Error in frame handler', {
                        error,
                        frameCount: frames.length,
                        totalFrames
                    });
                    reject(error);
                }
            };

            client.on('Page.screencastFrame', frameHandler);
        });

        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                logger.info('Capture timeout reached', {
                    framesCaptured: frames.length,
                    totalFrames,
                    duration: (Date.now() - startTime) / 1000
                });
                isCapturing = false;
                resolve();
            }, maxDuration * 1000);
        });

        // Wait for either completion or timeout
        await Promise.race([framePromise, timeoutPromise]);

    } catch (error) {
        logger.error('Error in captureFrames', {
            error,
            framesCaptured: frames.length,
            totalFrames,
            duration: (Date.now() - startTime) / 1000
        });
        throw error;
    } finally {
        try {
            // Ensure screencast is stopped
            await client.send('Page.stopScreencast').catch(() => {});
            logger.info('Screencast stopped', {
                finalFrameCount: frames.length,
                totalDuration: (Date.now() - startTime) / 1000
            });
        } catch (error) {
            logger.error('Error stopping screencast', error);
        }
    }

    if (frames.length === 0) {
        throw new Error('No frames captured during recording');
    }

    return frames;
}

// Helper function to generate output using FFmpeg
async function generateOutput(sessionDir, outputPath, fps, format) {
    return new Promise((resolve, reject) => {
        const width = Math.min(config.viewport.width, 800);

        // Different commands for different formats
        const ffmpegCommands = {
            gif: `ffmpeg -y -framerate ${fps} -i ${sessionDir}/frame_%06d.jpg `
                + `-vf "fps=${fps},scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,split[s0][s1];`
                + `[s0]palettegen=max_colors=128:stats_mode=diff[p];`
                + `[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" `
                + `-f gif ${outputPath}`,
            mp4: `ffmpeg -y -framerate ${fps} -i ${sessionDir}/frame_%06d.jpg `
                + `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" `
                + `-c:v libx264 -preset medium -crf 23 -movflags +faststart `
                + `-pix_fmt yuv420p ${outputPath}`
        };

        const command = ffmpegCommands[format] || ffmpegCommands.gif;

        logger.info('Starting FFmpeg conversion', {
            format,
            fps,
            outputPath,
            command
        });

        exec(command, (error, stdout, stderr) => {
            if(error) {
                logger.error('FFmpeg error', {
                    error,
                    stderr,
                    command,
                    outputPath
                });
                reject(new Error(`FFmpeg error: ${stderr}`));
            } else {
                logger.info('FFmpeg conversion complete', {
                    outputPath,
                    format
                });
                resolve();
            }
        });
    });
}

const scrollThroughPage = async (page) => {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100; // Scroll distance in pixels
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                // Stop scrolling when we reach the bottom of the page
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100); // Scroll every 100ms
        });
    });
};

const setupUserAgent = async (page) => {
    const userAgent = new UserAgent({deviceCategory: 'desktop'}).toString();
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/',
    });
}

// Create Video endpoint
app.post('/create-video', validateApiKey, async (req, res) => {
    const {url, duration = config.screenshot.defaultDuration, format = 'gif'} = req.body;
    const sessionId = crypto.randomBytes(16).toString('hex');
    const startTime = Date.now();

    let browser = null;
    let page = null;
    let client = null;
    let outputPath = null;
    let sessionDir = null;

    logger.info('Starting video creation request', {
        url,
        format,
        duration,
        sessionId,
        correlationId: req.correlationId
    });

    if(!url || !validateUrl(url)) {
        return res.status(400).json({error: 'Valid URL is required'});
    }

    if (!format.match(/^(gif|mp4)$/)) {
        return res.status(400).json({
            error: 'Invalid format',
            message: 'Only gif and mp4 formats are supported'
        });
    }

    try {
        if(activeBrowsers.size >= config.browser.maxInstances) {
            logger.info('Cleaning up browsers before new request', {
                activeBrowsers: activeBrowsers.size,
                sessionId
            });
            await cleanupBrowsers();
        }

        // Create and ensure directories
        sessionDir = path.join(__dirname, 'temp', sessionId);
        await ensureDirectoryExists(sessionDir);
        await ensureDirectoryExists(path.join(__dirname, config.dirs.gifs));

        // Initialize browser and page
        browser = await createBrowserInstance();
        page = await createPageWithTimeout(browser);
        client = await page.createCDPSession();

        await page.setViewport({
            width: config.viewport.width,
            height: config.viewport.height,
            deviceScaleFactor: 1
        });

        await setupUserAgent(page);

        // Navigate to URL with retry logic
        await withRetry(async () => {
            await page.goto(url, {
                waitUntil: ['networkidle0', 'domcontentloaded'],
                timeout: 30000,
                ignoreHTTPSErrors: true // Ignore SSL errors
            });

            await delay(2000);

            // Wait for page to be fully loaded
            await page.evaluate(() => {
                return new Promise((resolve) => {
                    if (document.readyState === 'complete') {
                        resolve();
                    } else {
                        window.addEventListener('load', resolve);
                    }
                });
            });
        });

        // Setup capture parameters
        const maxDuration = Math.min(duration, config.screenshot.defaultDuration);
        const fps = 10;
        const totalFrames = Math.ceil(maxDuration * fps);

        logger.info('Starting video capture', {
            totalFrames,
            maxDuration,
            fps,
            format,
            sessionId
        });

        // Capture frames
        const frames = await captureFrames(client, totalFrames, maxDuration);

        logger.info('Starting frame writing', {
            frameCount: frames.length,
            sessionDir
        });

        // Write frames to disk in batches
        const batchSize = 10;
        for (let i = 0; i < frames.length; i += batchSize) {
            const batch = frames.slice(i, i + batchSize);
            await Promise.all(batch.map(async (frameData, index) => {
                const framePath = path.join(sessionDir, `frame_${(i + index).toString().padStart(6, '0')}.jpg`);
                await fsPromises.writeFile(framePath, frameData, 'base64');
            }));

                    logger.info('Frame writing progress', {
                writtenFrames: i + batch.length,
                        totalFrames: frames.length,
                        sessionId
                    });
                }

        logger.info('Frame writing complete', {
            writtenFrames: frames.length,
            totalFrames: frames.length,
            sessionId
        });

        // Generate output file
        const outputFilename = `${sessionId}.${format}`;
        outputPath = path.join(config.dirs.gifs, outputFilename);

        await generateOutput(sessionDir, outputPath, fps, format);

        // Generate response URL
        const videoUrl = `${config.server.host}/public/gifs/${outputFilename}`;

        logger.info('Video creation successful', {
            url: videoUrl,
            format,
            sessionId,
            duration: (Date.now() - startTime) / 1000
        });

        res.json({
            success: true,
            url: videoUrl,
            message: `${format.toUpperCase()} created successfully`
        });

    } catch (error) {
        const errorDuration = (Date.now() - startTime) / 1000;
        logger.error('Error creating video', {
            error,
            correlationId: req.correlationId,
            sessionId,
            duration: errorDuration
        });
        res.status(500).json({
            error: `Failed to create ${format.toUpperCase()}`,
            details: error.message
        });
    } finally {
        try {
            // Cleanup in specific order
            if (client) {
                try {
                    await client.detach().catch(() => {});
                } catch (e) {
                    logger.error('Error detaching CDP session', e, { sessionId });
                }
            }

            if (page) {
                try {
                    await page.close().catch(() => {});
                } catch (e) {
                    logger.error('Error closing page', e, { sessionId });
                }
            }

            if(browser) {
                try {
                    await browser.close().catch(() => {
                    });
                    activeBrowsers.delete(browser);
                } catch (e) {
                    logger.error('Error closing browser', e, { sessionId });
                }
            }

            // Cleanup directories and files
            if(sessionDir) {
                try {
                    await fsPromises.rm(sessionDir, { recursive: true, force: true })
                                    .catch((e) => logger.error('Error removing session directory', e, { sessionDir, sessionId }));
                } catch (e) {
                    logger.error('Error in session directory cleanup', e, { sessionDir, sessionId });
                }
            }

            logger.info('Cleanup completed', {
                sessionId,
                totalDuration: (Date.now() - startTime) / 1000
            });
        } catch(error) {
            logger.error('Error in cleanup', error, {
                correlationId: req.correlationId,
                sessionId
            });
        }
    }
});


app.post('/create-screenshot', validateApiKey, async (req, res) => {
    // Extract parameters from the request body with fallback/default values
    const {
        url,
        delay: delayTime = config.screenshot.delay || 2.0, // Default delay: 2.0 seconds
        format = config.screenshot.format.default || 'jpeg', // Default format: jpeg
        quality = config.screenshot.quality.default || 90, // Default quality: 90
        width = config.screenshot.dimensions.default.width || 1366, // Default width: 1366
        height = config.screenshot.dimensions.default.height || 1080, // Default height: 1080
        fullPage = false // Default to false if not provided
    } = req.body;

    const sessionId = crypto.randomBytes(16).toString('hex');
    const startTime = Date.now();

    let browser = null;
    let page = null;

    logger.info('Starting screenshot creation request', {
        url,
        format,
        quality,
        width,
        height,
        fullPage,
        delay: delayTime,
        sessionId,
        correlationId: req.correlationId
    });

    // Validate URL
    if (!url || !validateUrl(url)) {
        return res.status(400).json({ error: 'Valid URL is required' });
    }

    // Validate format
    if (!config.screenshot.format.allowed.includes(format)) {
        return res.status(400).json({
            error: 'Invalid format',
            message: `Allowed formats: ${config.screenshot.format.allowed.join(', ')}`
        });
    }

    // Validate dimensions
    if (
        width < config.screenshot.dimensions.min.width || width > config.screenshot.dimensions.max.width ||
        height < config.screenshot.dimensions.min.height || height > config.screenshot.dimensions.max.height
    ) {
        return res.status(400).json({
            error: 'Invalid dimensions',
            message: `Width must be between ${config.screenshot.dimensions.min.width} and ${config.screenshot.dimensions.max.width}, height between ${config.screenshot.dimensions.min.height} and ${config.screenshot.dimensions.max.height}`
        });
    }

    try {
        // Ensure directories exist
        await ensureDirectoryExists(config.dirs.screenshots);

        // Create a browser instance with a random user agent
        browser = await createBrowserInstance();
        page = await createPageWithTimeout(browser);

        // Set a random user agent
        await setupUserAgent(page);
        // Set viewport size
        await page.setViewport({ width: parseInt(width), height: parseInt(height), deviceScaleFactor: 1 });

        // Enable request interception
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const blockedResourceTypes = [
                // 'image', // Block images (optional, depending on your needs)
                'media', // Block media (videos, audio)
                'font',  // Block fonts
                // 'stylesheet', // Block stylesheets (optional, depending on your needs)
            ];

            const blockedDomains = [
                'google-analytics.com',
                'googletagmanager.com',
                'facebook.net',
                'twitter.com',
                'linkedin.com',
                'connect.facebook.net',
                'analytics.twitter.com',
                'doubleclick.net',
                'coinbase.com',
                'coin-hive.com',
                'crypto-loot.com',
                'miner.pr0gramm.com',
                'cdn-cgi/challenge-platform',
                'adservice.google.com',
                'ads.google.com',
                'ad.doubleclick.net',
                'adservice.google.com',
                'adservice.google.*',
                'ads.*.com',
                'tracking.*',
                'analytics.*',
                'pixel.*',
                'beacon.*',
                'crypto.*',
                'miner.*',
            ];

            const url = request.url();

            // Block specific resource types
            if (blockedResourceTypes.includes(request.resourceType())) {
                request.abort();
                return;
            }

            // Block specific domains
            if (blockedDomains.some(domain => url.includes(domain))) {
                request.abort();
                return;
            }

            // Allow all other requests
                request.continue();
        });
        // Navigate to the URL with retry logic
        await withRetry(async () => {
            try {
            await page.goto(url, {
                waitUntil: ['networkidle0', 'domcontentloaded'],
                    timeout: parseInt(process.env.PAGE_NAVIGATION_TIMEOUT) || 60000,
                    ignoreHTTPSErrors: true // Add this line to ignore SSL errors
            });
            } catch (error) {
                // Log the SSL error but continue to capture the screenshot
                if (error.message.includes('ERR_CERT_COMMON_NAME_INVALID')) {
                    logger.warn('SSL certificate error, but proceeding to capture screenshot', {
                        url,
                        error: error.message
                    });
                } else {
                    throw error; // Re-throw other errors
                }
            }

            // Wait for the specified delay
            await delay(parseFloat(delayTime) * 1000);

            // Wait for page to be fully loaded
            await page.evaluate(() => {
                return new Promise((resolve) => {
                    if (document.readyState === 'complete') {
                        resolve();
                    } else {
                        window.addEventListener('load', resolve);
                    }
                });
            });

            // Scroll through the page to trigger lazy-loaded images
            await scrollThroughPage(page);
        });

        // Generate a unique filename
        const filename = `${sessionId}.${format}`;
        const screenshotPath = path.join(config.dirs.screenshots, filename);

        // Capture the screenshot
        const screenshotOptions = {
            type: format,
            quality: parseInt(quality),
            fullPage: fullPage // Use the fullPage parameter here
        };
        await page.screenshot(screenshotOptions).then((buffer) => {
            fsPromises.writeFile(screenshotPath, buffer);
        });

        // Generate the response URL
        const screenshotUrl = `${config.server.host}/public/screenshots/${filename}`;

        logger.info('Screenshot creation successful', {
            url: screenshotUrl,
            format,
            quality,
            width,
            height,
            fullPage,
            delay: delayTime,
            sessionId,
            duration: (Date.now() - startTime) / 1000
        });

        res.json({
            success: true,
            url: screenshotUrl,
            message: 'Screenshot created successfully'
        });
    } catch (error) {
        const errorDuration = (Date.now() - startTime) / 1000;
        logger.error('Error creating screenshot', {
            error,
            correlationId: req.correlationId,
            sessionId,
            duration: errorDuration
        });
        res.status(500).json({
            error: 'Failed to create screenshot',
            details: error.message
        });
    } finally {
        // Cleanup
        if (page) {
            try {
                await page.close();
            } catch (e) {
                logger.error('Error closing page', e, { sessionId });
            }
        }

        if (browser) {
            try {
                await browser.close();
                activeBrowsers.delete(browser);
            } catch (e) {
                logger.error('Error closing browser', e, { sessionId });
            }
        }

        logger.info('Cleanup completed', {
            sessionId,
            totalDuration: (Date.now() - startTime) / 1000
        });
    }
});

// Periodic cleanup functions
setInterval(async () => {
    if(activeBrowsers.size > config.browser.maxInstances) {
        logger.info('Too many browser instances, cleaning up...');
        await cleanupBrowsers();
    }
}, 60000);

setInterval(async () => {
    try {
        const zombieCount = parseInt(execSync('ps -A -ostat,ppid | grep -c -e "[zZ]"').toString());
        if(zombieCount > 10) {
            logger.info(`Detected ${zombieCount} zombie processes, cleaning up...`);
            await cleanupBrowsers();
        }
    } catch(error) {
        logger.error('Error checking zombie processes', error);
    }
}, 300000);

setInterval(checkMemoryUsage, 60000);

// Cleanup old files
setInterval(async () => {
    try {
        const now = Date.now();
        const gifsDir = path.join(__dirname, config.dirs.gifs);
        const files = await fsPromises.readdir(gifsDir);
        for(const file of files) {
            const filePath = path.join(gifsDir, file);
            const stats = await fsPromises.stat(filePath);
            if(now - stats.mtimeMs > config.cleanup.fileAge) {
                await safeDeleteFile(filePath);
            }
        }
    } catch(error) {
        logger.error('Error cleaning up old files', error);
    }
}, config.cleanup.interval);

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    server.close(async () => {
        logger.info('HTTP server closed');
        await cleanupBrowsers();

        // Add extra cleanup for any remaining processes
        try {
            execSync('pkill -f "(chrome|chromium)"');
            execSync('kill -9 $(ps -A -ostat,ppid | grep -e "[zZ]" | awk "{print $2}")');
        } catch(error) {
            logger.error('Final cleanup error', error);
        }

        logger.info('Cleanup complete');
        process.exit(0);
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.info('Forcing shutdown after timeout');
        try {
            execSync('pkill -f "(chrome|chromium)"');
        } catch(error) {
            logger.error('Force cleanup error', error);
        }
        process.exit(1);
    }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// Helper to check if file should be skipped
const shouldSkipFile = (filename) => {
    // Skip dot files and system files
    const skipPatterns = [
        /^\./,              // dot files (.gitignore, .DS_Store, etc)
        /^thumbs\.db$/i,    // Windows thumbnail cache
        /^desktop\.ini$/i,  // Windows folder settings
        /^~\$/             // Office temp files
    ];

    return skipPatterns.some(pattern => pattern.test(filename));
};
// File cleanup utility
const cleanupOldFiles = async () => {
    const now = Date.now();
    const maxAge = config.cleanup.fileAge; // 24 hours in milliseconds

    try {
        // Clean screenshots
        const screenshotsDir = path.join(__dirname, config.dirs.screenshots);
        const screenshotFiles = await fsPromises.readdir(screenshotsDir);

        for (const file of screenshotFiles) {
            // Skip system and hidden files
            if (shouldSkipFile(file)) {
                continue;
            }

            try {
                const filePath = path.join(screenshotsDir, file);
                const stats = await fsPromises.stat(filePath);

                if (now - stats.mtimeMs > maxAge) {
                    await fsPromises.unlink(filePath);
                    logger.info('Cleaned up old screenshot', {
                        file,
                        age: `${((now - stats.mtimeMs) / (1000 * 60 * 60)).toFixed(1)} hours`
                    });
                }
            } catch (error) {
                logger.error('Error cleaning up screenshot', { file, error: error.message });
            }
        }

        // Clean gifs
        const gifsDir = path.join(__dirname, config.dirs.gifs);
        const gifFiles = await fsPromises.readdir(gifsDir);

        for (const file of gifFiles) {
            if (shouldSkipFile(file)) {
                continue;
            }

            try {
                const filePath = path.join(gifsDir, file);
                const stats = await fsPromises.stat(filePath);

                if (now - stats.mtimeMs > maxAge) {
                    await fsPromises.unlink(filePath);
                    logger.info('Cleaned up old gif', {
                        file,
                        age: `${((now - stats.mtimeMs) / (1000 * 60 * 60)).toFixed(1)} hours`
                    });
                }
            } catch (error) {
                logger.error('Error cleaning up gif', { file, error: error.message });
            }
        }

        // Clean temp directory
        const tempDir = path.join(__dirname, 'temp');
        const tempFiles = await fsPromises.readdir(tempDir);

        for (const file of tempFiles) {
            if (shouldSkipFile(file)) {
                continue;
            }

            try {
                const filePath = path.join(tempDir, file);
                const stats = await fsPromises.stat(filePath);

                if (now - stats.mtimeMs > maxAge) {
                    await fsPromises.rm(filePath, { recursive: true, force: true });
                    logger.info('Cleaned up temp directory', {
                        file,
                        age: `${((now - stats.mtimeMs) / (1000 * 60 * 60)).toFixed(1)} hours`
                    });
                }
            } catch (error) {
                logger.error('Error cleaning temp directory', { file, error: error.message });
            }
        }

        logger.info('Cleanup completed successfully');

    } catch (error) {
        logger.error('Error during cleanup', { error: error.message });
    }
};

// Set up cleanup interval
const setupCleanupTask = () => {
    // Run cleanup every hour
    setInterval(cleanupOldFiles, config.cleanup.interval);

    // Run cleanup on startup
    cleanupOldFiles().catch(error => {
        logger.error('Initial cleanup failed', { error: error.message });
    });
};
// Initialize and start server
const startServer = async () => {
    try {
        // Initialize directories
        await initializeDirectories();

        try {
            // Set up cleanup task
            setupCleanupTask();
        } catch (error) {
            logger.error('Error setting up cleanup task', error);
        }
        // Initial cleanup
        try {
            await killChromiumProcesses();
            // Wait a moment for processes to fully terminate
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch(error) {
            logger.error('Initial cleanup error', error);
        }

        // Start the server
        const server = app.listen(config.server.port, () => {
            logger.info('Server started', {
                host: config.server.host,
                port: config.server.port,
                environment: process.env.NODE_ENV,
                maxBrowserInstances: config.browser.maxInstances,
                viewport: `${config.viewport.width}x${config.viewport.height}`
            });
        });

        // Setup global error handlers
        setupProcessErrorHandlers();  // Add this line here

        // Handle server errors
        server.on('error', (error) => {
            logger.error('Server error', error);
            process.exit(1);
        });

        return server;
    } catch(error) {
        logger.error('Failed to start server', error);
        process.exit(1);
    }
};

// Start the server
(async () => {
    try {
        const server = await startServer();
    } catch(error) {
        logger.error('Fatal error during startup', error);
        process.exit(1);
    }
})();