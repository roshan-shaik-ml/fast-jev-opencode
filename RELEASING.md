# Releasing

The npm package, the git tag, and the GitHub release are one release. Keep them in step — the
version in `package.json`, `package-lock.json`, the `vX.Y.Z` tag, and the npm registry must all
agree once a release is done.

1. `npm test` and `npm run format:check` pass, and CI on `main` is green.
2. Bump both files at once: `npm version X.Y.Z --no-git-tag-version`
3. Commit and push. Wait for CI.
4. Tag and push:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   The `release` workflow turns the tag into a GitHub release automatically, so tags and
   releases cannot drift apart.

5. Publish the tarball both suites passed against — the one step that needs a 2FA code:

   ```sh
   npm pack
   npm publish fast-jev-opencode-X.Y.Z.tgz
   ```

6. Verify all three agree:

   ```sh
   npm view fast-jev-opencode version   # the published version
   gh release list                      # the release for the tag
   git tag -l                           # the tag itself
   ```

If step 5 is skipped or fails, the version is simply not released: bump to a new version on the
next change. npm never allows re-publishing a version that already exists.
