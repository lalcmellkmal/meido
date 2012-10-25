var _ = require('underscore'),
    async = require('async'),
    common = require('./common'),
    config = require('./plumbing/config'),
    events = require('events');

function redisClient() {
    return require('redis').createClient(config.REDIS_PORT);
}

var r = redisClient();

var USERS = {}, TIMEOUTS = {};
var DISPATCH = {}, COMMANDS = {};

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
        var timeout = setTimeout(brokerTimeout.bind(null,user,action), 3000);
        func(user, obj, brokerReturn.bind(null, user, timeout));
    }
    else if (msg.a == 'new')
        onNewUser(user);
    else if (msg.a == 'session')
        userEmitter.emit('session', msg.c, user);
    else if (msg.a == 'gone')
        onUserGone(user);
    else if (msg.a == 'userList')
        refreshUserList(msg.users);
    else
        console.warn("Unrecognized", msg);
}

function brokerReturn(user, timeout, err) {
    clearTimeout(timeout);
    if (err) {
        if (typeof err == 'string')
            logTo(user, err);
        else {
            console.error('Error', err, 'due to message by', user);
            logTo(user, "Something's gone wrong.");
        }
    }
}

function brokerTimeout(user, a) {
    console.error("Handler for " + a + " timed out.");
    if (config.DEBUG)
        logTo(user, "Command timed out.");
}

userEmitter.on('session', function (session, userId) {
    emitToSession(session, 'set', 'system', {status: ''});
});

function onNewUser(userId) {
    USERS[userId] = {id: userId};

    /* clear pending timeout if any */
    var timeout = TIMEOUTS[userId];
    if (timeout) {
        clearTimeout(timeout.handle);
        delete TIMEOUTS[userId];
        console.log('#' + userId + ' found again');
    }
    refreshUser(userId, function (err, user) {
        if (err)
            throw err;
        if (user)
            userEmitter.emit('new', user);
    });
}

var TIMEOUT_CTR = 0;
var TIMEOUT_TIME = 5000;

function onUserGone(userId) {
    console.log('#' + userId + ' lost');
    if (!USERS[userId])
        return;
    /* ctr is to disambiguate overlapping timeouts */
    var timeout = {ctr: ++TIMEOUT_CTR};
    timeout.handle = setTimeout(timeoutUser.bind(null, userId, timeout.ctr),
            TIMEOUT_TIME);
    TIMEOUTS[userId] = timeout;
}

function timeoutUser(userId, timeoutCtr) {
    var timeout = TIMEOUTS[userId];
    if (!timeout || timeout.ctr !== timeoutCtr)
        return;
    delete TIMEOUTS[userId];

    var user = USERS[userId];
    if (!user)
        return;
    console.log('#' + userId + ' gone');
    userEmitter.emit('gone', user);
    delete USERS[userId];
}

function refreshUser(userId, cb) {
    r.hgetall('rpg:user:' + userId, function (err, user) {
        if (err)
            return cb(err);
        if (user && userId in USERS) {
            delete user.email;
            user.id = userId;
            USERS[userId] = user;
        }
        cb(null, USERS[userId]);
    });
}

function refreshUserList(users) {
    var old = {};
    _.extend(old, USERS);

    /* Update USERS immediately */
    var needUpdate = [];
    users.forEach(function (id) {
        if (id in USERS) {
            /* don't need to refresh this user */
            delete old[id];
        }
        else {
            USERS[id] = {id: id};
            needUpdate.push(id);
        }
    });
    var changed = needUpdate.length > 0;
    for (var oldId in old) {
        changed = true;
        delete USERS[oldId];
    }

    /* Fill cache in the background */
    async.forEach(needUpdate, refreshUser, function (err) {
        if (err)
            throw err;
        if (changed)
            emit('reset', 'idCards', _.values(USERS));
    });
}

userEmitter.on('new', function (user) {
    emit('add', 'idCards', {obj: user});
});

