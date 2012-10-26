packed.js: .comms.js client.js
	@cat $^ > $@

client.js: lib.coffee ../client.coffee
	@coffee -jcp $^ > $@

.comms.js: comms.coffee
	@node assets.js .comms.js

clean:
	rm -f client.js .comms.js packed.js
