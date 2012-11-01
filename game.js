var _ = require('underscore'),
    async = require('async'),
    config = require('./plumbing/config'),
    events = require('events'),
    gameConfig = require('./config');

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
    var userId = msg.u;
    if (!msg.a) {
        var obj = msg.o, action = obj.a, user = USERS[userId];
        if (typeof action != 'string')
            return console.error("Bad message from", userId); // kick?
        if (!user)
            return console.error("Message from non-user", userId);

        if (config.DEBUG)
            console.log("> " + JSON.stringify(obj));
        var func = DISPATCH[action];
        if (!func)
            return console.warn("Unknown message type", action, "from", userId);

        var timeout = setTimeout(brokerTimeout.bind(null,userId,action), 3000);
        func(user, obj, brokerReturn.bind(null, userId, timeout));
    }
    else if (msg.a == 'new')
        onNewUser(userId);
    else if (msg.a == 'session')
        userEmitter.emit('session', msg.c, userId);
    else if (msg.a == 'gone')
        onUserGone(userId);
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
    /* clear pending timeout if any */
    var timeout = TIMEOUTS[userId];
    if (timeout) {
        clearTimeout(timeout.handle);
        delete TIMEOUTS[userId];
        console.log('#' + userId + ' found again');
    }

    if (userId in USERS)
        return;

    USERS[userId] = {id: userId};
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
            user.gm = isGmPersona(user.email) ? 1 : 0;
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
            emit('reset', 'user', _.values(USERS));
    });
}

userEmitter.on('new', function (user) {
    emit('add', 'user', {obj: user});
});

userEmitter.on('gone', function (user) {
    emit('remove', 'user', {id: user.id});
});

/* SOCIAL */

function gameLog(msg, extra, cb) {
    msg = {msg: msg, when: new Date().getTime()};
    var medium = 'log';
    if (extra) {
        if (extra.where) {
            medium = extra.where;
            delete extra.where;
        }
        _.extend(msg, extra);
    }
    r.rpush('rpg:'+medium, JSON.stringify(msg), function (err, len) {
        if (err)
            return cb ? cb(err) : console.error(err);
        msg.id = len;
        emit('add', medium, {obj: msg});
        cb && cb(null);
    });
}

function logTo(user, msg, extra) {
    var now = new Date().getTime();
    msg = {msg: msg, when: now, id: 'U'+now};
    var medium = 'log';
    if (extra) {
        if (extra.where) {
            medium = extra.where;
            delete extra.where;
        }
        _.extend(msg, extra);
    }
    emitTo(user.id || user, 'add', medium, {obj: msg});
}

