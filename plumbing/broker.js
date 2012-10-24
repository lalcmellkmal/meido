var assets = require('./assets'),
    config = require('./config'),
    connect = require('connect'),
    fs = require('fs'),
    persona = require('./persona'),
    util = require('util');

var CLIENTS = {}, USERS = {};

/* PUBSUB */

function redisClient() {
    return require('redis').createClient(config.REDIS_PORT);
}

var r = redisClient(), SUB_REDIS = redisClient();
persona.setRedis(r);

function emitToGame(msg) {
    r.publish(brokerChannel, JSON.stringify(msg));
}
var brokerChannel = config.REDIS_CHANNEL + ':broker';

function subscribe() {
    SUB_REDIS.subscribe(config.REDIS_CHANNEL);
    SUB_REDIS.on('message', onSubMessage);
}

function onSubMessage(channel, msg) {
    try {
        msg = JSON.parse(msg);
    }
    catch (e) {
        console.error("Couldn't parse incoming message:", msg);
        console.error(e);
        return;
    }
    var payload = msg.o;
    if (!payload)
        return console.error('Has no payload:', msg);

    if (msg.c) {
        var client = CLIENTS[msg.c];
        if (client)
            client.send(payload);
    }
    else if (msg.u) {
        var clients = USERS[msg.u];
        if (clients) {
            var flat = JSON.stringify(payload);
            if (config.DEBUG)
                console.log('> ' + flat);
            for (var i = 0; i < clients.length; i++)
                clients[i].sendRaw(flat);
        }
    }
    else if (msg.a == 'broadcast') {
        var flat = JSON.stringify(payload);
        if (config.DEBUG) {
            if (payload.a == 'upgrade')
                console.log('> Broadcast upgrade.');
            else
                console.log('> ' + flat);
        }
        for (var id in CLIENTS) {
            var client = CLIENTS[id];
            if (client.state == 'loggedIn')
                CLIENTS[id].sendRaw(flat);
        }
    }
    else if (msg.a == 'newServer') {
        console.log('Syncing new game server', payload.pid);
        emitToGame({a: 'userList', users: Object.keys(USERS)});
    }
    else
        console.warn("Ignoring sub message", msg);
}

/* WEBSERVER */

function startServer() {
    var app = connect.createServer();
    app.use(assets.serveAssets);
    app.use(connect.static(__dirname + '/../www', {maxAge: 30*24*60*60*1000}));
    app.on('upgrade', function (req, resp) {
        resp.end();
    });

    // Dumb workaround for sockjs-connect incompatibility
    var http = require('http').createServer(app);
    var sockJs = require('sockjs').createServer();
    sockJs.on('connection', onConnection);
    sockJs.installHandlers(http, {
        sockjs_url: config.SOCKJS_SCRIPT_URL,
        prefix: config.SOCKJS_PREFIX,
        jsessionid: false,
        log: sockJsLog,
    });
    http.listen(config.LISTEN_PORT);
}

function onConnection(conn) {
    var ip = conn.remoteAddress;
    if (config.TRUST_X_FORWARDED_FOR) {
        var ff = parseForwardedFor(conn.headers['x-forwarded-for']);
        if (ff)
            ip = ff;
    }
    var client = new Client(conn, ip);
    CLIENTS[client.id] = client;
    conn.on('data', client.onMessage.bind(client));
    conn.once('close', client.onDisconnect.bind(client));
}

function parseForwardedFor(ff) {
    if (!ff)
        return null;
    if (ff.indexOf(',') >= 0)
        ff = ff.split(',', 1)[0];
    return ff.trim();
}

function sockJsLog(sev, msg) {
    if (sev != 'debug' && sev != 'info')
        console.error(msg);
    else if (config.DEBUG)
        console.log(msg);
}

/* CLIENTS */

var CLIENT_COUNT = 0;

function Client(sock, ip) {
    this.sock = sock;
    this.ip = ip;
    this.id = ++CLIENT_COUNT;
    this.state = 'new';
    this.buffer = [];
}

var C = Client.prototype;

