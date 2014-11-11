require('es6-shim');
require('prfun');

var program = require('commander');
var json = require('../package.json');

var p = require('./p');

var CHILD_IGNORE = { childOptions: { stdio: 'ignore' } };

program
	.version(json.version)
	.usage('[options] [github project]');

program.parse(process.argv);

if (program.args.length > 1) {
    console.error('Too many arguments.');
    return 1;
}

var getRepoName = function() {
    var reponame = program.args[0];
    if (reponame) {
        return Promise.resolve(reponame);
    }
    // look in package.json
    if (json.repository && json.repository.type === 'git') {
        var m = /^(https?:\/\/github.com\/)?([^\/]+)\/([^\/]+?)(\.git)?$/.
            exec(json.repository.url || '');
        if (m) {
            reponame = m[2] + '/' + m[3];
            return Promise.resolve(reponame);
        }
    }
    // XXX look in .git/config?
    return Promise.reject(new Error("Can't determine github repo name."));
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

var part2 = function(state) {
    console.log('whoo!', state);
};

var doit = function() {
    var state = {};
    return Promise.all([
        getGitHead().then(function(hash) {
            state.githash = hash;
            state.branch = getBranchName(hash);
        }),
        getRepoName().then(function(repo) {
            state.repo = repo;
        })
    ]).then(function() {
        return ensureBranch(state.repo, state.branch).then(function() {
            return part2(state)
        }).finally(function() {
            return deleteBranch(state.repo, state.branch);
        });
    });
};

doit().done();
