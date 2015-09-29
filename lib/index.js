'use strict';
require('core-js/shim');
var Promise = require('prfun');

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
	.usage('[options] [github user/project]')
	.option(
		'--travis-api <url>',
		'Travis API endpoint [https://api.travis-ci.org]',
		'https://api.travis-ci.org'
	).option(
		'--remote <name>',
		'Use the specified git remote for push [github]',
		'github'
	).option(
		'-j, --job <n>',
		'Only follow the specified job (job numbers start at 1)'
	);

program.parse(process.argv);

if (program.args.length > 1) {
	console.error('Too many arguments.');
	return 1;
}

var getUserAgent = function(reponame) {
	return json.name + '/' + json.version + ' (' +
		'node ' + process.version + ' ' + process.platform + ' ' + process.arch +
		')' + (reponame ? ' ' + reponame : '');
};

var gitRemoteRegex =
	/Push\s+URL:\s+(?:https?:\/\/github.com\/|git@github.com:)([^\/]+)\/([^\/]+?)(?:\.git)?\s/;

var getRepoName = function() {
	return Promise.resolve(program.args[0]).then(function(reponame) {
		if (reponame) { return reponame; }
		// Look in .git/config for 'github' remote.
		return p.execFile('git', ['remote','show',program.remote]).then(function(out) {
			var m = gitRemoteRegex.exec(out.stdout);
			if (m) {
				return m[1] + '/' + m[2];
			}
		});
	}).catch(function(e) { /* Ignore. */ }).then(function(reponame) {
		if (reponame) { return reponame; }
		// Look in .git/config for 'origin' remote.
		return p.execFile('git', ['remote','show','origin']).then(function(out) {
			var m = gitRemoteRegex.exec(out.stdout);
			if (m) {
				return m[1] + '/' + m[2];
			}
		});
	}).catch(function(e) { /* Ignore. */ }).then(function(reponame) {
		if (reponame) { return reponame; }
		// Look in ./package.json
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
	}).catch(function(e) { /* Ignore */ }).then(function(reponame) {
		if (reponame) { return reponame; }
		throw new Error("Can't determine github repo name.");
	});
};

// Ensure that there is a github remote, named 'github'.
var ensureRemote = function(repo) {
	return p.spawn('git', ['remote', 'show', program.remote], CHILD_IGNORE).then(function() {
		/* OK, github already exists. */
	}, function(e) {
		/* Doesn't exist, create it! */
		return p.spawn('git', ['remote','add',program.remote,'git@github.com:' + repo]);
	});
};

// Get the hash of HEAD.
var getGitHead = function() {
	return p.execFile('git', ['rev-parse', 'HEAD']).then(function(out) {
		return out.stdout.trim();
	});
};

// Create the new branch name.
var getBranchName = function(hash) {
	// Use a slash in the branch name so that gerrit can use
	// its access controls to ensure that the npm-travis user can only
	// push to npm-travis/* branches (not branches in general).
	return json.name + '/' + hash.slice(0, 8);
};

// Push to github.
var ensureBranch = function(repo, branchname) {
	return ensureRemote(repo).then(function() {
		return p.spawn('git', ['push', program.remote, 'HEAD:refs/heads/' + branchname], CHILD_IGNORE);
	});
};

var deleteBranch = function(repo, branchname) {
	return ensureRemote(repo).then(function() {
		return p.spawn('git', ['push', program.remote, ':' + branchname], {
			timeout: 60 * 1000,
			childOptions: CHILD_IGNORE.childOptions,
		});
	});
};

var apiRequest = function(path, opts) {
	opts = opts || {};
	if (Array.isArray(path)) {
		path = '/' + path.map(encodeURIComponent).join('/');
	}
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
			'User-Agent': getUserAgent(opts.reponame),
			Accept: mimeType,
		},
		retries: opts.retries,
		delay: opts.delay,
		timeout: opts.timeout,
	}).then(function(resp) {
		if (resp.response.statusCode !== 200) {
			throw new Error('Bad status: ' + resp.response.statusCode);
		}
		return opts.raw ? resp.body : JSON.parse(resp.body);
	});
};

