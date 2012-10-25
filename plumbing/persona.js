var config = require('./config'),
    crypto = require('crypto'),
    https = require('https'),
    querystring = require('querystring');

var r;

exports.setRedis = function (conn) {
	r = conn;
};

exports.verifyAssertion = function (assertion, cb) {
	if (!assertion || typeof assertion != 'string')
		return cb('Bad Persona assertion.');
	var payload = new Buffer(querystring.stringify({
		assertion: assertion,
		audience: config.PERSONA_AUDIENCE,
	}), 'utf8');
	var opts = {
		host: 'verifier.login.persona.org',
		method: 'POST',
		path: '/verify',
		headers: {
			'Content-Length': payload.length,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
	};
	var req = https.request(opts, function (verResp) {
		if (verResp.statusCode != 200) {
			console.error('Code', verResp.statusCode);
			return cb('Persona.org error.');
		}
		verResp.once('error', function (err) {
			console.error("Persona response error", err);
			cb("Couldn't read Persona.");
		});
		verResp.setEncoding('utf8');
		var answer = [];
		verResp.on('data', function (s) {
			answer.push(s);
		});
		verResp.once('end', function () {
			var packet = answer.join('');
			try {
				packet = JSON.parse(packet);
			}
			catch (e) {
				console.error('Bad packet:', packet);
				return cb('Received corrupt Persona.');
			}
			loadAccount(packet, cb);
		});
	});
	req.once('error', function (err) {
		console.error("Bad persona request", err);
		cb("Couldn't contact persona.org.");
	});
	req.end(payload);
}

function loadAccount(packet, cb) {
	if (!packet || packet.status != 'okay')
		return cb('Bad Persona.');
	if (packet.audience != config.PERSONA_AUDIENCE) {
		console.error("Wrong audience: " + packet.audience);
		return cb('Bad Persona audience.');
	}
	if (packet.expires && packet.expires < new Date().getTime())
		return cb('Login attempt expired.');

	r.hget('rpg:userPersonas', packet.email, function (err, userId) {
		if (err)
			return cb(err);
		if (userId)
			return cb(null, userId);
		/* create account */
		r.incr('rpg:userCtr', function (err, userId) {
			if (err)
				return cb(err);
			var info = {
				email: packet.email,
				name: 'Anon',
			};
			var m = r.multi();
			m.hset('rpg:userPersonas', packet.email, userId);
			m.hmset('rpg:user:' + userId, info);
			m.exec(function (err) {
				err ? cb(err) : cb(null, userId);
			});
		});
	});
}

exports.saveSession = function (sessionKey, userId, cb) {
	r.setex('rpg:session:' + sessionKey, config.SESSION_TIME, userId, cb);
};

exports.loadSession = function (sessionKey, cb) {
	if (typeof sessionKey != 'string' || !sessionKey.match(/^\d{1,20}$/))
		return cb('Bad session ID.');

	r.get('rpg:session:' + sessionKey, function (err, userId) {
		if (err)
			cb(err);
		else
			cb(null, parseInt(userId, 10));
	});
};
