require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const GIFEncoder = require('gifencoder');
const { createCanvas, Image } = require('canvas');
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

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
    }
};

// Parse API keys from environment variable
const API_KEYS = JSON.parse(process.env.API_KEYS || '{}');

const app = express();
const rateLimits = new Map();
let activeBrowsers = new Set();

app.use(express.json());

// Create required directories
const screenshotsDir = path.join(__dirname, config.dirs.screenshots);
const gifsDir = path.join(__dirname, config.dirs.gifs);
fsPromises.mkdir(screenshotsDir, { recursive: true }).catch(console.error);
fsPromises.mkdir(gifsDir, { recursive: true }).catch(console.error);

// Process management functions
const killChromiumProcesses = async () => {
    return new Promise((resolve) => {
        exec('pkill -f chromium', (error) => {
            if (error && error.code !== 1) {
                console.error('Error killing chromium processes:', error);
            }
            resolve();
        });
    });
};

const cleanupBrowsers = async () => {
    try {
        for (const browser of activeBrowsers) {
            await browser.close();
        }
        activeBrowsers.clear();
        await killChromiumProcesses();
    } catch (error) {
        console.error('Error cleaning up browsers:', error);
    }
};

// Periodic cleanup
setInterval(async () => {
    if (activeBrowsers.size > config.browser.maxInstances) {
        console.log('Too many browser instances, cleaning up...');
        await cleanupBrowsers();
    }
}, 60000);

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

// Browser management
const createBrowserInstance = async () => {
    if (activeBrowsers.size >= config.browser.maxInstances) {
        throw new Error('Maximum browser instances reached');
    }

    const browser = await puppeteer.launch({
        headless: process.env.PUPPETEER_HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-ipc-flooding-protection',
            `--window-size=${config.viewport.width},${config.viewport.height}`,
            '--no-zygote',
            '--single-process'
        ]
    });

    activeBrowsers.add(browser);

    // Auto-close browser after timeout
    setTimeout(async () => {
        if (activeBrowsers.has(browser)) {
            try {
                await browser.close();
                activeBrowsers.delete(browser);
            } catch (error) {
                console.error('Error auto-closing browser:', error);
            }
        }
    }, config.browser.timeout);

    return browser;
};

// [Previous helper functions remain the same]
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const generateUniqueFilename = () => crypto.randomBytes(16).toString('hex') + '.gif';
const fileExists = async (filePath) => {
    try {
        await fsPromises.access(filePath);
        return true;
    } catch {
        return false;
    }
};
const safeDeleteFile = async (filePath) => {
    try {
        if (await fileExists(filePath)) {
            await fsPromises.unlink(filePath);
            return true;
        }
    } catch (error) {
        console.error(`Error deleting file ${filePath}:`, error.message);
    }
    return false;
};

// Rate limiting functions [remain the same]
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

// Middleware [remains the same]
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;

    if (!apiKey) {
        return res.status(401).json({ error: 'API key is required' });
    }

    if (!API_KEYS[apiKey]) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

    if (isRateLimitExceeded(apiKey)) {
        return res.status(429).json({
            error: 'Rate limit exceeded',
            limit: API_KEYS[apiKey].rateLimit,
            reset: getNextResetTime()
        });
    }

    incrementRateLimit(apiKey);
    next();
};

// Apply API key validation
app.use('/public', validateApiKey, express.static('public'));
app.use(validateApiKey);

