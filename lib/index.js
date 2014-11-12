"use strict";
require('es6-shim');
require('prfun');

var program = require('commander');
var json = require('../package.json');

var fs = require('fs');
var Pusher = require('pusher-client');
var url = require('url');

var p = require('./p');
var request = require('./retry-request');

var CHILD_IGNORE = { childOptions: { stdio: 'ignore' } };
var readFile = Promise.promisify(fs.readFile, false, fs);

program
	.version(json.version)
	.usage('[options] [github project]')
	.option(
		'--travis-api <url>',
		'Travis API endpoint [https://api.travis-ci.org]',
		'https://api.travis-ci.org'
	).option(
		'-j, --job <n>',
		'Which job to follow [1]',
		1
	);

program.parse(process.argv);

if (program.args.length > 1) {
	console.error('Too many arguments.');
	return 1;
}

var getUserAgent = function(repo) {
	return json.name + '/' + json.version + ' (' +
		'node ' + process.version + ' ' + process.platform + ' ' + process.arch +
		') ' + repo;
};

var getRepoName = function() {
	return Promise.resolve(program.args[0]).then(function(reponame) {
		if (reponame) { return reponame; }
		// look in ./package.json
		return readFile(
			'./package.json', { encoding: 'utf8' }
		).then(function(data) {
			var json = JSON.parse(data);
			if (json.repository && json.repository.type === 'git') {
				var m =
					/^(https?:\/\/github.com\/)?([^\/]+)\/([^\/]+?)(\.git)?$/.
					exec(json.repository.url || '');
				if (m) {
					return m[2] + '/' + m[3];
				}
			}
		});
	}).catch(function(e) { /* ignore */ }).then(function(reponame) {
		if (reponame) { return reponame; }
		// XXX look in .git/config?
		throw new Error("Can't determine github repo name.");
	});
};

// ensure that there is a github remote, named 'github'
var ensureRemote = function(repo) {
	return p.spawn('git', ['remote', 'show', 'github'], CHILD_IGNORE).then(function() {
		/* ok, github already exists */
	}, function(e) {
		/* doesn't exist, create it! */
		return p.spawn('git', ['remote','add','github','git@github.com:'+repo]);
	});
};

// get the hash of HEAD
var getGitHead = function() {
	return p.execFile('git', ['rev-parse', 'HEAD']).then(function(out) {
		return out.stdout.trim();
	});
};

// create the new branch name
var getBranchName = function(hash) {
	return json.name + '-' + hash.slice(0, 8);
};

// push to github
var ensureBranch = function(repo, branchname) {
	return ensureRemote(repo).then(function() {
		return p.spawn('git', ['push', 'github', 'HEAD:'+branchname], CHILD_IGNORE);
	});
};

var deleteBranch = function(repo, branchname) {
	return ensureRemote(repo).then(function() {
		return p.spawn('git', ['push', 'github', ':'+branchname], CHILD_IGNORE);
	});
};

var apiRequest = function(path, opts) {
	opts = opts || {};
	var apiURL = url.resolve(program.travisApi, path);
	var mimeType = 'application/vnd.travis-ci.2+json';
	if (opts.chunked) {
		mimeType += '; chunked=true';
	}
	return request({
		url: apiURL,
		encoding: 'utf8',
		pool: false,
		headers: {
			'User-Agent': getUserAgent(),
			'Accept': mimeType
		},
		retries: opts.retries,
		delay: opts.delay,
		timeout: opts.timeout
	}).then(function(resp) {
		if (resp.response.statusCode !== 200) {
			throw new Error("Bad status: "+resp.response.statusCode);
		}
		return opts.raw ? resp.body : JSON.parse(resp.body);
	});
};

var getTravisConfig = function() {
	return apiRequest('/config').get('config');
};

var getTravisBuild = function(repo, branch, retry) {
	return apiRequest('/repos/'+repo+'/branches/'+branch, {
		timeout: 30 * 1000,
		delay:   5 * 1000, /* check every 5 seconds */
		retries: retry ? 3 * 12 : 0 /* for up to 3 minutes */
	}).get('branch');
};

var getTravisJob = function(job_id) {
	return apiRequest('/jobs/'+job_id).get('job');
};

var getTravisLog = function(log_id, chunked) {
	return apiRequest('/logs/'+log_id, {
		chunked: chunked,
	}).get('log');
};

