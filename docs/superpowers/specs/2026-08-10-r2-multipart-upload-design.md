# R2 Multipart Upload Design

## Goal

Raise the browser upload limit from 300 MiB to 5 GiB and add reliable, memory-efficient multipart uploads for large files while preserving the current lightweight, dependency-minimal architecture.

## Scope

- Accept individual files up to 5 GiB (`5 * 1024 * 1024 * 1024` bytes).
- Keep the existing single-request S3 `PUT` path for files up to and including 100 MiB.
- Use the R2 S3-compatible multipart API for files larger than 100 MiB.
- Support parallel part uploads, bounded retries, byte-based progress, and best-effort cleanup.
- Keep uploads resumable only within the active JavaScript operation. Refreshing or closing the page does not preserve multipart state.
- Preserve existing filename templates, overwrite checks, compression behavior, batch upload behavior, and post-upload refresh.

## Out of Scope

- Persisting upload IDs or completed-part state in IndexedDB or local storage.
- Resuming after a page refresh, browser restart, or device change.
- Pause, resume, or cancel controls in the upload panel.
- Raising the application limit above 5 GiB.
- Introducing the AWS JavaScript SDK.

## Upload Strategy

The upload manager rejects original inputs above 5 GiB before compression or network activity. For accepted inputs, it selects the transport after optional image compression, because the compressed file size is the size actually sent to R2.

| Uploaded size | Strategy |
| --- | --- |
| `<= 100 MiB` | Existing signed single `PUT` |
| `> 100 MiB` and `<= 5 GiB` | Multipart upload |
| Original input `> 5 GiB` | Reject before compression or network activity |

Multipart uploads use fixed 16 MiB parts. The final part may be smaller. At the 5 GiB application limit, this produces at most 320 parts, comfortably below R2's 10,000-part limit. Up to three parts of one file may upload concurrently.

## Components

### Constants

`src/js/constants.js` defines the application upload limit, multipart threshold, part size, part concurrency, retry count, and retry delay. Keeping protocol tuning values together makes the policy visible and prevents magic numbers in upload code.

### Multipart Orchestrator

A new focused module, `src/js/multipart-uploader.js`, owns protocol-independent orchestration:

- Slice a `Blob` without reading the complete file into memory.
- Schedule at most three concurrent part tasks.
- Retry retryable part failures up to three times with exponential backoff and jitter.
- Retain each returned part number and ETag.
- Report cumulative completed bytes after each part finishes.
- Sort completed parts by part number before completion.
- Abort the multipart upload on any terminal failure, preserving the original error.

The module receives create, upload-part, complete, and abort callbacks. This keeps network signing and XML details out of the scheduler and lets the scheduler be tested with Node's built-in test runner.

### R2 Client

`src/js/r2-client.js` adds the S3 multipart protocol operations:

1. `CreateMultipartUpload`: signed `POST` with `?uploads`, returning `UploadId` from XML.
2. `UploadPart`: signed `PUT` with `partNumber` and `uploadId`, returning the response `ETag`.
3. `CompleteMultipartUpload`: signed `POST` with an escaped XML list of ordered part numbers and ETags.
4. `AbortMultipartUpload`: signed `DELETE` with `uploadId`.

Query parameters are built with `URL` and `URLSearchParams`. XML values are escaped before interpolation. Non-successful responses include HTTP status metadata so the orchestrator retries only network errors, HTTP 408, HTTP 429, and HTTP 5xx failures. Missing `ETag` is a non-retryable configuration error.

### Upload Manager and UI

`src/js/upload-manager.js` continues to own file preparation and display. It delegates files above the threshold to the multipart orchestrator and keeps the existing single-upload path for smaller files.

For multipart uploads, the progress bar becomes determinate and advances by completed bytes. Status text shows a localized percentage and transferred/total size. Single uploads retain the existing indeterminate bar because `fetch` does not expose request-body progress.

Failures mark the current progress bar as failed and flow through the existing batch result/toast behavior. A missing readable `ETag` produces a specific localized message telling the user to add `ETag` to the bucket CORS `ExposeHeaders` setting.

## Retry and Cleanup Rules

- Only individual part uploads are retried automatically.
- A part gets one initial attempt plus up to three retries.
- Retry delays use an exponential base of 500 ms plus jitter.
- HTTP 408, HTTP 429, HTTP 5xx, and network failures are retryable.
- Authentication, validation, missing ETag, and other HTTP 4xx failures are not retryable.
- Create and complete operations are not automatically retried because a lost response can make blind replay create orphaned uploads or obscure a successful completion.
- After a multipart upload has been created, any terminal failure triggers a best-effort abort. Abort failure does not replace the original upload error.

## R2 CORS Requirement

Browser multipart upload requires the bucket CORS policy to allow the application's origin and the multipart request methods. It must expose `ETag`, because the browser must read each uploaded part's ETag to complete the upload.

The Chinese and English README files will document a policy equivalent to:

```json
[
  {
    "AllowedOrigins": ["https://your-app.example"],
    "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Users must replace the example origin with their actual application origin. Existing deployments that only permit `PUT` need this update before multipart uploads work.

## Localization

All supported language dictionaries receive consistent messages for multipart progress and the missing-ETag CORS error. Existing `fileTooLarge` text is updated to describe the 5 GiB application limit accurately instead of suggesting that all large files require an external tool.

## Testing

The project will add a `node --test` script and focused tests for the multipart orchestrator. Tests cover:

- Correct part boundaries and smaller final part.
- Concurrency never exceeding three.
- Ordered completion metadata when parts finish out of order.
- Progress reaching the exact total byte count.
- Retry success after transient failures.
- No retry for non-retryable failures.
- Abort after terminal upload or completion failure.
- Original errors surviving an abort failure.

Static verification includes the existing TypeScript check and formatting check. Manual browser verification covers one small single upload, one multipart upload, visible multipart progress, and the localized CORS error when `ETag` is not exposed.

## Success Criteria

- Files up to 5 GiB pass client-side validation; larger files are rejected.
- Files at or below 100 MiB still use one signed `PUT`.
- Larger accepted files upload in 16 MiB slices without loading the whole file into memory.
- Part concurrency, retry, ordering, progress, completion, and abort behavior match this specification.
- The project documents the required CORS change and reports a specific actionable error when `ETag` is unavailable.
- Automated tests and static checks pass.
