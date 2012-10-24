var _ = require('underscore'),
    config = require('./config'),
    crypto = require('crypto'),
    exec = require('child_process').exec,
    fs = require('fs'),
    urlParse = require('url').parse;

function buildCommsJs(cb) {
    exec('coffee -cp comms.coffee', function (err, commsJs, stderr) {
        if (err) {
            process.stderr.write(stderr);
            return cb(err);
        }
        commsJs = _.template(commsJs)(config);
        fs.writeFile('.comms.js', commsJs, 'utf8', cb);
    });
};

function md5(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
}

var ASSETS = {};

function buildAssets(cb) {
    exec('make packed.js', function (err, stderr) {
        if (err) {
            process.stderr.write(stderr);
            return cb(err);
        }
        fs.readFile('packed.js', function (err, packedJs) {
            if (err) return cb(err);
            var packedJsPath = 'client-' + md5(packedJs).slice(0, 8) + '.js';
            var built = {
                packedJs: packedJs,
                packedJsPath: '/'+packedJsPath,
            };
            fs.readFile('index.html', 'utf8', function (err, html) {
                if (err) return cb(err);
                html = _.template(html)({CLIENT: packedJsPath});
                html = new Buffer(html, 'utf8');
                built.indexHtml = html;
                built.indexHtmlMD5 = '"' + md5(html) + '"';
                ASSETS = built;
                cb(null);
            });
        });
    });
}
exports.buildAssets = buildAssets;

exports.serveAssets = function (req, resp, next) {
    if (req.method != 'GET' && req.method != 'HEAD')
        return next();
    var url = urlParse(req.url, true);
    if (url.pathname == '/') {
        if (req.headers['if-none-match'] == ASSETS.indexHtmlMD5) {
            resp.writeHead(304);
            resp.end();
            return;
        }
        resp.writeHead(200, {
            'Content-Type': 'text/html; charset=UTF-8',
            'Content-Length': ASSETS.indexHtml.length,
            'Cache-Control': 'must-revalidate',
            ETag: ASSETS.indexHtmlMD5,
        });
        resp.end(req.method == 'GET' ? ASSETS.indexHtml : null);
        return;
    }
    else if (url.pathname == ASSETS.packedJsPath) {
        var headers = {
            'Content-Type': 'application/javascript',
            'Content-Length': ASSETS.packedJs.length,
            'Cache-Control': 'max-age=600000'
        };
        if (config.DEBUG)
            headers['Cache-Control'] = 'no-cache';
        resp.writeHead(200, headers);
        resp.end(req.method == 'GET' ? ASSETS.packedJs : null);
        return;
    }
    next();
};

function upgradeClient(r, cb) {
    buildAssets(function (err) {
        if (err)
            return cb(err);
        fs.readFile('client.js', 'UTF-8', function (err, src) {
            if (err)
                return cb(err);
            var msg = {a: 'broadcast', o: {a: 'upgrade', src: src}};
            r.publish(config.REDIS_CHANNEL, JSON.stringify(msg), cb);
        });
    });
}
exports.upgradeClient = upgradeClient;

if (require.main === module) {
    var cmd = process.argv[2];
    if (cmd == '.comms.js') {
        buildCommsJs(function (err) {
            if (err) throw err;
        });
    }
    else
        throw new Error("Don't know option", cmd);
}
