// ============================================================
// SUPERPROXY — Proxy Web Gratuit
// ============================================================
// Modes :
//   /surf/URL  → Mode rapide (fetch, 0.5-2s)
//   /full/URL  → Mode complet (Chromium, 3-10s)
//   /img/URL   → Screenshot (Chromium, 3-10s)
//   /          → Page d'accueil
//   /ping      → Health check
// ============================================================

const express = require('express');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const axios = require('axios');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const CHROMIUM = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// ─────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────
const stats = {
    requests: 0,
    fastRequests: 0,
    fullRequests: 0,
    imgRequests: 0,
    errors: 0,
    startTime: Date.now(),
};

// ─────────────────────────────────────────────
// Navigateur persistent (Chromium)
// ─────────────────────────────────────────────
let browser = null;

async function launchBrowser() {
    if (browser) return browser;

    console.log('🚀 Lancement de Chromium...');

    browser = await puppeteer.launch({
        executablePath: CHROMIUM,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--no-first-run',
            '--single-process',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
    });

    browser.on('disconnected', function () {
        console.log('⚠️ Chromium déconnecté, relance...');
        browser = null;
        launchBrowser();
    });

    console.log('✅ Chromium prêt !');
    return browser;
}

// ─────────────────────────────────────────────
// Headers à supprimer
// ─────────────────────────────────────────────
const STRIP_REQ = new Set([
    'host', 'origin', 'referer', 'cookie',
    'x-forwarded-for', 'x-real-ip',
    'cf-connecting-ip', 'cf-ipcountry',
    'accept-encoding', 'connection',
]);

const STRIP_RESP = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'x-content-type-options',
    'strict-transport-security',
    'public-key-pins',
    'expect-ct',
    'feature-policy',
    'permissions-policy',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'transfer-encoding',
    'content-encoding',
    'content-length',
]);

// ─────────────────────────────────────────────
// Axios client persistant
// ─────────────────────────────────────────────
const httpClient = axios.create({
    timeout: 30000,
    maxRedirects: 10,
    validateStatus: function () { return true; },
    responseType: 'arraybuffer',
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
    },
});

// ─────────────────────────────────────────────
// Fonctions de réécriture d'URLs
// ─────────────────────────────────────────────
function proxyUrl(url, baseUrl, prefix) {
    if (!url || typeof url !== 'string') return url;

    url = url.trim();

    if (url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url.startsWith('javascript:') ||
        url.startsWith('mailto:') ||
        url.startsWith('tel:') ||
        url.startsWith('#') ||
        url.startsWith('/surf/') ||
        url.startsWith('/full/') ||
        url.startsWith('/img/')) {
        return url;
    }

    try {
        var resolved = new URL(url, baseUrl).href;
    } catch (e) {
        return url;
    }

    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
        return (prefix || '/surf/') + resolved;
    }

    return url;
}