var Log = function() {
	this.chunks = [];
	this.next = 1;
	this._last = -1;
};
Log.prototype.add = function(n, data) {
	this.chunks[n] = data;
	this.advance();
	return (n === this._last);
};
Log.prototype.advance = function() {
	while (this.chunks[this.next] !== undefined) {
		process.stdout.write(this.chunks[this.next++]);
	}
};
Log.prototype.last = function(n) {
	this._last = n;
};

var doit = function() {
	var state = {}, pusher;
	var initState = function() {
		return Promise.all([
			getTravisConfig().then(function(config) {
				state.config = config;
				pusher = new Pusher(state.config.pusher.key);
				if (false) { /* debugging */
					pusher.connection.on('message', function(message) {
						console.log('GOT PUSHER MESSAGE', message);
					});
				}
			}),
			getGitHead().then(function(hash) {
				state.githash = hash;
				state.branch = getBranchName(hash);
			}),
			getRepoName().then(function(repo) {
				state.repo = repo;
			})
		]).then(function() {
			// check to see if builds on this branch already exist
			return getTravisBuild(state.repo, state.branch, false).catch(function(e) {
				// doesn't yet exist; push to github and then retry query until
				// we see the build show up in travis.
				return ensureBranch(state.repo, state.branch).then(function() {
					return getTravisBuild(state.repo, state.branch, true);
				});
			});
		}).then(function(build) {
			// ok, we've got a build on this branch!
			state.build = build;
			return state;
		});
	};
	var watchJob = function(job_num) {
		return Promise.resolve().then(function() {
			state.job_num = job_num;
			state.job_id = state.build.job_ids[state.job_num - 1];
			// check job #
			if (!state.job_id) {
				throw new Error(
					"Bad job number: " + state.job_num +
						" ("+state.build.job_ids.length+" jobs)"
				);
			}
			return getTravisJob(state.job_id);
		}).then(function(job) {
			state.job = job;
			var log = new Log();
			if (/^(passed|failed)$/.test(state.job.state || '')) {
				// fetch all the logs, easy-peasy
				return getTravisLog(state.job.log_id, false/*not chunked*/).then(function(resp_log) {
					log.last(1);
					log.add(1, resp_log.body);
				});
			}
			// hm, we need to stream the logs.
			var channelName = 'job-' + state.job_id;
			var channel = pusher.subscribe(channelName);
			var streamResolve;
			var handleChunk = function(data) {
				var content = data._log !== undefined ? data._log : data.content;
				if (data.final) {
					log.last(data.number + 1); // weird!
				}
				var last = log.add(data.number, content);
				if (last) { streamResolve(); }
			};
			return Promise.all([
				// fetch chunked log to fill in gaps
				new Promise(function(resolve, reject) {
					channel.bind('pusher:subscription_succeeded', function() {
						getTravisLog(state.job.log_id, true /* chunked */).then(function(resp_log) {
							resp_log.parts.forEach(handleChunk);
						}).then(resolve, reject);
					});
				}),
				// tail log for this job
				new Promise(function(resolve, reject) {
					streamResolve = resolve;
					channel.bind('job:log', handleChunk);
					channel.bind('job:finished', streamResolve);
				}).then(function() {
					pusher.unsubscribe(channelName);
				})
			]);
		}).then(function() {
			return getTravisJob(state.job_id);
		}).then(function(job) {
			state.job = job;
			return state.job.state;
		});
	};
	var cleanup = function() {
		return Promise.resolve().then(function() {
			pusher.disconnect();
			return getTravisBuild(state.repo, state.branch, false);
		}).then(function(build) {
			state.build = build;
			// if build is complete (all jobs), we can clean up the branch
			if (/^(passed|failed)$/.test(state.build.state || '')) {
				return deleteBranch(state.repo, state.branch).catch(function(e) {
					/* ignore failure, maybe already deleted */
				});
			}
		});
	};

	// ok, put all the pieces together
	return initState().then(function() {
		return watchJob((+program.job) || 1);
	}).then(function() {
		return cleanup();
	}).then(function() {
		// return our job status
		return state.job.state;
	});
};

doit().then(function(status) {
	if (status !== 'passed') {
		process.exit(1);
	}
}).done();
