require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {exec, execSync} = require('child_process');
const cors = require('cors');

// Debug logging
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', {
        promise,
        reason: reason instanceof Error ? {
            message: reason.message,
            stack: reason.stack,
            ...reason
        } : reason
    });
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit the process here, just log
});


// Load configuration from environment variables
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        await execSync('pkill -f "chrome_crashpad" || true');
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
        timeout: parseInt(process.env.BROWSER_LAUNCH_TIMEOUT) || 30000,
        pipe: true,
        dumpio: true,
        env: {
            ...process.env,
            DISABLE_CRASHPAD: "true",
            DBUS_SESSION_BUS_ADDRESS: '/dev/null',
            NO_PROXY: 'localhost,127.0.0.1'
        },
        args: [
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-skip-list',
            '--autoplay-policy=user-gesture-required',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-ipc-flooding-protection',
            '--start-maximized', // Start in maximized state
            `--window-size=${config.viewport.width},${config.viewport.height + 120}`,
            '--no-zygote',
            '--single-process',
            '--disable-crashpad',
            '--disable-crash-reporter',
            '--disable-features=CrashpadReporter',
            '--disable-web-security',
            '--disable-features=site-per-process',
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '--no-crash-upload', // Prevent crash reporter
            '--disable-breakpad', // Disable crash reporting
            '--disable-features=CrashpadReporter,CrashReporter',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu-memory-buffer-video-frames',
            //
            '--disable-dbus',
            '--disable-features=VizDisplayCompositor',
            '--disable-features=AudioServiceOutOfProcess',
            '--no-experiments',
            '--mute-audio',
            //
            '--metrics-recording-only',
            '--disable-notifications',
            '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
            '--font-render-hinting=none'
        ]
    });

    // Add error handling for browser disconnection
    browser.on('disconnected', async () => {
        logger.info('Browser disconnected, cleaning up...');
        activeBrowsers.delete(browser);
        logger.info('Browser disconnected, cleaning up resources');
        try {
            await execSync('pkill -f "chrome_crashpad" || true');
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

// Create Video endpoint
app.post('/create-video', async (req, res) => {
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

        // Navigate to URL with retry logic
        await withRetry(async () => {
            await page.goto(url, {
                waitUntil: ['networkidle0', 'domcontentloaded'],
                timeout: 30000
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

        // Write frames to disk
        let writtenFrames = 0;
        await Promise.all(frames.map(async (frameData, index) => {
            const framePath = path.join(sessionDir, `frame_${index.toString().padStart(6, '0')}.jpg`);
            try {
                await fsPromises.writeFile(framePath, frameData, 'base64');
                writtenFrames++;

                if (writtenFrames % 10 === 0) {
                    logger.info('Frame writing progress', {
                        writtenFrames,
                        totalFrames: frames.length,
                        sessionId
                    });
                }
            } catch (error) {
                logger.error('Error writing frame', {
                    frameIndex: index,
                    error,
                    sessionId
                });
                throw error;
            }
        }));

        logger.info('Frame writing complete', {
            writtenFrames,
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

// Navigation helper function
const navigateToPage = async (page, url) => {
    // Setup request interception
    await page.setRequestInterception(true);
    page.removeAllListeners('request');

    // Define blocked resource types
    const blockedResourceTypes = [
        'media', 'websocket', 'manifest', 'other',
        'texttrack', 'object', 'beacon', 'csp_report', 'imageset'
    ];

    // Define blocked URL patterns
    const blockedUrls = [
        'google-analytics', 'googletagmanager', 'doubleclick',
        'facebook', 'hotjar', 'optimizely', 'googleads'
    ];

    page.on('request', request => {
        const resourceType = request.resourceType();
        const url = request.url().toLowerCase();

        // Always allow essential resources
        if (resourceType === 'document' ||
            resourceType === 'stylesheet' ||
            resourceType === 'image' ||
            resourceType === 'script' ||
            resourceType === 'font' ||
            resourceType === 'xhr' ||
            resourceType === 'fetch') {
            request.continue();
            return;
        }

        // Block known analytics and non-essential resources
        if (blockedResourceTypes.includes(resourceType) ||
            blockedUrls.some(pattern => url.includes(pattern))) {
            request.abort();
            return;
        }

        // Handle scripts - allow essential ones
        if (resourceType === 'script') {
            if (url.includes('jquery') || url.includes('cdn') || url.includes(new URL(url).hostname)) {
                request.continue();
            } else {
                request.abort();
            }
            return;
        }

        // Continue by default
        request.continue();
    });

    try {
        // Set navigation timeout
        await page.setDefaultNavigationTimeout(30000);

        // Navigate with optimized settings
        const response = await page.goto(url, {
            waitUntil: ['domcontentloaded', 'networkidle2'],
            timeout: 30000
        });

        if (!response || !response.ok()) {
            throw new Error(`Navigation failed with status: ${response?.status() || 'unknown'}`);
        }

        // Wait for page to stabilize using evaluate
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2000)));

        // Navigation successful
        return response;

    } catch (error) {
        logger.error('Navigation failed', { error: error.message });
        throw error;
    }
};

// Content loading helper function
const waitForContent = async (page) => {
    try {
        // Wait for all images in viewport to load
        await page.evaluate(async () => {
            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

            // Function to scroll and wait
            const scrollAndWait = async () => {
                const scrollHeight = document.documentElement.scrollHeight;
                const viewportHeight = window.innerHeight;
                let lastScroll = window.pageYOffset;

                // Scroll in chunks
                for (let i = 0; i < scrollHeight; i += viewportHeight) {
                    window.scrollTo(0, i);
                    await delay(100);

                    // Check if we've stopped scrolling
                    if (window.pageYOffset === lastScroll) {
                        break;
                    }
                    lastScroll = window.pageYOffset;
                }

                // Return to top
                window.scrollTo(0, 0);
                await delay(500);
            };

            // First scroll pass to trigger lazy loading
            await scrollAndWait();

            // Wait for images to load
            const images = Array.from(document.getElementsByTagName('img'));
            await Promise.all(
                images.map(img => {
                    if (img.complete) return Promise.resolve();
                    return new Promise(resolve => {
                        const loadHandler = () => {
                            img.removeEventListener('load', loadHandler);
                            img.removeEventListener('error', errorHandler);
                            resolve();
                        };
                        const errorHandler = () => {
                            img.removeEventListener('load', loadHandler);
                            img.removeEventListener('error', errorHandler);
                            resolve();
                        };
                        img.addEventListener('load', loadHandler);
                        img.addEventListener('error', errorHandler);
                        // Timeout after 5 seconds
                        setTimeout(resolve, 5000);
                    });
                })
            );

            // Final scroll to ensure everything is loaded
            await scrollAndWait();

            // Final delay for stability
            await delay(1000);
        });

    } catch (error) {
        logger.error('Error waiting for content', { error: error.message });
        // Continue despite errors - we don't want to block the screenshot
    }
};

// Screenshot endpoint
app.post('/create-screenshot', validateApiKey, async (req, res) => {
    const {
        url,
        format = config.screenshot.format.default,
        quality = config.screenshot.quality.default
    } = req.body;
    const sessionId = crypto.randomBytes(16).toString('hex');
    const startTime = Date.now();

    let browser = null;
    let page = null;
    let outputPath = null;

    logger.info('Starting screenshot creation', {
        url,
        format,
        quality,
        sessionId,
        correlationId: req.correlationId
    });

    if (!url || !validateUrl(url)) {
        return res.status(400).json({ error: 'Valid URL is required' });
    }

    // Validate format and quality
    if (!config.screenshot.format.allowed.includes(format)) {
        return res.status(400).json({
            error: 'Invalid format',
            allowed: config.screenshot.format.allowed
        });
    }

    if (quality < config.screenshot.quality.min || quality > config.screenshot.quality.max) {
        return res.status(400).json({
            error: 'Invalid quality value',
            range: `${config.screenshot.quality.min}-${config.screenshot.quality.max}`
        });
    }

    try {
        // Create necessary directories
        await ensureDirectoryExists(path.join(__dirname, config.dirs.screenshots));

        // Initialize browser and page
        browser = await createBrowserInstance();
        activeBrowsers.add(browser);
        page = await browser.newPage();

        // Set initial viewport
        await page.setViewport({
            width: config.screenshot.dimensions.default.width,
            height: config.screenshot.dimensions.default.height,
            deviceScaleFactor: 1
        });

        // Configure request interception
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const url = request.url().toLowerCase();

            // Only allow essential resources
            if (resourceType === 'document' ||
                resourceType === 'stylesheet' ||
                (resourceType === 'image' && request.url().includes(url))) {
                request.continue();
            } else {
                request.abort();
            }

            // if (resourceType === 'image' || resourceType === 'font' || resourceType === 'stylesheet') {
            //     request.continue();
            // } else if (resourceType === 'script') {
            //     if (url.includes('google-analytics') ||
            //         url.includes('googletagmanager') ||
            //         url.includes('tracking')) {
            //         request.abort();
            //     } else {
            //         request.continue();
            //     }
            // } else if (resourceType === 'media' || resourceType === 'websocket') {
            //     request.abort();
            // } else {
            //     request.continue();
            // }
        });

        // Error handling for page events
        page.on('error', error => {
            logger.error('Page error occurred', { error: error.message, sessionId });
        });

        page.on('pageerror', error => {
            logger.error('Page error occurred', { error: error.message, sessionId });
        });

        // Navigate to the URL
        await navigateToPage(page, url);

        // Wait for content and handle lazy loading
        await waitForContent(page);

        // Get page dimensions
        const dimensions = await page.evaluate(() => ({
            width: Math.max(
                document.documentElement.clientWidth,
                document.body ? document.body.scrollWidth : 0,
                document.documentElement.scrollWidth,
                document.documentElement.offsetWidth
            ),
            height: Math.max(
                document.documentElement.clientHeight,
                document.body ? document.body.scrollHeight : 0,
                document.documentElement.scrollHeight,
                document.documentElement.offsetHeight
            )
        }));

        // Update viewport to match content
        await page.setViewport({
            width: Math.min(dimensions.width, config.screenshot.dimensions.max.width),
            height: Math.min(dimensions.height, config.screenshot.dimensions.max.height),
            deviceScaleFactor: 1
        });

        // Wait for layout to stabilize
        await delay(2000);

        // Generate unique filename and path
        const filename = `${sessionId}.${format}`;
        outputPath = path.join(config.dirs.screenshots, filename);

        // Take the screenshot
        const screenshotOptions = {
            path: outputPath,
            fullPage: true,
            type: format,
            quality: format === 'jpeg' ? quality : undefined,
            optimizeForSpeed: true
        };

        await page.screenshot(screenshotOptions);

        // Generate response URL
        const screenshotUrl = `${config.server.host}/public/screenshots/${filename}`;

        logger.info('Screenshot creation successful', {
            url: screenshotUrl,
            format,
            dimensions,
            sessionId,
            duration: (Date.now() - startTime) / 1000
        });

        res.json({
            success: true,
            url: screenshotUrl,
            dimensions: {
                width: dimensions.width,
                height: dimensions.height
            }
        });

    } catch (error) {
        logger.error('Screenshot creation failed', {
            error,
            correlationId: req.correlationId,
            sessionId,
            duration: (Date.now() - startTime) / 1000
        });

        res.status(500).json({
            error: 'Failed to create screenshot',
            details: error.message
        });

    } finally {
        try {
            if (page) {
                await page.close().catch(() => {});
            }
            if (browser) {
                await browser.close().catch(() => {});
                activeBrowsers.delete(browser);
            }
        } catch (error) {
            logger.error('Error in cleanup', {
                error,
                correlationId: req.correlationId,
                sessionId
            });
        }
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