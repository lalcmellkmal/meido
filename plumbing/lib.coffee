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
            $button.appendTo '#system'
    $button.click ->
        navigator.id.request()
        false

    onLogin = (assertion) ->
        $caption.text 'Logging in...'
        send 'login', assertion: assertion, session: getSessionId()

    onLogout = ->
        $caption.text 'Logged out.'
        setTimeout (-> window.location.reload()), 1000

