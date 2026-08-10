# Task 1 Report: Multipart scheduler

## What changed

- Added `test` script to `package.json` using `node --test`.
- Added `src/js/multipart-uploader.js` with the pure multipart scheduler and the `shouldUseMultipart` and `isUploadSizeAllowed` policy helpers.
- Added `test/multipart-uploader.test.js` covering Blob slicing, ordered completion metadata, cumulative progress, concurrency limits, retry delays, non-retryable failure aborts, and completion/abort error behavior.

## Files

- `package.json`
- `src/js/multipart-uploader.js`
- `test/multipart-uploader.test.js`

## Test evidence

### RED

Command:

```text
node --test test/multipart-uploader.test.js
```

Result: failed as expected before implementation with `ERR_MODULE_NOT_FOUND` for `src/js/multipart-uploader.js`.

The requested `pnpm test -- test/multipart-uploader.test.js` command was also attempted, but the pnpm wrapper timed out after 30 seconds without output. Per task instructions, focused and full test execution used `node --test`.

### GREEN

Focused command:

```text
node --test test/multipart-uploader.test.js
```

Result: 7 tests passed, 0 failed, 0 cancelled.

Full command:

```text
node --test
```

Result: 7 tests passed, 0 failed, 0 cancelled.

Additional verification: `git diff --check` completed without whitespace errors.

## Self-review

- Scheduler creates an upload, slices the Blob into sequential parts, limits active workers to configured concurrency, retries failures with exponential delay plus injected jitter, tracks cumulative byte progress, sorts completion metadata by part number, and aborts on upload or completion failure while preserving the original error.
- All external operations are injected through the requested callbacks, with deterministic `sleep` and `random` test helpers.
- No later-task R2 protocol or UI integration files were touched.

## Concerns

- `pnpm test` could not be used because the pnpm wrapper stalled; `node --test` is the documented substitution.
- The scheduler intentionally follows the brief's contract and does not add validation for malformed policy values such as zero or negative `partSize`/`concurrency`.

## Fix round 1: explicit retryability

### Change

- Added a regression test proving an unannotated non-network error is attempted once and is not retried.
- Changed scheduler retry classification to retry only errors with explicit `retryable === true`; errors without that marker, or with `retryable === false`, now fail immediately. R2 protocol adapters can mark only network, HTTP 408, HTTP 429, and HTTP 5xx failures as retryable.
- Kept concurrency configurable as ruled: the generic scheduler does not hard-code a ceiling.

### RED evidence

Command:

```text
node --test test/multipart-uploader.test.js
```

Output (relevant failure):

```text
✔ retries a retryable part failure
✖ does not retry an unannotated non-network failure
AssertionError: 4 !== 1
ℹ tests 8
ℹ pass 7
ℹ fail 1
```

This demonstrated that the prior implementation retried the unannotated error through the retry budget.

### GREEN evidence

Focused command:

```text
node --test test/multipart-uploader.test.js
```

Output:

```text
ℹ tests 8
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
```

Full command:

```text
node --test
```

Output:

```text
ℹ tests 8
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
```

`git diff --check` also completed successfully.
