var _ = require('underscore'),
    fs = require('fs'),
    child_process = require('child_process');

var SERVER_DEPS = ['game.js', 'config.js'];

var server;
var startServer = _.debounce(function () {
	if (server)
		server.kill('SIGTERM');
	var startTime = new Date();
	server = child_process.spawn('node', ['game.js']);
	server.stdout.pipe(process.stdout);
	server.stderr.pipe(process.stderr);
	server.once('exit', function (code, signal) {
		/* signal means we'll take care of restart;
		   42 means swallowed signal and graceful cleanup */
		if (signal || code == 42)
			return;

		/* Otherwise, died of mysterious causes. */
		if (new Date() - startTime < 2000)
			console.error("Server died too fast. Not restarting.");
		else
			setTimeout(startServer, 0);
	});
}, 500);

function monitor(func, dep) {
	var mtime = new Date;
	fs.watchFile(dep, {interval: 500, persistent: true}, function (event) {
		if (event.mtime > mtime) {
			func();
			mtime = event.mtime;
		}
	});
}

SERVER_DEPS.forEach(monitor.bind(null, startServer));
startServer();
