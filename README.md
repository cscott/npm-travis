# npm-travis
[![NPM][NPM1]][NPM2]

[![Build Status][1]][2] [![dependency status][3]][4] [![dev dependency status][5]][6]

This tool allows integrating [Travis] test runs with npm-based
workflows.  The original use case was triggering [Travis] builds
from [Jenkins] in Wikimedia's [Gerrit] code review tool.

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
job will mirror the travis build status, and the console log will
contain the console output of all travis jobs (build configurations)
associated with this build.

## Advanced use

If you would like to have a separate jenkins job for every travis
build configuration, use the `--job` option:
```
  "scripts": {
    "travis-1": "npm-travis --job 1",
    "travis-2": "npm-travis --job 2",
    /* etc */
  }
```
If travis triggers *N* jobs per build (for example, `7.1`, `7.2`, ... `7.N`)
then there should be *N* scripts here.

Jenkins should then trigger `npm run travis-1`...`npm run travis-N`.
Each job's exit status will mirror the travis passed/failed status,
and the jenkins console log will contain the travis log output for
only the specific job/build configuration.

## License

MIT license; see [LICENSE](./LICENSE).

(c) 2014 by C. Scott Ananian

[Travis]:  https://travis-ci.org/
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
