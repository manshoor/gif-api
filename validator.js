const {URL} = require('url');
const fs    = require("fs");

function getInt(str) {
    return /[0-9]+/.test(str) ? parseInt(str) : undefined;
}

function getUrlFromPath(str) {
    let url = str.slice(1);
    if(!url.startsWith('http')) {
        return 'https://' + url;
    }
    return url;
}

function isValidUrl(str) {
    try {
        const url = new URL(str);
        return url.hostname.includes('.');
    } catch(e) {
        console.error(e.message);
        return false;
    }
}

function fileExists(path) {
    return fs.existsSync(`./tmp/${path}.jpeg`);
}

function isValidURLV2(url) {
    const regex =
              /(http|https):\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/;
    return regex.test(url);
}

module.exports = {getInt, getUrlFromPath, isValidUrl, fileExists, isValidURLV2};