var getTravisConfig = function() {
	return apiRequest('/config').get('config');
};

var getTravisRepo = function(reponame) {
	return apiRequest('/repos/' + reponame, { reponame: reponame }).get('repo');
};

var getTravisBuild = function(reponame, repo_id, branch, retry) {
	return apiRequest(['repos', repo_id, 'branches', branch], {
		reponame: reponame,
		timeout: 30 * 1000,
		delay:   5 * 1000, /* Check every 5 seconds... */
		retries: retry ? 3 * 12 : 0, /* ...for up to 3 minutes. */
	}).get('branch');
};

var getTravisJob = function(reponame, job_id) {
	return apiRequest(['jobs', job_id], { reponame: reponame }).get('job');
};

var getTravisLog = function(reponame, log_id, chunked) {
	return apiRequest(['logs', log_id], {
		reponame: reponame,
		chunked: chunked,
	}).get('log');
};

var Log = function() {
	this.chunks = [];
	this.next = 1;
	this._last = null;
};
Log.prototype.has = function(n) {
	return this.chunks[n] !== undefined;
};
Log.prototype.add = function(n, data) {
	this.chunks[n] = data;
	return this.advance();
};
Log.prototype.done = function() {
	return this._last !== null && this.next > this._last;
};
Log.prototype.advance = function() {
	while (this.chunks[this.next] !== undefined) {
		process.stdout.write(this.chunks[this.next++]);
	}
	return this.done();
};
Log.prototype.last = function(n) {
	this._last = n;
	return this.done();
};

