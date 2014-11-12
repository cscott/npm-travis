npm-travis
==========

This tool allows integrating travis test runs with npm-based
workflows.  The original use case was triggering travis builds
from Jenkins in Wikimedia's Gerrit review tool.

Suggested use:
```
$ cd my-node-tool
$ npm install --save-dev npm-travis
```
Then add the following to your `package.json`:
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
and the jenkins console log will contain the travis log output.
