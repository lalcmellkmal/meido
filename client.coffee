class LogEntry extends Backbone.Model

class LogEntryView extends AutoView
    tag: 'li'
    links:
        change: 'render'
        remove: 'remove'

    render: ->
        attrs = @model.attributes
        @$el.empty()
        date = new Date attrs.when
        $date = $ '<time/>',
            text: "#{(date.getHours()+11) % 12 + 1}:#{pad2 date.getMinutes()}"
        @$el.append $date, '&nbsp;'
        if attrs.who
            @$el.append $('<em/>', text: "<#{attrs.who}>"), '&nbsp;'
        else
            @$el.addClass 'meta'
        @$el.append formatMessage attrs.msg
        this

pad2 = (n) ->
    (if n > 9 then '' else '0') + n

formatMessage = (msg) ->
    if typeof msg == 'string'
        return textNode msg
    for bit in msg
        if bit.name
            $ '<em/>', text: bit.name
        else
            formatMessage bit

textNode = (t) -> document.createTextNode t

class Log extends Backbone.Collection
    model: LogEntry

class LogView extends AutoView
    id: 'log'
    events:
        scroll: 'onScroll'
    links:
        add: 'addAndScroll'
        reset: 'reset'

    add: (entry) ->
        view = new LogEntryView model: entry
        @$el.append view.render().el
        return

    addAndScroll: (entry) ->
        e = @el
        alreadyAtBottom = e.scrollTop + 20 >= e.scrollHeight - e.clientHeight
        @add entry
        overflow = @model.length - common.CLIENT_CHAT_LENGTH
        if overflow > 0
            for i in [1..overflow]
                @model.shift()
        if alreadyAtBottom
            @$el.scrollTop e.scrollHeight
        else
            models.social.set unseenMessage: true
        return

    reset: (log) ->
        @$el.empty()
        @add entry for entry in log.models
        @$el.scrollTop @el.scrollHeight
        return

    onScroll: () ->
        if models.social.get 'unseenMessage'
            e = @el
            if e.scrollTop + 5 >= e.scrollHeight - e.clientHeight
                models.social.set unseenMessage: false

    render: ->
        this


class Social extends Backbone.Model

class SocialView extends AutoView
    id: 'social'
    events:
        submit: 'submitChat'
        'click #unseenMessageHint': 'scrollToUnseen',
    links:
        'change:unseenMessage': 'unseenMessage'

    render: ->
        this

    submitChat: (event) ->
        $input = @$ '#chatInput'
        text = $input.val().trim()
        if text.length
            send 'chat', text: text
            $input.val('').focus()
        false

    unseenMessage: (model, unseen) ->
        @$('#unseenMessageHint').toggle !!unseen

    scrollToUnseen: ->
        $log = @$ '#log'
        $log.scrollTop $log[0].scrollHeight
        @model.set unseenMessage: false
        false

maidAttrs = ['Athletics', 'Affection', 'Skill', 'Cunning', 'Luck', 'Will']

class PlayerCard extends Backbone.Model

class PlayerCardView extends AutoView
    tagName: 'li'
    links:
        change: 'render'
        remove: 'remove'

    render: ->
        @$el.empty()
        attrs = @model.attributes
        @$el.append $('<b/>', text: attrs.name), '<br>'
        for attr in maidAttrs
            @$el.append textNode("#{attr}: #{attrs[attr] || 0}"), '<br>'
        this

class PlayerCards extends Backbone.Collection
    model: PlayerCard
    comparator: (card) -> card.id

class PlayerCardsView extends AutoView
    id: 'idCards'
    links:
        add: 'add'
        reset: 'render'

    add: (card) ->
        @$el.append new PlayerCardView(model: card).render().el

    render: ->
        @$el.empty()
        @model.each @add, this
        this

class Game extends Backbone.Model
    defaults:
        title: 'Maid RPG'

class GameView extends AutoView
    id: 'game'

    events:
        'click .target': 'writeTarget'

    links:
        change: 'render'

    render: ->
        attrs = @model.attributes
        @$('h1').text(attrs.title).data(path: 'title')
        this

class SystemView extends AutoView
    id: 'system'
    links:
        change: 'render'

    render: ->
        status = @model.get 'status'
        error = !!status.error
        status = status.error || status
        @$('b').text(status).toggleClass 'error', error

        if @model.get 'requestLogin'
            requestLogin()
        else
            @$('.persona-button').hide()

        this

initialDomSetup = ->
    if window.domIsSetup
        return
    window.domIsSetup = true
    $social = $('<form/>', id: 'social').appendTo 'body'
    $log = $('<ul/>', id: 'log').appendTo $social
    $('<input>', id: 'chatInput').appendTo $social
    $('<a/>', {href: '', id: 'unseenMessageHint', text: 'New message ↓'}).appendTo($social).hide()

    $game = $('<div/>', id: 'game').appendTo 'body'
    $game.append asTarget 'title', '<h1/>'
    $game.append $ '<ul/>', id: 'idCards'

    $game.addClass 'mutable'
    return

initialDomSetup()
setupModel 'game', Game
setupModel 'idCards', PlayerCards
setupModel 'social', Social
setupModel 'log', Log
setupViews [SystemView, GameView, PlayerCardsView, SocialView, LogView]