var doit = function() {
	var state = {}, pusher;
	var initState = function() {
		return Promise.all([
			getTravisConfig().then(function(config) {
				state.config = config;
				pusher = new Pusher(state.config.pusher.key);
				if (false) { /* Debugging. */
					pusher.connection.on('message', function(message) {
						console.log('GOT PUSHER MESSAGE', message);
					});
				}
			}),
			getGitHead().then(function(hash) {
				state.githash = hash;
				state.branch = getBranchName(hash);
			}),
			getRepoName().then(function(reponame) {
				state.reponame = reponame;
				return getTravisRepo(reponame).then(function(repo) {
					state.repo = repo;
				});
			}),
		]).then(function() {
			// Check to see if builds on this branch already exist.
			return getTravisBuild(state.reponame, state.repo.id, state.branch, false).catch(function(e) {
				// Doesn't yet exist; push to github and then retry query until
				// we see the build show up in travis.
				return ensureBranch(state.reponame, state.branch).then(function() {
					// Clean up this branch on Ctrl-C.
					state.SIGINT = function() {
						console.log('\nCleaning up', state.branch);
						deleteBranch(state.reponame, state.branch).catch(function(e) {
							/* Ignore failure; we're dying here. */
						}).then(function() { process.exit(1); });
					};
					process.once('SIGINT', state.SIGINT);
					// Ok, get the build on this branch.
					return getTravisBuild(state.reponame, state.repo.id, state.branch, true);
				});
			});
		}).then(function(build) {
			// Ok, we've got a build on this branch!
			state.build = build;
			console.log(
				'==> Travis build',
				state.build.number,
				'(',
				'https://' + state.config.host + '/' + state.reponame + '/builds/' + state.build.id,
				')'
			);
			return state;
		});
	};
	var watchJob = function(job_num) {
		return Promise.resolve().then(function() {
			state.job_num = job_num;
			state.job_id = state.build.job_ids[state.job_num - 1];
			console.log(
				'==> Travis job',
				state.build.number + '.' + state.job_num,
				'(',
				'https://' + state.config.host + '/' + state.reponame + '/jobs/' + state.job_id,
				')'
			);
			// Check job #
			if (!state.job_id) {
				throw new Error(
					'Bad job number: ' + state.job_num +
						' (' + state.build.job_ids.length + ' jobs)'
				);
			}
			return getTravisJob(state.reponame, state.job_id);
		}).then(function(job) {
			state.job = job;
			var log = new Log();
			if (/^(passed|failed)$/.test(state.job.state || '')) {
				// Fetch all the logs, easy-peasy.
				return getTravisLog(state.reponame, state.job.log_id, false/*Not chunked*/).then(function(resp_log) {
					log.last(1);
					log.add(1, resp_log.body);
				});
			}
			// Hm, we need to stream the logs.
			var channelName = 'job-' + state.job_id;
			var channel = pusher.subscribe(channelName);
			var streamResolve;
			var handleChunk = function(data) {
				var content = data._log !== undefined ? data._log : data.content;
				if (data.final) {
					// Weird: *Usually* there's one more chunk coming.
					// Wait for it, but no more than 10s.
					log.last(data.number + 1);
					setTimeout(function() {
						if (!log.has(data.number + 1)) {
							log.add(data.number + 1, '\n----\n');
							streamResolve();
						}
					}, 10 * 1000);
				}
				var last = log.add(data.number, content);
				if (last) { streamResolve(); }
			};
			return Promise.all([
				// Fetch chunked log to fill in gaps.
				new Promise(function(resolve, reject) {
					channel.bind('pusher:subscription_succeeded', function() {
						getTravisLog(state.reponame, state.job.log_id, true /* Chunked */).then(function(resp_log) {
							resp_log.parts.forEach(handleChunk);
						}).then(resolve, reject);
					});
				}),
				// Tail log for this job.
				new Promise(function(resolve, reject) {
					streamResolve = resolve;
					channel.bind('job:log', handleChunk);
					channel.bind('job:finished', streamResolve);
				}).then(function() {
					pusher.unsubscribe(channelName);
				}),
			]);
		}).then(function() {
			return getTravisJob(state.reponame, state.job_id);
		}).then(function(job) {
			state.job = job;
			return state.job.state;
		});
	};
	var getBuildStatus = function(retries) {
		return getTravisBuild(
			state.reponame, state.repo.id, state.branch, false
		).then(function(build) {
			if (build.state !== 'started' || retries === 0) {
				return build;
			}
			// There's sometimes a race here: if the build state isn't
			// "passed" or "failed" yet, wait a little bit and try again.
			// In separate jobs mode this isn't unusual, but we still want
			// to be sure that the last one out cleans up the branch.
			console.log('==> ' + json.name + ': ' + build.state + ' (retrying)');
			return Promise.delay(5 * 1000).then(function() {
				return getBuildStatus(retries - 1);
			});
		});
	};
	var cleanup = function() {
		return Promise.resolve().then(function() {
			pusher.disconnect();
			return getBuildStatus(6/*30 seconds*/);
		}).then(function(build) {
			state.build = build;
			// If build is complete (all jobs), we can clean up the branch.
			if (state.SIGINT) {
				process.removeListener('SIGINT', state.SIGINT);
			}
			if (/^(passed|failed)$/.test(state.build.state || '')) {
				return deleteBranch(state.reponame, state.branch).catch(function(e) {
					/* Ignore failure, maybe already deleted. */
				});
			}
		});
	};

	// Ok, put all the pieces together.
	return initState().then(function() {
		if (program.job !== undefined) {
			// Watch one particular job.
			return watchJob((+program.job));
		}
		// Watch all jobs.
		return Promise.reduce(state.build.job_ids, function(_,jid,index) {
			return watchJob(index + 1);
		}, null);
	}).then(function() {
		return cleanup();
	}).then(function() {
		if (program.job !== undefined) {
			// Return our job status.
			return state.job.state;
		}
		// Return our build status.
		return state.build.state;
	});
};

doit().then(function(status) {
	console.log('==> ' + json.name + ': ' + status);
	if (status !== 'passed') {
		process.exit(1);
	} else {
		process.exit(0);
	}
}).done();