// Create GIF endpoint
app.post('/create-gif', async (req, res) => {
    const { url, duration = config.screenshot.defaultDuration } = req.body;
    const fps = 1 / config.screenshot.delay;

    let browser = null;
    let page = null;
    const screenshotFiles = new Set();
    let outputPath = null;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        if (activeBrowsers.size >= config.browser.maxInstances) {
            await cleanupBrowsers();
        }

        browser = await createBrowserInstance();
        page = await browser.newPage();

        await page.setViewport({
            width: config.viewport.width,
            height: config.viewport.height
        });

        await page.goto(url, {
            waitUntil: ['networkidle0', 'domcontentloaded'],
            timeout: 30000
        });

        await delay(2000);

        const totalFrames = Math.ceil(duration * fps);
        const delayMs = 1000 / fps;

        const screenshots = [];
        for (let i = 0; i < totalFrames; i++) {
            const screenshotPath = path.join(screenshotsDir, `screenshot_${i}.png`);
            try {
                await page.screenshot({
                    path: screenshotPath,
                    type: 'png',
                    fullPage: false
                });
                screenshotFiles.add(screenshotPath);
                screenshots.push(screenshotPath);
            } catch (error) {
                console.error(`Error taking screenshot ${i}:`, error);
            }
            await delay(delayMs);
        }

        await page.close();
        await browser.close();
        activeBrowsers.delete(browser);
        page = null;
        browser = null;

        if (screenshots.length === 0) {
            throw new Error('No screenshots were captured');
        }

        const gifFilename = generateUniqueFilename();
        outputPath = path.join(gifsDir, gifFilename);

        const encoder = new GIFEncoder(config.viewport.width, config.viewport.height);
        const canvas = createCanvas(config.viewport.width, config.viewport.height);
        const ctx = canvas.getContext('2d');

        const writeStream = fs.createWriteStream(outputPath);

        encoder.createReadStream().pipe(writeStream);
        encoder.start();
        encoder.setFrameRate(fps);
        encoder.setQuality(config.gif.quality);

        for (const screenshot of screenshots) {
            if (await fileExists(screenshot)) {
                const img = new Image();
                const imgBuffer = await fsPromises.readFile(screenshot);
                img.src = imgBuffer;
                ctx.drawImage(img, 0, 0);
                encoder.addFrame(ctx);
                await safeDeleteFile(screenshot);
                screenshotFiles.delete(screenshot);
            }
        }

        encoder.finish();

        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        const gifUrl = `http://${config.server.host}:${config.server.port}/public/gifs/${gifFilename}`;

        res.json({
            success: true,
            url: gifUrl,
            message: 'GIF created successfully'
        });

    } catch (error) {
        console.error('Error:', error);
        if (outputPath && await fileExists(outputPath)) {
            await safeDeleteFile(outputPath);
        }
        res.status(500).json({
            error: 'Failed to create GIF',
            details: error.message
        });
    } finally {
        try {
            if (page) await page.close();
            if (browser) {
                await browser.close();
                activeBrowsers.delete(browser);
            }

            for (const file of screenshotFiles) {
                await safeDeleteFile(file);
            }
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
});

app.post('/create-video', async (req, res) => {
    const { url, duration = config.screenshot.defaultDuration, format = 'gif' } = req.body;

    let browser = null;
    let page = null;
    let client = null;
    let outputPath = null;
    const sessionId = crypto.randomBytes(16).toString('hex');

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        if (activeBrowsers.size >= config.browser.maxInstances) {
            await cleanupBrowsers();
        }

        browser = await createBrowserInstance();
        page = await browser.newPage();

        // Get CDP session
        client = await page.createCDPSession();

        await page.setViewport({
            width: config.viewport.width,
            height: config.viewport.height
        });

        await page.goto(url, {
            waitUntil: ['networkidle0', 'domcontentloaded'],
            timeout: 30000
        });

        await delay(2000);

        // Create temporary directory for this session
        const sessionDir = path.join(__dirname, 'temp', sessionId);
        await fsPromises.mkdir(sessionDir, { recursive: true });

        // Calculate frame capture parameters
        const maxDuration = Math.min(duration, config.screenshot.defaultDuration);
        const fps = 10; // Set a fixed frame rate for smoother capture
        const totalFrames = Math.ceil(maxDuration * fps);
        const captureInterval = 1000 / fps;

        console.log(`Starting capture: ${totalFrames} frames over ${maxDuration} seconds at ${fps} fps`);

        // Start recording using CDP
        const frames = [];
        let frameCount = 0;
        let isCapturing = true;

        await client.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 70,
            maxWidth: config.viewport.width,
            maxHeight: config.viewport.height,
            everyNthFrame: 1
        });

        const framePromise = new Promise((resolve, reject) => {
            const frameHandler = async (frame) => {
                if (!isCapturing) return;

                frames.push(frame.data);
                frameCount++;

                await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });

                console.log(`Captured frame ${frameCount}/${totalFrames}`);

                if (frameCount >= totalFrames) {
                    isCapturing = false;
                    client.off('Page.screencastFrame', frameHandler);
                    resolve();
                }
            };

            client.on('Page.screencastFrame', frameHandler);
        });

        // Set a timeout for the maximum duration
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                isCapturing = false;
                resolve();
            }, maxDuration * 1000);
        });

        // Wait for either frame capture completion or timeout
        await Promise.race([framePromise, timeoutPromise]);

        // Stop the screencast
        await client.send('Page.stopScreencast');

        // Stop recording
        await client.send('Page.stopScreencast');

        // Generate unique filename
        const outputFilename = `${sessionId}.${format}`;
        outputPath = path.join(__dirname, config.dirs.gifs, outputFilename);

        // Write frames to temporary files
        for (let i = 0; i < frames.length; i++) {
            const framePath = path.join(sessionDir, `frame_${i.toString().padStart(6, '0')}.jpg`);
            await fsPromises.writeFile(framePath, frames[i], 'base64');
        }

        // Use FFmpeg to create video
        await new Promise((resolve, reject) => {
            const width = Math.min(config.viewport.width, 800);
            const ffmpegCommand = format === 'gif'
                ? `ffmpeg -framerate ${fps} -i ${sessionDir}/frame_%06d.jpg -vf "fps=${fps},scale=${width}:-1:flags=lanczos,crop=iw-mod(iw\\,2):ih-mod(ih\\,2),split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -f gif ${outputPath}`
                : `ffmpeg -framerate ${fps} -i ${sessionDir}/frame_%06d.jpg -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart ${outputPath}`;

            exec(ffmpegCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error('FFmpeg error:', stderr);
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        // Clean up temporary directory
        await fsPromises.rm(sessionDir, { recursive: true, force: true });

        const videoUrl = `http://${config.server.host}:${config.server.port}/public/gifs/${outputFilename}`;

        res.json({
            success: true,
            url: videoUrl,
            message: `${format.toUpperCase()} created successfully`
        });

    } catch (error) {
        console.error('Error:', error);
        if (outputPath && await fileExists(outputPath)) {
            await safeDeleteFile(outputPath);
        }
        res.status(500).json({
            error: `Failed to create ${format.toUpperCase()}`,
            details: error.message
        });
    } finally {
        try {
            // First detach CDP session if it exists
            if (client) {
                try {
                    await client.detach().catch(() => {});
                } catch (e) {
                    // Ignore detachment errors
                }
            }

            // Then close the page
            if (page) {
                try {
                    await page.close().catch(() => {});
                } catch (e) {
                    console.error('Error closing page:', e);
                }
            }

            // Finally close the browser
            if (browser) {
                try {
                    await browser.close().catch(() => {});
                activeBrowsers.delete(browser);
                } catch (e) {
                    console.error('Error closing browser:', e);
                }
            }
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
});

// Start server
const server = app.listen(config.server.port, () => {
    console.log(`Server running at http://${config.server.host}:${config.server.port}`);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    console.log(`${signal} received. Starting graceful shutdown...`);

    server.close(async () => {
        console.log('HTTP server closed');
        await cleanupBrowsers();
        console.log('Browsers cleaned up');
        process.exit(0);
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
        console.log('Forcing shutdown after timeout');
        process.exit(1);
    }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));