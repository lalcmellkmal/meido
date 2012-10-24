var config = require('./plumbing/config');

var r = require('redis').createClient(config.REDIS_PORT);

var EMAIL = 'lalc@doushio.com';

r.hget('rpg:userPersonas', EMAIL, function (err, userId) {
	if (err) throw err;
	r.keys('rpg:session:*', function (err, keys) {
		if (err) throw err;
		var m = r.multi();
		if (userId)
			keys.push('rpg:user:' + userId);
		keys.forEach(function (key) {
			m.del(key);
		});
		m.hdel('rpg:userPersonas', EMAIL);
		m.exec(function (err) {
			if (err) throw err;
			r.quit();
			console.log('Login ' + userId + ' and all sessions reset.');
		});
	});
});