function sendChatHistory(session) {
    var m = r.multi();
    m.lrange('rpg:log', -200, -1);
    m.lrange('rpg:ooc', -200, -1);
    m.exec(function (err, rs) {
        if (err) throw err;
        emitToSession(session, 'reset', 'log', {objs: rs[0].map(JSON.parse)});
        emitToSession(session, 'reset', 'ooc', {objs: rs[1].map(JSON.parse)});
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
DISPATCH.chat = function (user, msg, cb) {
    if (parseTruth(user.muted))
        return cb("You are muted.");
    if (typeof msg.text != 'string')
        return cb("Bad chat message.");
    if (['log', 'ooc'].indexOf(msg.t) < 0)
        return cb("Bad chat medium.");
    if (msg.text[0] == '/') {
        if (msg.t != 'log') {
            logTo(user, "You can only perform commands in the main chat.", {where: msg.t});
            cb(null);
            return;
        }
        var m = msg.text.match(/^\/(\w+)(?:|\s+(.*))$/);
        var cmd = m && COMMANDS[m[1].toLowerCase()];
        if (cmd)
            return cmd(user, m[2] || '', cb);
        else {
            logTo(user, "Bad command.");
            return cb(null);
        }
    }
    var text = msg.text.trim();
    if (!text)
        return cb("Empty chat message.");
    var extra = {who: user.name, where: msg.t};
    if (user.nameColor)
        extra.color = user.nameColor;
    gameLog(parseRolls(user, text), extra, cb);
};

function parseRolls(user, text) {
    return text.split(/([\/#][a-zA-Z0-9]+)/g).map(function (bit, i) {
        if (i % 2 == 0)
            return bit;

        var key = bit.slice(1).toLowerCase();
        var d = key.match(/^(\d+)?d(\d+)$/);
        if (d) {
            var n = parseInt(d[1], 10) || 1, s = parseInt(d[2], 10);
            if (s && n <= 10 && s <= 100) {
                if (n == 1)
                    return {roll: '#d' + s + ' (' + rollDie(s) + ')'};

                var rolls = [], sum = 0;
                for (var i = 0; i < n; i++) {
                    var f = rollDie(s);
                    rolls.push(f);
                    sum += f;
                }
                return {
                    roll: '#' + n + 'd' + s + ' (' + sum + ')',
                    alt: rolls.join(', '),
                };
            }
        }
        var attr = parseQuantity(user[key]);
        if (attr === 0)
            return {roll: key + ' = 0'};
        if (!attr)
            return bit;
        var roll = rollDie(6);
        return {
            roll: key + ' check ' + attr*roll,
            alt: 'rolled ' + roll + ', times ' + user[key],
        };
    });
}

function parseTruth(s) {
    return typeof s == 'string' && s.match(/^(?:1|yes|true|ok|mute)/i);
}

function parseQuantity(s) {
    if (typeof s == 'number')
        return Math.round(s);
    if (typeof s != 'string')
        return null;
    s = s.trim();
    var m = s.match(/^([+\-]?[\d,]+)(.*)/);
    if (!m)
        return null;
    var quantity = parseInt(m[1].replace(/,/g, ''), 10);
    s = m[2];
    /* modifiers */
    while (true) {
        var m = s.match(/([+\-]?[\d,]+)(.*)/);
        if (!m)
            break;
        quantity += parseInt(m[1].replace(/,/g, ''), 10);
        s = m[2];
    }
    return quantity;
}

function rollDie(n) {
    return Math.floor(Math.random() * n) + 1;
}

/* GAME STATE */

function isGmPersona(email) {
    return gameConfig.GMS.indexOf(email) >= 0;
}

userEmitter.on('session', function (session, userId) {
    var m = r.multi();
    m.hgetall('rpg:game');
    m.hget('rpg:user:' + userId, 'email');
    m.exec(function (err, rs) {
        if (err)
            throw err;
        var game = rs[0], email = rs[1];
        if (game) {
            game.gm = isGmPersona(email) ? '1' : '0';
            emitToSession(session, 'set', 'game', game);
        }
    });

    /* Only send fully-loaded cards */
    var users = [];
    for (var id in USERS) {
        var user = USERS[id];
        if (user.name)
            users.push(user);
    }
    emitToSession(session, 'reset', 'user', {objs: users});
});

COMMANDS.help = function (user, what, cb) {
    logTo(user, "Commands: /nick <new name>, /me <does action>");
    cb(null);
};

COMMANDS.me = function (user, action, cb) {
    var extra = {who: user.name, acting: true};
    if (user.nameColor)
        extra.color = user.nameColor;
    gameLog(parseRolls(user, action), extra, cb);
};

COMMANDS.nick = function (user, name, cb) {
    name = name.replace(/[^\w .?\/'\-+!#&`~]+/g, '').trim().slice(0, 20);
    if (!name)
        return cb('Bad name.');
    if (user.name == name)
        return gameLog("That's already your name.", {}, cb);

    gameLog([prettyName(user), ' changed their name to ', {name:name}, '.']);
    emit('set', 'user', {id: user.id, name: name});
    user.name = name;
    r.hset('rpg:user:'+user.id, 'name', name, cb);
};

var validTargets = ['game', 'user'];
var invalidAttrs = ['email', 'gm'];
var SETTERS = {};

DISPATCH.set = function (user, msg, cb) {
    var target = msg.t, targetId = 0;
    if (validTargets.indexOf(target) < 0)
        return cb("Bad target.");
    var key = 'rpg:' + target;
    delete msg.t;
    if (msg.id) {
        targetId = +msg.id;
        if (!targetId || targetId < 1)
            return cb("Bad target ID.");
        key = key + ':' + targetId;
        delete msg.id;
    }

    var loggedChanges = {};

    /* attrs to set; should really check these too */
    delete msg.a;
    for (var k in msg) {
        var v = msg[k];
        if (invalidAttrs.indexOf(k) >= 0 || typeof v != 'string')
            delete msg[k];
        else if (k in SETTERS) {
            v = SETTERS[k](v);
            if (typeof v == 'string')
                msg[k] = v;
            else
                delete msg[k];
        }
        else if (target == 'user') {
            if (targetId != user.id) {
                if (user.gm) {
                    var dest = USERS[targetId];
                    if (dest)
                        loggedChanges[k] = ' set ' + dest.name + "'s " + k + ' to ' + v + '.';
                }
                else {
                    delete msg[k];
                    logTo(user, "You can't modify someone else's stats.");
                }
            }
            else
                loggedChanges[k] = ' set their ' + k + ' to ' + v + '.';
        }
    }

    if (_.isEmpty(msg))
        return cb(null);

    r.hmset(key, msg, function (err) {
        if (err)
            return cb(err);
        if (targetId)
            msg.id = targetId;
        emit('set', target, msg);

        if (target == 'user') {
            var dest = USERS[targetId];
            if (dest)
                for (var k in msg)
                    dest[k] = msg[k];
        }

        for (var k in loggedChanges)
            gameLog([prettyName(user), loggedChanges[k]]);

        cb(null);
    });
};

SETTERS.title = function (title) {
    return title.trim() || 'Untitled';
};

/* Dumb hack */
var BOARD_REDIS;
if (gameConfig.BOARD_REDIS_PORT) {
    BOARD_REDIS = require('redis').createClient(gameConfig.BOARD_REDIS_PORT);
    BOARD_REDIS.once('error', function (err) {
        console.error("Board redis error:", err);
        BOARD_REDIS = null;
    });
}

SETTERS.figure = function (fig) {
    var m = fig.match(/(\d+)/);
    if (!m || !BOARD_REDIS)
        return;
    var num = m[1];
    var m = BOARD_REDIS.multi();
    m.hgetall('post:'+num);
    m.hgetall('thread:'+num);
    m.exec(function (err, posts) {
        if (err)
            console.error(err);
        var post = posts[0];
        if (!post || !post.src)
            post = posts[1];
        if (!post || !post.src)
            return console.error("No image at >>" + num);
        var fig = JSON.stringify({
            src: gameConfig.IMAGE_ROOT + post.src,
            dims: post.dims.split(/,/g).map(function (d) { return +d; }),
        });
        var m = r.multi();
        m.hset('rpg:game', 'figure', fig);
        emit('set', 'game', {figure: fig}, m);
        m.exec(function (err, cb) {
            if (err)
                console.error(err);
        });
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
