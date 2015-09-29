// Wrapper for the 'request' module, which makes it automatically retry
// requests.
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var request = require('request');

var DEFAULT_TIMEOUT = 60 * 1000; /* Milliseconds. */
var DEFAULT_RETRIES = 3;
var DEFAULT_DELAY = 0; /* Retry immediately. */
// Limit the number of simultaneous HTTP requests (T73895).
var REQUEST_LIMIT = 0; /* No limit. */

var ReadableStream = require('readable-stream');
var util = require('util');

var cleanOpts = function(opts) {
	// Clone the opts array, and clean up our own properties so that
	// request doesn't get confused (and so request can't scribble on
	// our properties).
	opts = util._extend({}, opts);
	opts.callback = undefined;
	opts.log = undefined;
	opts.retries = undefined;
	opts.delay = undefined;
	opts.stream = undefined;
	return opts;
};

// Doesn't support all of the request.<foo> methods yet, just the main
// function entry point and a modified API for getting a readable stream.
var RetryRequest = module.exports = function(uri, options, callback) {
	// Duplicate the parameter handling of the 'request' module.
	var opts;
	if (typeof uri === 'undefined') {
		throw new Error('undefined is not a valid uri or options object.');
	}
	if ((typeof options === 'function') && !callback) {
		callback = options;
	}
	if (options && typeof options === 'object') {
		opts = util._extend({}, options);
		opts.uri = uri;
	} else if (typeof uri === 'string') {
		opts = {uri: uri};
	} else {
		opts = util._extend({}, uri);
	}
	if (callback) {
		opts.callback = callback;
	}

	/* To quote the request module:
	 * "People use this property instead all the time so why not just
	 * support it."
	 */
	if (opts.url && !opts.uri) {
		opts.uri = opts.url;
		opts.url = undefined;
	}

	// Ok, all the user options are in opts.
	// Add a default timeout and munge the callback slightly.
	if (opts.timeout === undefined) {
		opts.timeout = RetryRequest.DEFAULT_TIMEOUT;
	}
	if (opts.retries === undefined) {
		opts.retries = RetryRequest.DEFAULT_RETRIES;
	}
	if (opts.delay === undefined) {
		opts.delay = RetryRequest.DEFAULT_DELAY;
	}
	// Optionally log retries.
	var log = opts.log || console.error.bind(console);
	var origCb = opts.callback;
	// Promise compatibility.
	var resolve, reject, p = new Promise(function(_resolve, _reject) {
		resolve = _resolve; reject = _reject;
	}).nodify(origCb && function(err, o) {
		// Thunk to traditional node callback API.
		origCb(err, o && (o.response || o.stream), o && (o.body || o.request));
	});

	var req, mkrequest, n = 0;
	var ncallback = function(error, response, body) {
		if (opts.retries > 0 && (error || response.statusCode !== 200)) {
			log('Retrying (' + (++n) + ')', opts.uri, error || response.statusCode);
			opts.retries--;
			opts.timeout *= 2;
			return Promise.delay(opts.delay).then(mkrequest);
		}
		// Promise API.
		if (error) {
			return reject(error);
		} else {
			return resolve({ response: response, body: body });
		}
	};
	if (!opts.stream) {
		opts.callback = ncallback;
	}
	mkrequest = function() {
		req = request(cleanOpts(opts), opts.callback);
		if (opts.stream) {
			var rstream = req;
			if (/^v0\.8\./.test(process.version)) {
				rstream = new ReadableStream();
				rstream.wrap(req);
			}
			rstream.pause();
			return resolve({ stream: rstream, request: req });
		}
		return p;
	};
	if (RetryRequest.REQUEST_LIMIT) {
		if (RetryRequest._cached_limit !== RetryRequest.REQUEST_LIMIT) {
			RetryRequest._cached_guard = Promise.guard.n(
				(RetryRequest._cached_limit = RetryRequest.REQUEST_LIMIT)
			);
		}
		return Promise.guard(RetryRequest._cached_guard, mkrequest)();
	}
	return mkrequest();
};
RetryRequest.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;
RetryRequest.DEFAULT_RETRIES = DEFAULT_RETRIES;
RetryRequest.DEFAULT_DELAY = DEFAULT_DELAY;
RetryRequest.REQUEST_LIMIT = REQUEST_LIMIT;
