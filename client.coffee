class LogEntry extends Backbone.Model

class LogEntryView extends AutoView
    tagName: 'li'
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
            $who = $ '<em/>', text: attrs.who
            if attrs.color then $who.css color: attrs.color
            if attrs.acting
                @$el.addClass('meta').append '*&nbsp;', $who, '&nbsp;'
            else
                @$el.append $who, ':&nbsp;'
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
        else if bit.roll
            $ '<b/>', text: bit.roll, title: (bit.alt || '')
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
        overflow = @model.length - 200
        if overflow > 0
            for i in [1..overflow]
                @model.shift()
        if alreadyAtBottom
            @$el.scrollTop e.scrollHeight
        else
            if models.social.get('tab') == @id
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

class OocView extends LogView
    id: 'ooc'

class Social extends Backbone.Model
    defaults:
        tab: 'log'

class SocialView extends AutoView
    id: 'social'
    events:
        submit: 'submitChat'
        'click #unseenMessageHint': 'scrollToUnseen',
        'click .tab': 'chooseTab'

    links:
        'change:unseenMessage': 'unseenMessage'
        'change:tab': 'displayTab'

    render: ->
        this

    submitChat: (event) ->
        $input = @$ '#chatInput'
        text = $input.val().trim()
        if text.length
            send 'chat', text: text, t: @model.get 'tab'
            $input.val('').focus()
        false

    unseenMessage: (model, unseen) ->
        @$('#unseenMessageHint').toggle !!unseen

    scrollToUnseen: ->
        $log = @$ '#log'
        $log.scrollTop $log[0].scrollHeight
        @model.set unseenMessage: false
        false

    chooseTab: (event) ->
        tab = $(event.target).attr('href').replace '#', ''
        @model.set tab: tab, unseenMessage: false
        false

    displayTab: (model, tab) ->
        @$('ul').hide()
        $tab = @$ '#' + tab
        $tab.show().scrollTop $tab[0].scrollHeight

basicAttrs = "Spirit,Favor,Stress,Athletics,Affection,Skill,Cunning,Luck,Will".split /,/g
moreAttrs = "Maid Types,Maid Colors,Special Qualities,Maid Roots,Stress Explosion,Maid Powers,Maid Weapon".split /,/g
adminAttrs = "Name Color,Muted".split /,/g

attrKeyFromName = (name) ->
    name[0].toLowerCase() + name.slice(1).replace(/\s+/g, '')

class PlayerCard extends Backbone.Model
    defaults:
        muted: 'no'

class PlayerCardView extends AutoView
    tagName: 'li'
    events:
        'click .target': 'writeTarget'
        'click .more': 'toggleExpanded'

    links:
        change: 'render'
        remove: 'remove'

    render: ->
        attrs = @model.attributes
        $table = $ '<table/>'

        $row = $('<tr/>').appendTo $table
        $header = $('<th/>', text: attrs.name).appendTo $row
        $header.append ' ', $ '<a/>',
            text: if attrs.expanded then 'x' else '...'
            'class': 'act more'
            href: '#'

        $row = $('<tr/>').appendTo $table
        $basic = $('<td/>', 'class': 'basic').appendTo $row
        for name in basicAttrs
            $basic.append @makeAttr(name), '<br>'

        if attrs.expanded
            $expanded = $('<td/>', 'class': 'expanded').appendTo $row
            for name in moreAttrs
                $expanded.append @makeAttr(name), '<br>'

            if models.game.isGM()
                $expanded = $('<td/>', 'class': 'admin').appendTo $row
                for name in adminAttrs
                    $expanded.append @makeAttr(name), '<br>'

        @$el.empty().append $table
        this

    makeAttr: (name) ->
        key = attrKeyFromName name
        $em = $('<em/>', text: name).append ':&nbsp;'
        $a = $('<span/>').append $em, textNode "#{@model.get(key) || 0}"
        asTarget(key, $a)

    toggleExpanded: (event) ->
        @model.set 'expanded', not @model.get 'expanded'
        false

class PlayerCards extends Backbone.Collection
    model: PlayerCard
    comparator: (card) -> card.id

class PlayerCardsView extends AutoView
    id: 'user'
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

    isGM: ->
        return !! parseInt @get('gm'), 10

class GameView extends AutoView
    id: 'game'

    events:
        'click .target': 'writeTarget'

    links:
        change: 'render'
        'change:figure change:displayWidth': 'renderFigure'
        'change:gm': 'renderGM'

    render: ->
        attrs = @model.attributes
        @$('h1').text attrs.title
        this

    renderFigure: (model, attr, meta) ->
        $img = @$ '#figure'
        if meta.changes.figure
            fig = model.get 'figure'
            if fig
                fig = JSON.parse fig
            @cachedFigure = fig
            unless fig and fig.src
                $img.attr src: '', width: 40, height: 40
                return this
            if fig.src != $img.attr 'src'
                $img.attr src: fig.src

        if meta.changes.figure or meta.changes.displayWidth
            fig = @cachedFigure
            if fig
                maxWidth = model.get('displayWidth') - 10
                [w, h] = fig.dims
                if w > maxWidth
                    h = Math.floor h * maxWidth / w
                    w = maxWidth
                $img.attr width: w, height: h
        this

    renderGM: (model) ->
        if model.isGM()
            asTarget 'figure', '#figure'
        else
            notTarget 'figure', '#figure'

$(window).resize ->
    models.game.set displayWidth: Math.floor $(window).width() / 2

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
    $social = $('<form/>', id: 'social').append [
        $ '<ul/>', id: 'log'
        $('<ul/>', id: 'ooc').hide()
        $ '<input>', id: 'chatInput'
        $ '<a/>', 'class': 'tab', text: 'main', href: '#log'
        $ '<a/>', 'class': 'tab', text: 'ooc', href: '#ooc'
        $('<a/>', {href: '', id: 'unseenMessageHint', text: 'New message ↓'}).hide()
    ]

    $game = $('<div/>', id: 'game').append [
        asTarget 'title', '<h1/>'
        $ '<img id=figure width=40 height=40>'
        $ '<ul/>', id: 'user'
    ]

    $('body').append [
        $social
        $game
    ]

    $game.addClass 'mutable'
    return

initialDomSetup()
setupModel 'game', Game
setupModel 'user', PlayerCards
setupModel 'social', Social
setupModel 'log', Log
setupModel 'ooc', Log
setupViews [SystemView, GameView, PlayerCardsView, SocialView, LogView, OocView]
$(window).resize()
