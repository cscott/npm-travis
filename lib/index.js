"use strict";
require('es6-shim');
require('prfun');

var program = require('commander');
var json = require('../package.json');
var fs = require('fs');
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
	var apiURL = url.resolve(program.travisApi, path);
	opts = opts || {};
	return request({
		url: apiURL,
		encoding: 'utf8',
		pool: false,
		headers: {
			'User-Agent': getUserAgent(),
			'Accept': 'application/vnd.travis-ci.2+json'
		},
		retries: opts.retries,
		delay: opts.delay,
		timeout: opts.timeout
	}).then(function(resp) {
		return JSON.parse(resp.body);
	});
};

var getTravisBuild = function(repo, branch, retry) {
	return apiRequest('/repos/'+repo+'/branches/'+branch, {
		timeout: 30 * 1000,
		delay:   5 * 1000, /* check every 5 seconds */
		retries: retry ? 3 * 12 : 0 /* for up to 3 minutes */
	});
};

var getTravisJob = function(job_id) {
	return apiRequest('/jobs/'+job_id);
};

var doit = function() {
	var state = {
		job_num: (+program.job) || 1
	};
	return Promise.all([
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
		}).then(function(resp) {
			// ok, we've got a build on this branch!
			state.build = resp.branch;
			state.job_id = state.build.job_ids[state.job_num - 1];
			// check job #
			if (!state.job_id) {
				throw new Error(
					"Bad job number: " + state.job_num +
						" ("+state.build.job_ids.length+" jobs)"
				);
			}
			return getTravisJob(state.job_id);
		}).then(function(resp) {
			state.job = resp.job;
			// if build is complete, we can clean up the branch
			if (/^(passed|failed)$/.test(state.build.state || '')) {
				return deleteBranch(state.repo, state.branch);
			}
		});
	}).then(function() {
		// XXX tail log for this job
		console.log(state);
	});
};

doit().done();
