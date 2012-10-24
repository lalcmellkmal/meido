packed.js: ../common.js .comms.js client.js
	@echo "(function () { var common = {};" > $@
	@cat $^ >> $@
	@echo "}).call(this);" >> $@

client.js: lib.coffee ../client.coffee
	@coffee -jcp $^ > $@

.comms.js: comms.coffee
	@node assets.js .comms.js

clean:
	rm -f client.js .comms.js packed.js
