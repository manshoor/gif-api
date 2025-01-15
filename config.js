module.exports = {
    REDIS_URL       : process.env.REDIS_URL || "redis",
    REDIS_PORT      : process.env.REDIS_PORT || 6379,
    REDIS_PASSWORD  : process.env.REDIS_PASSWORD || 'XDFdwT7RnMAb',
    REDIS_CACHE_TIME: process.env.REDIS_CACHE_TIME || 60 * 60 * 1000,
    APP_SECRET      : process.env.APP_SECRET || '490c189df546731c24f57d2bc',
    PORT            : process.env.PORT || 3000,
    windowMs        : process.env.RATE_LIMIT_WINDOW_MS || 1 * 60 * 1000, // 1 minute
    RATE_LIMIT      : process.env.RATE_LIMIT_MAX_REQUESTS || 10, // limit each IP to 100 requests per windowMs
    APP_DOMAIN      : process.env.APP_DOMAIN || 'http://localhost:3000',
    timeout:        parseInt(process.env.REQUEST_TIMEOUT) || 180000, // 3 minutes instead of 2

};