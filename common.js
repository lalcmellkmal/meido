(function (exports) {

exports.CLIENT_CHAT_LENGTH = 10;

exports.randomId = function () {
        return '' + (Math.floor(Math.random() * 1e16) + 1);
};

})(typeof common != 'undefined' ? common : exports);