C.onMessage = function (data) {
    var msg;
    try {
        msg = JSON.parse(data);
    }
    catch (e) {
        return this.drop('Bad JSON.');
    }
    if (config.DEBUG && this.state != 'needLogin')
        console.log('< ' + data);
    if (!msg || typeof msg != 'object' || !msg.a)
        return this.drop('No type.');

    if (this.state == 'loggedIn')
        emitToGame({u: this.userId, o: msg});
    else if (this.state == 'new')
        this.getSession(msg);
    else if (this.state == 'needLogin')
        this.checkLogin(msg);
    else
        console.warn("Ignoring message", msg, "while", this.state);
};

C.onDisconnect = function () {
    if (this.state == 'loggedIn')
        this.unlinkSession();

    this.sock.removeAllListeners();
    this.state = 'dropped';
    delete CLIENTS[this.id];
};

C.sendStatus = function (msg) {
    this.send({a: 'set', t: 'system', status: msg});
};

C.send = function (msg) {
    var flat = JSON.stringify(msg);
    if (config.DEBUG)
        console.log('> ' + flat);
    this.sendRaw(flat);
};

C.sendRaw = function (flat) {
    this.buffer.push(flat);
    if (!this.flushTimer)
        this.flushTimer = setTimeout(this.flush.bind(this), 0);
};

C.flush = function () {
    this.sock.write('[' + this.buffer.join(',') + ']');
    this.buffer = [];
    this.flushTimer = 0;
};

C.drop = function (reason) {
    console.error(this.ip + ' error: ' + util.inspect(reason));
    if (typeof reason == 'string')
        this.sendStatus({error: reason});
    this.sock.destroySoon();
    this.state = 'dropped';
};

/* LOGIN */

C.getSession = function (msg) {
    if (msg.a != 'session')
        return this.drop('Must send session first.');

    this.state = 'gettingSession';
    var self = this;
    persona.loadSession(msg.session, function (err, userId) {
        if (self.state != 'gettingSession')
            return;
        if (err)
            return self.drop(err);

        if (userId)
            return self.linkSession(userId);
        self.state = 'needLogin';
        self.sessionKey = msg.session;
        self.send({
            a: 'set', t: 'system', requestLogin: true,
            status: 'Persona required.'
        });
    });
};

C.checkLogin = function (msg) {
    if (msg.a != 'login' || typeof msg.assertion != 'string')
        return console.warn("Client needs to log in; bad", msg);

    var self = this;
    persona.verifyAssertion(msg.assertion, function (err, userId) {
        if (self.state != 'needLogin')
            return;
        if (err) {
            console.error(err);
            return self.drop("Couldn't login.");
        }

        persona.saveSession(self.sessionKey, userId, function (err) {
            if (self.state != 'needLogin')
                return;
            if (err) {
                console.error(err);
                return self.drop("Couldn't create login session.");
            }
            self.linkSession(userId);
            self.sessionKey = null;
        });
    });
};

C.linkSession = function (userId) {
    this.state = 'loggedIn';
    this.userId = userId;
    var sessionList = USERS[userId];
    if (!sessionList) {
        emitToGame({a: 'new', u: userId});
        sessionList = USERS[userId] = [];
    }

    sessionList.push(this);
    emitToGame({a: 'session', c: this.id, u: userId});
    this.send({a: 'set', t: 'system', requestLogin: false});
};

C.unlinkSession = function () {
    var userId = this.userId;
    this.userId = null;
    var sessionList = USERS[userId];
    if (!sessionList)
        return console.error("Missing session list?!");
    var i = sessionList.indexOf(this);
    if (i < 0)
        return console.error("Inconsistent session list?!");
    if (sessionList.length > 1)
        sessionList.splice(i, 1);
    else {
        delete USERS[userId];
        emitToGame({a: 'gone', c: this.id, u: userId});
    }
};

/* ETC */

process.on('SIGHUP', function () {
    assets.upgradeClient(r, function (err) {
        if (err)
            console.error("Error upgrading client:", err);
    });
});

function withPidFile(filename, cb) {
    function cleanup() {
        fs.unlink(filename, function (err) {
            process.exit(0);
        });
    }
    fs.writeFile(filename, ''+process.pid, function (err) {
        if (err) cb(err);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
        cb(null);
    });
}

if (require.main === module) {
    subscribe();
    assets.buildAssets(function (err) {
        if (err) throw err;
        withPidFile(__dirname + '/.broker.pid', function (err) {
            if (err) throw err;
            startServer();
        });
    });
}
