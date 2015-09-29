# npm-travis
[![NPM][NPM1]][NPM2]

[![Build Status][1]][2] [![dependency status][3]][4] [![dev dependency status][5]][6]

This tool allows integrating [Travis] test runs with npm-based
workflows.  The original use case was triggering [Travis] builds
from [Jenkins] in Wikimedia's [Gerrit] code review tool.

The basic idea is that the `npm-travis` binary will push a throwaway
branch to [github] containing the current git HEAD (which is under
review and has not yet been merged). It then uses the [Travis API]
to monitor the build triggered by this push, stream the logs as
they appear (for real-time progress feedback), and then exit with
an error code corresponding to the passed/failed status of the
travis build (after deleting the temporary branch).

In WMF's actual use, we push to [Gerrit]'s repository, which then gets
mirrored to github.  (You can specify the `--remote` option to the
CLI to specify a particular push target.)  This adds a little bit
of latency, but it prevents our Gerrit-to-github synchronization job
from attempting to "sync" and remove our temporary branch while we're
in the middle of using it.  This also allows us to use [Gerrit]'s
access controls to give `npm-travis` the ability to push only to
branches prefixed with `npm-travis/`.

## Suggested use
```
$ cd my-node-tool
$ npm install --save-dev npm-travis
```
Then add the following to the `package.json` of *my-node-tool*:
```
  "scripts": {
    "travis": "npm-travis"
  }
```

Add a job to trigger `npm run travis` to verify a submitted patch (for
example, using [Jenkins Job Builder]/[Zuul]).  The exit status of this
job will mirror the Travis build status, and the console log will
contain the console output of all Travis jobs (build configurations)
associated with this build.

**For non-node.js projects**, you can install the npm-travis tool globally
(`npm install -g npm-travis`) and just invoke the `npm-travis` binary
directly in the Jenkins job (rather than using `npm run`).

## Advanced use

If you would like to have a separate Jenkins job for every Travis
build configuration, use the `--job` option:
```
  "scripts": {
    "travis-1": "npm-travis --job 1",
    "travis-2": "npm-travis --job 2",
    /* etc */
  }
```
If Travis triggers *N* jobs per build (for example, `7.1`, `7.2`, ... `7.N`)
then there should be *N* scripts here.

Jenkins should then trigger `npm run travis-1`...`npm run travis-N`.
Each job's exit status will mirror the Travis passed/failed status,
and the Jenkins console log will contain the Travis log output for
only the specific job/build configuration.

## Configuration

The `npm-travis` tool needs two pieces of information: the name of
the [github] repository which is triggering the Travis build, and
a git remote which it can push to.  The name of the git remote
(referred to as `<remote>` below) is given by the `--remote`
command-line option, defaulting to `github`.  It then attempts to
discover the github repository name as follows:

1. If there is a repository name given on the command line, use that.
2. Otherwise, use `git remote show <remote>` to look at the push URL.
If the push URL looks like a github url, extract the repository name from it.
3. Otherwise, use `git remote show origin` and see if its push URL
looks like a github URL, extracting a repository name if so.
4. Otherwise, look in `package.json` in the current working directory, and see
if its `repository` field looks like a github URL, and extract a
repository name.
5. Fail.

It then checks whether the git remote `<remote>` exists, and if it
does not it will create it using:
```
git remote add <remote> git@github.com:<repository name>
```

In the common case where you've cloned the code from github, this just
works.  For WMF's setup, we want to push to [Gerrit], but the Gerrit
push URL doesn't map in a simple way to the [github] repository name.
So we create a git remote named `gerrit` ahead of time, and then
invoke `npm-travis --remote gerrit <repository name>`, explicitly
giving the github repository name on the command line.

## Security

Note that running `npm-travis` pushes a branch to the github
repository for your project, and therefore that task must be given
write access to the project on github.  Furthermore, if the task is
triggered on patch submission, anyone with permission to submit
patches can create a (short-lived) branch on your repository and run
arbitrary code on a Travis instance.  Be cautious.  You might want to
point `npm-travis` at a fork or mirror of your github repository.

In addition, Travis "secure variables" are normally
[disabled for cross-origin pull requests](http://blog.travis-ci.com/2013-06-10-secure-env-in-pull-requests/);
but since `npm-travis` uses same-origin branches rather than pull
requests, it is not safe to use Travis "secure variables" in
repositories using `npm-travis`.

## License

MIT license; see [LICENSE](./LICENSE).

(c) 2014 by C. Scott Ananian

[github]:  https://github.com
[Travis]:  https://travis-ci.org/
[Travis API]: http://docs.travis-ci.com/api/
[Jenkins]: https://www.mediawiki.org/wiki/Continuous_integration/Jenkins
[Gerrit]:  https://www.mediawiki.org/wiki/Gerrit
[Jenkins Job Builder]: https://www.mediawiki.org/wiki/Continuous_integration/Jenkins_job_builder
[Zuul]:    https://www.mediawiki.org/wiki/Continuous_integration/Zuul

[NPM1]: https://nodei.co/npm/npm-travis.png
[NPM2]: https://nodei.co/npm/npm-travis/

[1]: https://travis-ci.org/cscott/npm-travis.svg
[2]: https://travis-ci.org/cscott/npm-travis
[3]: https://david-dm.org/cscott/npm-travis.svg
[4]: https://david-dm.org/cscott/npm-travis
[5]: https://david-dm.org/cscott/npm-travis/dev-status.svg
[6]: https://david-dm.org/cscott/npm-travis#info=devDependencies
