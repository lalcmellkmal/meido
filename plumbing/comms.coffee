system = new Backbone.Model
window.models = system: system

dispatch =
    set: ->
        target = models[@t]
        delete @t
        if @id
            target = target.get @id
            delete @id
        if target?.set?
            target.set this
        return

    add: ->
        models[@t].add @objs or @obj

    remove: ->
        t = models[@t]
        o = t.get @id
        if o then t.remove o
        return

    reset: ->
        models[@t].reset @objs

    upgrade: ->
        src = @src
        (-> eval(src)).call window
        $('link[rel=stylesheet]').attr 'href', @css
        return

window.sock = new window.SockJS "<%= SOCKJS_URL %>"
system.set status: 'Connecting...'

window.getSessionId = ->
    key = "<%= ID_COOKIE_NAME %>"
    id = localStorage.getItem key
    unless id
        id = common.randomId()
        localStorage.setItem key, id
    return id

_.extend sock,
    onopen: ->
        send 'session', session: getSessionId()
        system.set status: 'Logging in...'
        return

    onmessage: (msg) ->
        for data in JSON.parse msg.data
            a = data.a
            delete data.a
            dispatch[a]?.call data
        return

    onclose: ->
        err = system.get('status').error
        system.set status: error: if err then 'Dropped: ' + err else 'Lost connection.'
        return

window.send = (type, msg) ->
    msg.a = type
    msg = JSON.stringify msg
    sock.send msg
    return