userEmitter.on('gone', function (user) {
    emit('remove', 'idCards', {id: user.id});
});

/* SOCIAL */

function gameLog(msg, extra, cb) {
    msg = {msg: msg, when: new Date().getTime()};
    if (extra)
        _.extend(msg, extra);
    r.rpush('rpg:chat', JSON.stringify(msg), function (err, len) {
        if (err)
            return cb ? cb(err) : console.error(err);
        msg.id = len;
        emit('add', 'log', {obj: msg});
        cb && cb(null);
    });
}

function logTo(user, msg, extra) {
    var now = new Date().getTime();
    msg = {msg: msg, when: now, id: 'U'+now};
    if (extra)
        _.extend(msg, extra);
    emitTo(user, 'add', 'log', {obj: msg});
}

function sendChatHistory(session) {
    r.lrange('rpg:chat', -common.CLIENT_CHAT_LENGTH, -1, function (err, chat) {
        if (err) throw err;
        emitToSession(session, 'reset', 'log', {objs: chat.map(JSON.parse)});
    });
}
userEmitter.on('session', sendChatHistory);

function prettyName(user) {
    return {name: user && user.name || '<anon>'};
}

userEmitter.on('new', function (user) {
    gameLog([prettyName(user), " joined."]);
});

userEmitter.on('gone', function (user) {
    gameLog([prettyName(user), " left."]);
});

var chatId = 0;
DISPATCH.chat = function (userId, msg, cb) {
    if (typeof msg.text != 'string')
        return cb("Bad chat message.");
    if (msg.text[0] == '/') {
        var m = msg.text.match(/^\/(\w+)(?:|\s+(.*))$/);
        var cmd = m && COMMANDS[m[1].toLowerCase()];
        if (cmd)
            cmd(userId, m[2] || '', cb);
        else
            logTo(userId, "Invalid command.");
        return;
    }
    var text = msg.text.trim();
    if (!text)
        return cb("Empty chat message.");
    r.hget('rpg:user:' + userId, 'name', function (err, name) {
        if (err)
            return cb(err);
        gameLog(text, {who: name}, cb);
    });
};

/* GAME STATE */

userEmitter.on('session', function (session, user) {
    r.hgetall('rpg:game', function (err, game) {
        if (err)
            throw err;
        if (game)
            emitToSession(session, 'set', 'game', game);
    });
    /* Only send fully-loaded cards */
    var users = [];
    for (var id in USERS) {
        var user = USERS[id];
        if (user.name)
            users.push(user);
    }
    emitToSession(session, 'reset', 'idCards', {objs: users});
});

COMMANDS.nick = function (userId, name, cb) {
    name = name.replace(/[^\w .?\/'\-+!#&`~]+/g, '').trim().slice(0, 20);
    if (!name)
        return cb('Bad name.');
    var key = 'rpg:user:' + userId;
    r.hget(key, 'name', function (err, old) {
        if (err)
            throw err;
        if (old == name)
            return gameLog("That's already your name.", {}, cb);

        gameLog([{name: old}, ' changed their name to ', {name:name}, '.']);
        emit('set', 'idCards', {id: userId, name: name});
        if (userId in USERS)
            USERS[userId].name = name;
        r.hset('rpg:user:'+userId, 'name', name, cb);
    });
};

DISPATCH.set = function (userId, msg, cb) {
    if (msg.t != 'game')
        return cb("Bad target.");
    delete msg.t;
    if (msg.id) {
        delete msg.id;
        return cb("TODO");
    }
    for (var k in msg)
        if (typeof msg[k] != 'string')
            return cb("Bad non-string value.");
    if (_.isEmpty(msg))
        return cb("Nothing to set.");
    r.hmset('rpg:game', msg, function (err) {
        if (err)
            return cb(err);
        emit('set', 'game', msg);
        cb(null);
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
