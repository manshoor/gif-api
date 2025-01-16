require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const GIFEncoder = require('gifencoder');
const {createCanvas, Image} = require('canvas');
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
        width: parseInt(process.env.VIEWPORT_WIDTH) || 2048,
        height: parseInt(process.env.VIEWPORT_HEIGHT) || 1024
    },
    screenshot: {
        delay: parseFloat(process.env.SCREENSHOT_DELAY) || 3.5,
        defaultDuration: parseInt(process.env.DEFAULT_DURATION) || 15
    },
    gif: {
        quality: parseInt(process.env.GIF_QUALITY) || 10
    },
    dirs: {
        screenshots: process.env.SCREENSHOTS_DIR || 'temp_screenshots',
        gifs: process.env.GIFS_DIR || 'public/gifs'
    },
    browser: {
        maxInstances: parseInt(process.env.MAX_BROWSER_INSTANCES) || 3,
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

const generateUniqueFilename = (extension = 'gif') => crypto.randomBytes(16).toString('hex') + '.' + extension;

const generateScreenshotName = (url, index, sessionId) => {
    const urlHash = crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
    return `${urlHash}_${sessionId}_screenshot_${index}.png`;
};

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
        timeout: parseInt(process.env.BROWSER_LAUNCH_TIMEOUT) || 60000,
        pipe: true, // Use pipe instead of WebSocket
        dumpio: true, // Log browser process stdout and stderr
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
app.use(['/create-gif', '/create-video'], validateApiKey);

// Health check endpoint
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeBrowsers: activeBrowsers.size,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
    };
    res.json(health);
});

