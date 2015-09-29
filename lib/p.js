// Helpers for promises.
'use strict';
require('core-js/shim');
var Promise = require('prfun');

var cp = require('child_process');

var P = module.exports = {};

// My own version of when's nodefn.call with an explicit 'this',
// used for methods.
P.call = function(fn, self) {
	var args = Array.prototype.slice.call(arguments, 2);
	var pfn = Promise.promisify(fn, false, self);
	return pfn.apply(self, args);
};

// Returns a promise for completion after spawning `program`.
P.spawn = function(program, args, options) {
	return new Promise(function(resolve, reject) {
		options = options || {};
		options.childOptions = options.childOptions || {};
		options.childOptions.stdio = options.childOptions.stdio || 'inherit';
		var killTimer = null, killed = false;
		var clearKillTimer = function() {
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
		};
		var child = cp.spawn(program, args || [], options.childOptions).
			on('exit', function(exitCode, signal) {
				clearKillTimer();
				if (exitCode === 0) {
					return resolve();
				}
				var timeout = killed && /* Maybe we tried, but failed. */
					(signal === 'SIGTERM' || signal === 'SIGKILL');
				var e = new Error(
					program + ' ' + args.join(' ') + ' ' +
					(timeout ? 'exceeded execution time' : 'exited with code ' + exitCode)
				);
				e.code = exitCode;
				e.signal = signal;
				e.timeout = timeout;
				return reject(e);
			}).on('error', function(err) {
				clearKillTimer();
				reject(err);
			});
		if (options.timeout) {
			killTimer = setTimeout(function() {
				killed = true;
				child.kill('SIGTERM');
				killTimer = setTimeout(function() {
					child.kill('SIGKILL');
					killTimer = null;
				}, options.timeout * 2);
			}, options.timeout);
		}
	});
};

// Returns a promise for stdout and stderr
P.execFile = Promise.promisify(
    cp.execFile, [ 'stdout', 'stderr' ], cp
);

// Returns a promise for completion after iterating through the given
// array in parallel.  The function should return a promise for each element.
// This is like map but we throw away the results.
// If the optional `p` parameter is provided, wait for that to resolve
// before starting to process the array contents.
P.forEachPar = function(a, f, p) {
	return Promise.resolve(p).then(function() {
		return a;
	}).then(function(aResolved) {
		return Promise.all(aResolved.map(f));
	});
};

// Returns a promise for completion after iterating through the given
// array in sequence.  The function should return a promise for each element.
// If the optional `p` parameter is provided, wait for that to resolve
// before starting to process the array contents.
P.forEachSeq = function(a, f, p) {
	// The initial value must not be undefined.  Arbitrarily choose `true`.
	p = p ? Promise.resolve(p).return(true) : Promise.resolve(true);
	return Promise.reduce(a, function(curResult, value, index, total) {
		/* jshint unused: vars */
		return f.call(null, value, index, null);
	}, p);
};