function rewriteHtml(html, baseUrl, prefix) {
    var pfx = prefix || '/surf/';

    try {
        var $ = cheerio.load(html, {
            decodeEntities: false,
            xmlMode: false,
        });
    } catch (e) {
        return html;
    }

    // Supprimer CSP
    $('meta[http-equiv]').each(function () {
        var he = ($(this).attr('http-equiv') || '').toLowerCase();
        if (he.indexOf('content-security-policy') !== -1) {
            $(this).remove();
        }
    });

    // Supprimer integrity et crossorigin
    $('script, link').each(function () {
        $(this).removeAttr('integrity');
        $(this).removeAttr('crossorigin');
    });

    // Réécrire href
    $('a, link, area, base').each(function () {
        var val = $(this).attr('href');
        if (val) {
            $(this).attr('href', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire src
    $('script, img, iframe, frame, embed, source, input, video, audio, track').each(function () {
        var val = $(this).attr('src');
        if (val) {
            $(this).attr('src', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire action
    $('form').each(function () {
        var val = $(this).attr('action');
        if (val) {
            $(this).attr('action', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire data
    $('object').each(function () {
        var val = $(this).attr('data');
        if (val) {
            $(this).attr('data', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire poster
    $('video').each(function () {
        var val = $(this).attr('poster');
        if (val) {
            $(this).attr('poster', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire background
    $('body, td, th, table').each(function () {
        var val = $(this).attr('background');
        if (val) {
            $(this).attr('background', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire formaction
    $('button, input').each(function () {
        var val = $(this).attr('formaction');
        if (val) {
            $(this).attr('formaction', proxyUrl(val, baseUrl, pfx));
        }
    });

    // Réécrire srcset
    $('img, source').each(function () {
        var srcset = $(this).attr('srcset');
        if (srcset) {
            var parts = srcset.split(',');
            var newParts = parts.map(function (part) {
                var tokens = part.trim().split(/\s+/);
                if (tokens.length > 0) {
                    tokens[0] = proxyUrl(tokens[0], baseUrl, pfx);
                }
                return tokens.join(' ');
            });
            $(this).attr('srcset', newParts.join(', '));
        }
    });

    // Réécrire style=""
    $('[style]').each(function () {
        var style = $(this).attr('style');
        if (style) {
            $(this).attr('style', rewriteCss(style, baseUrl, pfx));
        }
    });

    // Réécrire <style>
    $('style').each(function () {
        var content = $(this).html();
        if (content) {
            $(this).html(rewriteCss(content, baseUrl, pfx));
        }
    });

    // Réécrire meta refresh
    $('meta[http-equiv]').each(function () {
        var he = ($(this).attr('http-equiv') || '').toLowerCase();
        if (he === 'refresh') {
            var content = $(this).attr('content') || '';
            var match = content.match(/url\s*=\s*(.+)/i);
            if (match) {
                var oldUrl = match[1].trim().replace(/^['"]|['"]$/g, '');
                var newUrl = proxyUrl(oldUrl, baseUrl, pfx);
                $(this).attr('content',
                    content.substring(0, match.index) + 'url=' + newUrl);
            }
        }
    });

    // Injecter l'intercepteur JavaScript
    var injectorScript = '<script>' +
        INTERCEPTOR_JS
            .replace(/__BASE__/g, baseUrl)
            .replace(/__PFX__/g, pfx) +
        '</script>';

    // Injecter la barre de navigation
    var navbar = NAVBAR_HTML.replace(/__URL__/g, baseUrl);

    if ($('head').length > 0) {
        $('head').prepend(injectorScript);
    } else if ($('html').length > 0) {
        $('html').prepend('<head>' + injectorScript + '</head>');
    } else {
        html = injectorScript + html;
    }

    if ($('body').length > 0) {
        $('body').prepend(navbar);
    }

    return $.html();
}

function rewriteCss(css, baseUrl, prefix) {
    var pfx = prefix || '/surf/';

    // Réécrire url(...)
    css = css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
        function (match, quote, url) {
            var newUrl = proxyUrl(url.trim(), baseUrl, pfx);
            return 'url("' + newUrl + '")';
        }
    );

    // Réécrire @import "..."
    css = css.replace(/@import\s+(['"])([^'"]+)\1/g,
        function (match, quote, url) {
            var newUrl = proxyUrl(url.trim(), baseUrl, pfx);
            return '@import "' + newUrl + '"';
        }
    );

    return css;
}

// ─────────────────────────────────────────────
// JavaScript intercepteur (injecté dans les pages)
// ─────────────────────────────────────────────
var INTERCEPTOR_JS = `
(function(){
    var P='__PFX__';
    var B='__BASE__';

    function px(u){
        if(!u||typeof u!=='string')return u;
        u=u.trim();
        if(u.startsWith('data:')||u.startsWith('blob:')||
           u.startsWith('javascript:')||u.startsWith('mailto:')||
           u.startsWith('#')||u.startsWith(P))return u;
        try{u=new URL(u,B).href;}catch(e){return u;}
        if(u.startsWith('http'))return P+u;
        return u;
    }

    // Intercepter fetch
    var _f=window.fetch;
    window.fetch=function(i,o){
        if(typeof i==='string')i=px(i);
        else if(i&&i.url){try{i=new Request(px(i.url),i);}catch(e){}}
        return _f.call(this,i,o);
    };

    // Intercepter XMLHttpRequest
    var _o=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
        arguments[1]=px(u);
        return _o.apply(this,arguments);
    };

    // Intercepter window.open
    var _w=window.open;
    window.open=function(u){
        if(u)arguments[0]=px(u);
        return _w.apply(this,arguments);
    };

    // Intercepter pushState / replaceState
    var _ps=history.pushState;
    history.pushState=function(s,t,u){
        if(u)arguments[2]=px(u);
        return _ps.apply(this,arguments);
    };
    var _rs=history.replaceState;
    history.replaceState=function(s,t,u){
        if(u)arguments[2]=px(u);
        return _rs.apply(this,arguments);
    };

    // Intercepter Worker
    try{
        var _W=window.Worker;
        window.Worker=function(u,o){return new _W(px(u),o);};
    }catch(e){}

    // Intercepter EventSource
    try{
        var _E=window.EventSource;
        window.EventSource=function(u,o){return new _E(px(u),o);};
    }catch(e){}

    // Intercepter WebSocket
    try{
        var _WS=window.WebSocket;
        window.WebSocket=function(u,p){return new _WS(u,p);};
    }catch(e){}

    // Intercepter setAttribute pour src/href
    var _sa=Element.prototype.setAttribute;
    Element.prototype.setAttribute=function(n,v){
        if((n==='src'||n==='href'||n==='action')&&typeof v==='string'){
            v=px(v);
        }
        return _sa.call(this,n,v);
    };
})();
`;

// ─────────────────────────────────────────────
// Barre de navigation
// ─────────────────────────────────────────────
var NAVBAR_HTML = `
<div id="spbar" style="
    position:fixed;top:0;left:0;right:0;height:42px;
    background:#111827;z-index:2147483647;
    display:flex;align-items:center;padding:0 12px;gap:8px;
    font-family:-apple-system,BlinkMacSystemFont,sans-serif;
    box-shadow:0 2px 8px rgba(0,0,0,0.3);
">
    <a href="/" style="color:white;font-weight:700;font-size:15px;
       text-decoration:none;white-space:nowrap;">⚡ SuperProxy</a>
    <input id="spurl" type="text" value="__URL__" style="
        flex:1;padding:6px 12px;border:1px solid #374151;
        border-radius:8px;background:#1f2937;color:#e5e7eb;
        font-size:13px;font-family:monospace;outline:none;
        min-width:0;
    " onkeydown="if(event.key==='Enter'){var u=this.value;
        if(!u.startsWith('http'))u='https://'+u;
        window.location.href='/surf/'+u;}">
    <button onclick="var u=document.getElementById('spurl').value;
        if(!u.startsWith('http'))u='https://'+u;
        window.location.href='/surf/'+u;" style="
        padding:6px 14px;background:#3b82f6;color:white;border:none;
        border-radius:8px;font-size:13px;cursor:pointer;
        font-weight:500;white-space:nowrap;">Aller</button>
    <button onclick="var u=document.getElementById('spurl').value;
        if(!u.startsWith('http'))u='https://'+u;
        window.location.href='/full/'+u;" style="
        padding:6px 10px;background:#8b5cf6;color:white;border:none;
        border-radius:8px;font-size:12px;cursor:pointer;
        white-space:nowrap;" title="Mode complet (Chromium)">🌐</button>
    <button onclick="window.location.reload();" style="
        padding:6px 10px;background:#374151;color:#9ca3af;border:none;
        border-radius:8px;font-size:13px;cursor:pointer;">↻</button>
    <button onclick="document.getElementById('spbar').remove();
        document.getElementById('spspc').remove();" style="
        padding:6px 8px;background:#374151;color:#9ca3af;border:none;
        border-radius:8px;font-size:13px;cursor:pointer;">✕</button>
</div>
<div id="spspc" style="height:42px;"></div>
`;

// ─────────────────────────────────────────────
// Page d'accueil
// ─────────────────────────────────────────────
var HOMEPAGE = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>SuperProxy</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            background:#fafafa;min-height:100vh;
            display:flex;flex-direction:column;
            align-items:center;justify-content:center;padding:20px;
        }
        .c{width:100%;max-width:600px;text-align:center;}
        h1{font-size:48px;font-weight:800;color:#111827;
           margin-bottom:6px;letter-spacing:-2px;}
        .sub{color:#6b7280;font-size:15px;margin-bottom:32px;}
        .sb{display:flex;gap:8px;margin-bottom:24px;}
        .si{
            flex:1;padding:14px 18px;border:2px solid #e5e7eb;
            border-radius:14px;font-size:16px;outline:none;
            transition:border-color .2s;font-family:monospace;
        }
        .si:focus{border-color:#3b82f6;}
        .go{
            padding:14px 24px;background:#111827;color:white;
            border:none;border-radius:14px;font-size:16px;
            font-weight:600;cursor:pointer;transition:background .15s;
        }
        .go:hover{background:#374151;}
        .modes{
            display:flex;gap:10px;justify-content:center;
            margin-bottom:28px;flex-wrap:wrap;
        }
        .mode{
            padding:10px 18px;background:white;
            border:1px solid #e5e7eb;border-radius:10px;
            text-decoration:none;color:#374151;font-size:13px;
            font-weight:500;transition:all .15s;cursor:pointer;
        }
        .mode:hover{background:#f3f4f6;border-color:#d1d5db;}
        .mode.active{background:#111827;color:white;border-color:#111827;}
        .lk{display:flex;gap:8px;justify-content:center;
            flex-wrap:wrap;margin-bottom:32px;}
        .lk a{
            padding:8px 14px;background:white;
            border:1px solid #e5e7eb;border-radius:8px;
            text-decoration:none;color:#374151;font-size:13px;
            transition:all .15s;
        }
        .lk a:hover{background:#f3f4f6;border-color:#d1d5db;}
        .info{
            display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;
            margin-bottom:28px;
        }
        .info-card{
            background:white;border:1px solid #e5e7eb;
            border-radius:10px;padding:14px;
        }
        .info-card .label{font-size:11px;color:#9ca3af;
            text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;}
        .info-card .val{font-size:20px;font-weight:700;color:#111827;}
        .info-card .sub2{font-size:11px;color:#6b7280;margin-top:2px;}
        .nfo{color:#9ca3af;font-size:12px;line-height:1.8;}
        .nfo code{background:#f3f4f6;padding:1px 5px;
                  border-radius:4px;font-size:11px;}
        @media(max-width:600px){
            h1{font-size:36px;}
            .info{grid-template-columns:1fr;}
            .sb{flex-direction:column;}
        }
    </style>
</head>
<body>
    <div class="c">
        <h1>⚡ SuperProxy</h1>
        <p class="sub">Proxy web gratuit — accédez à n'importe quel site</p>

        <form onsubmit="go(event)">
            <div class="sb">
                <input type="text" class="si" id="u"
                       placeholder="Entrez une URL (ex: google.com)"
                       autofocus>
                <button type="submit" class="go">Aller</button>
            </div>
        </form>

        <div class="modes">
            <span class="mode active" onclick="setMode('surf')" id="m-surf">
                ⚡ Rapide</span>
            <span class="mode" onclick="setMode('full')" id="m-full">
                🌐 Complet</span>
            <span class="mode" onclick="setMode('img')" id="m-img">
                📸 Image</span>
        </div>

        <div class="lk">
            <a href="/surf/https://www.google.com">Google</a>
            <a href="/surf/https://fr.wikipedia.org">Wikipedia</a>
            <a href="/surf/https://www.youtube.com">YouTube</a>
            <a href="/surf/https://github.com">GitHub</a>
            <a href="/surf/https://www.reddit.com">Reddit</a>
            <a href="/surf/https://duckduckgo.com">DuckDuckGo</a>
            <a href="/surf/https://twitter.com">Twitter</a>
        </div>

        <div class="info" id="stats"></div>

        <div class="nfo">
            <b>Modes :</b><br>
            <code>/surf/URL</code> — rapide (0.5-2s)<br>
            <code>/full/URL</code> — complet avec JavaScript (3-10s)<br>
            <code>/img/URL</code> — screenshot (3-10s)<br>
        </div>
    </div>
    <script>
        var mode = 'surf';

        function setMode(m) {
            mode = m;
            document.querySelectorAll('.mode').forEach(function(el) {
                el.classList.remove('active');
            });
            document.getElementById('m-' + m).classList.add('active');
            // Mettre à jour les liens rapides
            document.querySelectorAll('.lk a').forEach(function(a) {
                a.href = a.href.replace(/\\/(surf|full|img)\\//, '/' + m + '/');
            });
        }

        function go(e) {
            e.preventDefault();
            var u = document.getElementById('u').value.trim();
            if (!u) return;
            if (!u.startsWith('http')) u = 'https://' + u;
            window.location.href = '/' + mode + '/' + u;
        }

        fetch('/ping').then(function(r) { return r.json(); })
        .then(function(d) {
            document.getElementById('stats').innerHTML =
                '<div class="info-card">' +
                '  <div class="label">Status</div>' +
                '  <div class="val">🟢</div>' +
                '  <div class="sub2">En ligne</div>' +
                '</div>' +
                '<div class="info-card">' +
                '  <div class="label">Requêtes</div>' +
                '  <div class="val">' + d.requests + '</div>' +
                '  <div class="sub2">total</div>' +
                '</div>' +
                '<div class="info-card">' +
                '  <div class="label">Uptime</div>' +
                '  <div class="val">' + d.uptime + '</div>' +
                '  <div class="sub2">en ligne</div>' +
                '</div>';
        }).catch(function() {});
    </script>
</body>
</html>
`;

// ─────────────────────────────────────────────
// Pages d'erreur
// ─────────────────────────────────────────────
function errorPage(title, message, code) {
    return `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${title}</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:-apple-system,sans-serif;background:#fafafa;
             min-height:100vh;display:flex;align-items:center;
             justify-content:center;padding:20px;}
        .box{max-width:500px;text-align:center;}
        h1{font-size:48px;margin-bottom:12px;}
        h2{color:#374151;margin-bottom:12px;}
        p{color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:20px;}
        a{color:#3b82f6;text-decoration:none;font-weight:500;}
        code{background:#f3f4f6;padding:2px 6px;border-radius:4px;
             font-size:12px;word-break:break-all;}
    </style>
    </head><body>
    <div class="box">
        <h1>${code === 504 ? '⏱️' : code === 502 ? '🔌' : '❌'}</h1>
        <h2>${title}</h2>
        <p>${message}</p>
        <a href="/">← Retour à l'accueil</a>
    </div>
    </body></html>`;
}

// ─────────────────────────────────────────────
// Extraction de l'URL cible
// ─────────────────────────────────────────────
function extractTargetUrl(req, prefix) {
    var fullPath = req.originalUrl;
    var targetUrl = fullPath.replace(new RegExp('^' + prefix), '');

    // Réparer le protocole (Express peut manger un /)
    if (targetUrl.startsWith('https:/') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl.slice(7);
    } else if (targetUrl.startsWith('http:/') && !targetUrl.startsWith('http://')) {
        targetUrl = 'http://' + targetUrl.slice(6);
    } else if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
    }

    return targetUrl;
}

// ─────────────────────────────────────────────
// ROUTE : Page d'accueil
// ─────────────────────────────────────────────
app.get('/', function (req, res) {
    res.type('html').send(HOMEPAGE);
});

// ─────────────────────────────────────────────
// ROUTE : Health check
// ─────────────────────────────────────────────
app.get('/ping', function (req, res) {
    var uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    var h = Math.floor(uptime / 3600);
    var m = Math.floor((uptime % 3600) / 60);

    res.json({
        status: 'ok',
        requests: stats.requests,
        fast: stats.fastRequests,
        full: stats.fullRequests,
        img: stats.imgRequests,
        errors: stats.errors,
        uptime: h + 'h ' + m + 'm',
        browser: browser ? 'running' : 'stopped',
    });
});

// ─────────────────────────────────────────────
// ROUTE : Mode rapide (fetch)
// ─────────────────────────────────────────────
app.all('/surf/*', async function (req, res) {
    stats.requests++;
    stats.fastRequests++;

    var targetUrl = extractTargetUrl(req, '/surf/');

    try {
        var config = {
            method: req.method.toLowerCase(),
            url: targetUrl,
            headers: {},
            maxRedirects: 10,
            timeout: 30000,
            responseType: 'arraybuffer',
            validateStatus: function () { return true; },
        };

        // Passer certains headers
        for (var key in req.headers) {
            if (!STRIP_REQ.has(key.toLowerCase())) {
                config.headers[key] = req.headers[key];
            }
        }

        // Host et Referer du site cible
        try {
            var parsed = new URL(targetUrl);
            config.headers['Host'] = parsed.host;
            config.headers['Referer'] = parsed.origin + '/';
        } catch (e) {}

        // Body pour POST
        if (req.method === 'POST') {
            config.data = req.body;
        }

        var response = await httpClient(config);
        var ct = response.headers['content-type'] || '';
        var finalUrl = response.request
            ? (response.request.res
                ? response.request.res.responseUrl
                : targetUrl)
            : targetUrl;

        // Headers de réponse
        var respHeaders = {};
        for (var rkey in response.headers) {
            if (!STRIP_RESP.has(rkey.toLowerCase())) {
                respHeaders[rkey] = response.headers[rkey];
            }
        }

        if (ct.indexOf('text/html') !== -1) {
            var html = Buffer.from(response.data).toString('utf-8');
            html = rewriteHtml(html, finalUrl || targetUrl, '/surf/');
            res.set(respHeaders);
            res.type('html').status(response.status).send(html);
        } else if (ct.indexOf('text/css') !== -1) {
            var css = Buffer.from(response.data).toString('utf-8');
            css = rewriteCss(css, finalUrl || targetUrl, '/surf/');
            res.set(respHeaders);
            res.type('css').status(response.status).send(css);
        } else {
            res.set(respHeaders);
            if (ct) res.type(ct);
            res.status(response.status).send(Buffer.from(response.data));
        }

    } catch (e) {
        stats.errors++;
        var msg = e.message || String(e);

        if (msg.indexOf('timeout') !== -1 || msg.indexOf('ETIMEDOUT') !== -1) {
            res.status(504).type('html').send(
                errorPage('Timeout', 'Le site <code>' + targetUrl +
                    '</code> met trop de temps à répondre.', 504));
        } else if (msg.indexOf('ECONNREFUSED') !== -1 || msg.indexOf('ENOTFOUND') !== -1) {
            res.status(502).type('html').send(
                errorPage('Connexion impossible', 'Impossible de joindre <code>' +
                    targetUrl + '</code>.', 502));
        } else {
            res.status(500).type('html').send(
                errorPage('Erreur', '<code>' + msg + '</code>', 500));
        }
    }
});

// ─────────────────────────────────────────────
// ROUTE : Mode complet (Chromium)
// ─────────────────────────────────────────────
app.get('/full/*', async function (req, res) {
    stats.requests++;
    stats.fullRequests++;

    var targetUrl = extractTargetUrl(req, '/full/');

    try {
        var b = await launchBrowser();
        var page = await b.newPage();

        await page.setViewport({ width: 1280, height: 800 });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/121.0.0.0 Safari/537.36'
        );

        // Bloquer vidéos et polices pour la vitesse
        await page.setRequestInterception(true);
        page.on('request', function (request) {
            var rt = request.resourceType();
            if (rt === 'media' || rt === 'font') {
                request.abort();
            } else {
                request.continue();
            }
        });

        try {
            await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        } catch (navErr) {
            // Timeout : on récupère ce qui a chargé
            if (String(navErr).indexOf('Timeout') === -1) {
                throw navErr;
            }
        }

        // Attendre un peu pour le rendu
        await new Promise(function (r) { setTimeout(r, 1000); });

        var finalUrl = page.url();
        var html = await page.content();

        await page.close();

        html = rewriteHtml(html, finalUrl, '/full/');

        res.type('html').send(html);

    } catch (e) {
        stats.errors++;
        res.status(500).type('html').send(
            errorPage('Erreur', '<code>' + (e.message || String(e)) +
                '</code>', 500));
    }
});

// ─────────────────────────────────────────────
// ROUTE : Mode image (screenshot)
// ─────────────────────────────────────────────
app.get('/img/*', async function (req, res) {
    stats.requests++;
    stats.imgRequests++;

    var targetUrl = extractTargetUrl(req, '/img/');

    try {
        var b = await launchBrowser();
        var page = await b.newPage();

        await page.setViewport({ width: 1280, height: 800 });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/121.0.0.0 Safari/537.36'
        );

        await page.setRequestInterception(true);
        page.on('request', function (request) {
            var rt = request.resourceType();
            if (rt === 'media') {
                request.abort();
            } else {
                request.continue();
            }
        });

        try {
            await page.goto(targetUrl, {
                waitUntil: 'networkidle2',
                timeout: 30000,
            });
        } catch (navErr) {
            if (String(navErr).indexOf('Timeout') === -1) {
                throw navErr;
            }
        }

        await new Promise(function (r) { setTimeout(r, 1500); });

        var screenshot = await page.screenshot({
            type: 'jpeg',
            quality: 80,
            fullPage: false,
        });

        await page.close();

        res.type('jpeg').send(screenshot);

    } catch (e) {
        stats.errors++;
        res.status(500).type('html').send(
            errorPage('Erreur', '<code>' + (e.message || String(e)) +
                '</code>', 500));
    }
});

// ─────────────────────────────────────────────
// Middleware pour parser le body des POST
// ─────────────────────────────────────────────
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
app.listen(PORT, function () {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  ⚡ SuperProxy — En ligne');
    console.log('  📡 Port : ' + PORT);
    console.log('═══════════════════════════════════════');
    console.log('');

    // Lancer Chromium en arrière-plan
    launchBrowser().catch(function (e) {
        console.log('⚠️ Chromium non disponible : ' + e.message);
        console.log('   Le mode rapide (/surf/) fonctionne quand même.');
    });
});
