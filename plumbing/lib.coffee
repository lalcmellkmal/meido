setupModel = (name, newModel) ->
    models[name] = new newModel models[name]?.toJSON()

setupViews = (spec) ->
    views = []
    for viewClass in spec
        id = viewClass.prototype.id
        unless id
            logError "#{viewClass} has no id"
        $el = $('#' + id)
        unless $el.length
            logError "No DOM element for #{viewClass}"
        view = new viewClass model: models[id], el: $el[0]
        view.render()
        views.unshift view
    # detach old views and set up the new detacher
    window.detachViews?()
    window.detachViews = ->
        for view in views
            view.deinitialize()
    return

logError = (err) ->
    console?.error? err

class AutoView extends Backbone.View
    initialize: ->
        if @links
            for event, method of @links
                @model.on event, this[method], this
        null

    deinitialize: ->
        @undelegateEvents()
        if @links
            for event, method of @links
                @model.off event, this[method], this
        null

    writeTarget: (event) ->
        event.stopPropagation()
        $t = $ event.currentTarget
        path = _.filter $t.attr('class').split(/\s+/g),
                        (cls) -> cls.match /^attr-/
        if path.length == 1
            path = path[0].slice 5
            oldVal = @model.get path
            $t.css color: 'gray'
            newVal = prompt "Enter new #{nameFromAttrKey path}.", oldVal
            $t.css color: 'inherit'
            if newVal
                setter = if @id then {t: @id} else @findPath $t
                if setter
                    setter[path] = newVal
                    send 'set', setter

            # TEMP
            $('#chatInput').focus()
        return

    findPath: ($child) ->
        for t in $child.parents()
            if t.id
                return {t: t.id, id: @model.id}
        null

asTarget = (path, el) ->
    $(el).addClass('target').addClass('attr-' + path)

notTarget = (path, el) ->
    $(el).removeClass('target').removeClass('attr-' + path)
    null

nameFromAttrKey = (key) ->
    key.replace /[A-Z]/g, (c) -> " #{c.toLowerCase()}"

requestLogin = ->
    requestLogin = -> null
    $button = $ '<a/>', href: '#', 'class': 'persona-button orange'
    $caption = $('<span>Login</span>').appendTo $button
    yepnope
        load: ['http://login.persona.org/include.js', 'persona-buttons.css'],
        complete: ->
            navigator.id.watch
                loggedInUser: null
                onlogin: onLogin
                onlogout: onLogout
            $('#system').append '<br>', $button
    $button.click ->
        navigator.id.request()
        false

    onLogin = (assertion) ->
        $caption.text 'Logging in...'
        send 'login', assertion: assertion, session: getSessionId()

    onLogout = ->
        $caption.text 'Logged out.'
        setTimeout (-> window.location.reload()), 1000