// Create GIF endpoint
const handleGifCreation = async (req, res) => {
    const {url, duration = config.screenshot.defaultDuration} = req.body;
    const fps = 1 / config.screenshot.delay;
    const sessionId = crypto.randomBytes(8).toString('hex');

    let browser = null;
    let page = null;
    const screenshotFiles = new Set();
    let outputPath = null;

    if(!url || !validateUrl(url)) {
        return res.status(400).json({error: 'Valid URL is required'});
    }

    try {
        if(activeBrowsers.size >= config.browser.maxInstances) {
            await cleanupBrowsers();
        }

        browser = await createBrowserInstance();
        page = await createPageWithTimeout(browser);

        await page.setViewport({
            width: config.viewport.width,
            height: config.viewport.height
            });

        await withRetry(async () => {
            await page.setBypassCSP(true);
            await page.goto(url, {
                waitUntil: ['networkidle0', 'domcontentloaded'],
                timeout: 30000
        });
            await page.evaluate(() => {
                const videos = document.querySelectorAll('video');
                videos.forEach(video => {
                    video.muted = true;
                    video.autoplay = true;
                    video.playsinline = true;

                    // Remove any existing play/pause event listeners
                    const oldElement = video.cloneNode(true);
                    video.parentNode.replaceChild(oldElement, video);
                });
            });
            // Use our custom delay function instead
            await delay(2000);

            // Wait for key elements to be ready
            await page.waitForFunction(() => {
                return document.readyState === 'complete' &&
                    !document.querySelector('.loading') &&
                    performance.now() > 2000;
            }, { timeout: 30000 });
        });

        const screenshots = [];
        const totalFrames = Math.ceil(duration * fps);
        const delayMs = 1000 / fps;

        try {
            for (let i = 0; i < totalFrames; i++) {
                const screenshotName = generateScreenshotName(url, i, sessionId);
                const screenshotPath = path.join(config.dirs.screenshots, screenshotName);

                try {
                    // Wait briefly for any animations to complete
                    await delay(delayMs);

                    // Ensure the page is still valid
                    if (!page.isClosed()) {
                        await page.screenshot({
                            path: screenshotPath,
                            type: 'png',
                            fullPage: false,
                            omitBackground: false
                        });
                        screenshotFiles.add(screenshotPath);
                        screenshots.push(screenshotPath);
                    } else {
                        throw new Error('Page was closed during screenshot process');
                    }
                } catch (error) {
                    logger.error(`Error taking screenshot ${i}`, error, {
                        screenshotName,
                        correlationId: req.correlationId,
                        frameNumber: i,
                        totalFrames
                    });
                    // Continue with next screenshot even if one fails
                }
            }
        } catch (error) {
            logger.error('Error in screenshot loop', error, {
                correlationId: req.correlationId,
                screenshotsCaptures: screenshots.length,
                totalFramesAttempted: totalFrames
            });
            throw error;  // Re-throw to be caught by main error handler
        }
        await page.close();
        await browser.close();
        activeBrowsers.delete(browser);
        page = null;
        browser = null;

        if(screenshots.length === 0) {
            throw new Error('No screenshots were captured');
        }

        const gifFilename = generateUniqueFilename();
        outputPath = path.join(config.dirs.gifs, gifFilename);

        const encoder = new GIFEncoder(config.viewport.width, config.viewport.height);
        const canvas = createCanvas(config.viewport.width, config.viewport.height);
        const ctx = canvas.getContext('2d');

        const writeStream = fs.createWriteStream(outputPath);

        encoder.createReadStream().pipe(writeStream);
        encoder.start();
        encoder.setFrameRate(fps);
        encoder.setQuality(config.gif.quality);

        for(const screenshot of screenshots) {
            if(await fileExists(screenshot)) {
                try {
                    const loadImage = () => new Promise((resolve, reject) => {
                        const img = new Image();
                        img.onload = () => resolve(img);
                        img.onerror = reject;
                        const imgBuffer = fs.readFileSync(screenshot);
                        img.src = imgBuffer;
                    });

                    const img = await loadImage();
                    ctx.clearRect(0, 0, config.viewport.width, config.viewport.height);
                    ctx.drawImage(img, 0, 0);
                    encoder.addFrame(ctx);
                } catch(error) {
                    logger.error(`Error processing frame`, error, {
                        screenshot,
                        correlationId: req.correlationId
                    });
                } finally {
                    try {
                        await safeDeleteFile(screenshot);
                        screenshotFiles.delete(screenshot);
                    } catch(deleteError) {
                        logger.error(`Error deleting screenshot`, deleteError, {
                            screenshot,
                            correlationId: req.correlationId
                        });
                    }
                }
            }
        }

        encoder.finish();

        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        // Wait a brief moment to ensure file system operations are complete
        await delay(100);

        const gifUrl = `${config.server.host}/public/gifs/${gifFilename}`;

        res.json({
            success: true,
            url: gifUrl,
            message: 'GIF created successfully'
        });

    } catch(error) {
        logger.error('Error creating GIF', error, {correlationId: req.correlationId});
        if(outputPath && await fileExists(outputPath)) {
            await safeDeleteFile(outputPath);
        }
        res.status(500).json({
            error: 'Failed to create GIF',
            details: error.message
        });
    } finally {
        try {
            if(page) {
                try {
                    await page.close().catch(() => {
                    });
                } catch(e) {
                    logger.error('Error closing page', e);
                }
            }
            if(browser) {
                try {
                    await browser.close().catch(() => {
                    });
                    activeBrowsers.delete(browser);
                } catch(e) {
                    logger.error('Error closing browser', e);
                }
            }
            for(const file of screenshotFiles) {
                await safeDeleteFile(file).catch(() => {
                });
            }
        } catch(error) {
            logger.error('Cleanup error', error);
        }
    }
};

app.post('/create-gif', async (req, res) => {
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), config.request.timeout);
    });

    try {
        await Promise.race([
            handleGifCreation(req, res),
            timeoutPromise
        ]);
    } catch(error) {
        if(error.message === 'Request timeout') {
            res.status(504).json({error: 'Request timed out'});
        } else {
            res.status(500).json({
                error: 'Failed to create GIF',
                details: error.message
            });
        }
    }
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
                + `-vf "fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];`
                + `[s0]palettegen=max_colors=256:stats_mode=diff[p];`
                + `[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" `
                + `-f gif ${outputPath}`,
            mp4: `ffmpeg -y -framerate ${fps} -i ${sessionDir}/frame_%06d.jpg `
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

            const cleanupDuration = (Date.now() - startTime) / 1000;
            logger.info('Cleanup completed', {
                sessionId,
                totalDuration: cleanupDuration
            });
        } catch(error) {
            logger.error('Error in cleanup', error, {
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

// Initialize and start server
const startServer = async () => {
    try {
        // Initialize directories
        await initializeDirectories();

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