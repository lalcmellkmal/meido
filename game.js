var common = require('./common'),
    config = require('./plumbing/config'),
    events = require('events');

function redisClient() {
    return require('redis').createClient(config.REDIS_PORT);
}

var r = redisClient();

var DISPATCH = {}, USERS = {};

var userEmitter = new events.EventEmitter;

/* COMMS */

function emit(type, target, msg, m) {
    msg.a = type;
    msg.t = target;
    msg = JSON.stringify({a: 'broadcast', o: msg});
    (m || r).publish(config.REDIS_CHANNEL, msg);
}

function emitTo(user, type, target, msg, m) {
    msg.a = type;
    msg.t = target;
    msg = JSON.stringify({u: user, o: msg});
    (m || r).publish(config.REDIS_CHANNEL, msg);
}

function emitToSession(sessionId, type, target, msg, m) {
    msg.a = type;
    msg.t = target;
    msg = JSON.stringify({c: sessionId, o: msg});
    (m || r).publish(config.REDIS_CHANNEL, msg);
}

function emitStatus(user, msg) {
    emitTo(user, 'set', 'system', {status: msg});
}

function emitError(user, error) {
    emitTo(user, 'set', 'system', {status: {error: error}});
}

function subscribeToBroker() {
    var sub = redisClient();
    sub.subscribe(config.REDIS_CHANNEL + ':broker');
    sub.once('subscribe', function () {
        var msg = {a: 'newServer', o: {pid: process.pid}};
        r.publish(config.REDIS_CHANNEL, JSON.stringify(msg));
    });
    sub.on('message', onBrokerMessage);
}

function onBrokerMessage(channel, msg) {
    msg = JSON.parse(msg);
    var user = msg.u;
    if (!msg.a) {
        var obj = msg.o, action = obj.a;
        if (typeof action != 'string')
            return console.error("Bad message from", user); // kick?

        if (config.DEBUG)
            console.log("> " + JSON.stringify(obj));
        var func = DISPATCH[action];
        if (!func)
            return console.warn("Unknown message type", action, "from", user);
        var timeout = setTimeout(brokerTimeout.bind(null, action), 3000);
        func(user, obj, brokerReturn.bind(null, user, timeout));
    }
    else if (msg.a == 'new') {
        console.log('Added user #' + user);
        USERS[user] = true;
        userEmitter.emit('new', user);
    }
    else if (msg.a == 'session')
        userEmitter.emit('session', msg.c, user);
    else if (msg.a == 'gone') {
        console.log('Dropped #' + user);
        delete USERS[user];
        userEmitter.emit('gone', user);
    }
    else if (msg.a == 'userList') {
        USERS = {};
        msg.users.forEach(function (id) {
            USERS[id] = true;
        });
    }
    else
        console.warn("Unrecognized", msg);
}

function brokerReturn(user, timeout, err) {
    clearTimeout(timeout);
    if (err)
        console.error('Error', err, 'due to message by', user);
}

function brokerTimeout(a) {
    console.error("Handler for " + a + " timed out.");
}

userEmitter.on('session', function (session, userId) {
    r.hgetall('rpg:user:'+userId, function (err, user) {
        if (err)
            throw err;
        else if (!user)
            return console.error("No user info?!");
        emitToSession(session, 'set', 'system', {
            status: 'Logged in as ' + user.name + '.',
        });
    });
});

/* SOCIAL */

function gameLog(user, msg, cb) {
    msg = {msg: msg, who: user, when: new Date().getTime()};
    r.rpush('rpg:chat', JSON.stringify(msg), function (err, len) {
        if (err)
            return cb ? cb(err) : console.error(err);
        msg.id = len;
        emit('add', 'log', {obj: msg});
        cb && cb(null);
    });
}

function sendChatHistory(session) {
    r.lrange('rpg:chat', -common.CLIENT_CHAT_LENGTH, -1, function (err, chat) {
        if (err) throw err;
        emitToSession(session, 'reset', 'log', {objs: chat.map(JSON.parse)});
    });
}
userEmitter.on('session', sendChatHistory);

var chatId = 0;
DISPATCH.chat = function (userId, msg, cb) {
    if (typeof msg.text != 'string')
        return cb("Bad chat message");
    var text = msg.text.trim();
    if (!text)
        return cb("Empty chat message");
    if (text == 'die')
        throw new Error("AAAAAAH");
    r.hget('rpg:user:' + userId, 'name', function (err, name) {
        if (err)
            return cb(err);
        gameLog(name, text, cb);
    });
};

/* STUPID WASTE OF TIME */

function acquireGameLock(attempts, cb) {
    var key = 'lock:game:' + config.REDIS_CHANNEL;
    r.exists(key, function (err, locked) {
        if (err)
            return cb(err);
        if (locked)
            return retry();
        var pid = process.pid;
        r.multi().setnx(key, pid).expire(key, 10).exec(function (err, rs) {
            if (err)
                return cb(err);
            if (!rs[0])
                return retry();
            /* Got lock */
            setInterval(maintainGameLock.bind(null, key), 5000);
            var release = releaseGameLock.bind(null, key, 42);
            process.once('SIGINT', release);
            process.once('SIGTERM', release);
            process.once('uncaughtException', onException.bind(null, key));
            cb(null);
        });
    });
    function retry() {
        if (attempts >= 3) {
            r.get(key, function (err, pid) {
                if (err) return cb(err);
                cb(new Error("Game already controlled by " + pid));
            });
            return;
        }
        setTimeout(acquireGameLock.bind(null, attempts+1, cb), 5000);
    }
}

function maintainGameLock(key) {
    r.expire(key, 10, function (err, refreshed) {
        if (err)
            throw err;
        if (!refreshed) {
            console.error("Game lock gone.");
            process.exit(1);
        }
    });
}

function releaseGameLock(key, exitCode) {
    r.del(key, function (err) {
        console.log(err || 'Released game lock.');
        process.exit(exitCode);
    });
}

function onException(key, err) {
    console.error(err.stack);
    releaseGameLock(key, 1);
}

if (require.main === module) {
    process.stdout.write('Acquiring game lock... ');
    acquireGameLock(0, function (err) {
        if (err) throw err;
        console.log('obtained.');
        subscribeToBroker();
    });
}
