upgrade:
	@kill -HUP `cat plumbing/.broker.pid`

run:
	@node game.js

plumbing/client.js:
	@$(MAKE) -C plumbing client.js

clean:
	@$(MAKE) -C plumbing clean

.PHONY: upgrade run clean
