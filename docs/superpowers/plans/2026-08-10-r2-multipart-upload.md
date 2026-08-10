# R2 Multipart Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the browser upload limit to 5 GiB and upload files larger than 100 MiB through reliable, bounded-concurrency R2 multipart uploads.

**Architecture:** Keep the current signed single `PUT` for small files. Add a protocol-independent multipart scheduler that slices `Blob` instances, retries parts, reports completed-byte progress, and cleans up failures; add the four S3 multipart operations to `R2Client` behind injectable signing and fetch dependencies so both layers can be tested without a real bucket.

**Tech Stack:** Browser ES modules, JavaScript with TypeScript `checkJs`, `aws4fetch`, Node built-in test runner, Cloudflare R2 S3-compatible API.

## Global Constraints

- The maximum accepted original file size is exactly 5 GiB (`5 * 1024 * 1024 * 1024` bytes).
- Files at or below 100 MiB keep the existing signed single-`PUT` path; larger accepted files use multipart upload after optional compression.
- Multipart parts are 16 MiB, except the final part; at most three parts of one file upload concurrently.
- Each part receives one initial attempt plus no more than three retries with a 500 ms exponential base delay and jitter.
- Only network errors, HTTP 408, HTTP 429, and HTTP 5xx are retryable.
- Multipart failures trigger best-effort abort without replacing the original error.
- No upload state survives a page refresh, browser restart, or device change.
- Do not introduce the AWS JavaScript SDK or another production dependency.
- Browser multipart upload requires bucket CORS to permit `POST`, `PUT`, and `DELETE` and expose `ETag`.

## File Structure

- Create `src/js/multipart-uploader.js`: pure slicing, concurrency, retry, progress, ordering, completion, and cleanup orchestration.
- Create `test/multipart-uploader.test.js`: deterministic scheduler tests using `Blob`, injected delays, and fake protocol callbacks.
- Create `test/r2-client-multipart.test.js`: signed request, XML, ETag, and retry-metadata tests with injected client/fetch doubles.
- Create `test/upload-policy.test.js`: exact constant values and threshold selection tests.
- Modify `src/js/r2-client.js`: injectable dependencies plus create/upload/complete/abort multipart operations.
- Modify `src/js/constants.js`: 5 GiB limit and multipart policy values.
- Modify `src/js/upload-manager.js`: transport selection, multipart adapters, determinate progress, and localized configuration errors.
- Modify `src/js/i18n.js`: Simplified Chinese, Traditional Chinese, English, and Japanese multipart copy.
- Modify `package.json`: add the Node test command.
- Modify `readme.md` and `readme-en.md`: remove the obsolete 300 MB guidance and make the `ETag` CORS requirement explicit.

---

### Task 1: Multipart scheduler

**Files:**
- Create: `src/js/multipart-uploader.js`
- Create: `test/multipart-uploader.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: a `Blob`, multipart policy values, and injected `createUpload`, `uploadPart`, `completeUpload`, `abortUpload`, `onProgress`, `sleep`, and `random` callbacks.
- Produces: `uploadMultipart(options): Promise<void>` and `shouldUseMultipart(size, threshold): boolean`.

- [ ] **Step 1: Add the test script and write scheduler tests that fail because the module does not exist**

Add this script to `package.json`:

```json
"test": "node --test"
```

Create `test/multipart-uploader.test.js` with deterministic helpers and tests for slicing, ordering, progress, concurrency, retry, and abort:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { uploadMultipart } from '../src/js/multipart-uploader.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

function baseOptions(overrides = {}) {
  const completed = []
  return {
    blob: new Blob([new Uint8Array(25)]),
    partSize: 10,
    concurrency: 3,
    maxRetries: 3,
    retryBaseDelay: 500,
    createUpload: async () => 'upload-1',
    uploadPart: async ({ partNumber, body }) => {
      completed.push({ partNumber, size: body.size })
      return `etag-${partNumber}`
    },
    completeUpload: async ({ parts }) => completed.push({ parts }),
    abortUpload: async () => {},
    onProgress: () => {},
    sleep: async () => {},
    random: () => 0,
    completed,
    ...overrides,
  }
}

test('slices a blob and completes with parts ordered by part number', async () => {
  const options = baseOptions()
  await uploadMultipart(options)
  assert.deepEqual(options.completed.slice(0, 3), [
    { partNumber: 1, size: 10 },
    { partNumber: 2, size: 10 },
    { partNumber: 3, size: 5 },
  ])
  assert.deepEqual(options.completed[3].parts, [
    { partNumber: 1, etag: 'etag-1' },
    { partNumber: 2, etag: 'etag-2' },
    { partNumber: 3, etag: 'etag-3' },
  ])
})

test('reports cumulative completed bytes through the exact total', async () => {
  const progress = []
  const options = baseOptions({ onProgress: (value) => progress.push(value) })
  await uploadMultipart(options)
  assert.equal(progress.at(-1).loaded, 25)
  assert.equal(progress.at(-1).total, 25)
  assert.equal(progress.at(-1).percent, 100)
})

test('never exceeds the configured part concurrency', async () => {
  let active = 0
  let peak = 0
  const gates = Array.from({ length: 4 }, deferred)
  const options = baseOptions({
    blob: new Blob([new Uint8Array(40)]),
    concurrency: 2,
    uploadPart: async ({ partNumber }) => {
      active++
      peak = Math.max(peak, active)
      await gates[partNumber - 1].promise
      active--
      return `etag-${partNumber}`
    },
  })
  const uploading = uploadMultipart(options)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(peak, 2)
  gates[0].resolve()
  gates[1].resolve()
  await Promise.resolve()
  await Promise.resolve()
  gates[2].resolve()
  gates[3].resolve()
  await uploading
})

test('orders completion metadata even when parts finish out of order', async () => {
  const gates = Array.from({ length: 3 }, deferred)
  let received
  const options = baseOptions({
    uploadPart: async ({ partNumber }) => {
      await gates[partNumber - 1].promise
      return `etag-${partNumber}`
    },
    completeUpload: async ({ parts }) => (received = parts),
  })
  const uploading = uploadMultipart(options)
  await Promise.resolve()
  gates[2].resolve()
  gates[0].resolve()
  gates[1].resolve()
  await uploading
  assert.deepEqual(received.map((part) => part.partNumber), [1, 2, 3])
})

test('retries a retryable part failure with exponential delays', async () => {
  let attempts = 0
  const delays = []
  const options = baseOptions({
    blob: new Blob([new Uint8Array(5)]),
    uploadPart: async () => {
      attempts++
      if (attempts < 3) throw Object.assign(new Error('temporary'), { retryable: true })
      return 'etag-1'
    },
    sleep: async (delay) => delays.push(delay),
  })
  await uploadMultipart(options)
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [500, 1000])
})

test('does not retry a non-retryable failure and aborts once', async () => {
  let attempts = 0
  let aborts = 0
  const expected = Object.assign(new Error('bad request'), { retryable: false })
  const options = baseOptions({
    blob: new Blob([new Uint8Array(5)]),
    uploadPart: async () => {
      attempts++
      throw expected
    },
    abortUpload: async ({ uploadId }) => {
      assert.equal(uploadId, 'upload-1')
      aborts++
    },
  })
  await assert.rejects(uploadMultipart(options), (error) => error === expected)
  assert.equal(attempts, 1)
  assert.equal(aborts, 1)
})

test('aborts completion failure and preserves it when abort also fails', async () => {
  const expected = new Error('complete failed')
  const options = baseOptions({
    completeUpload: async () => {
      throw expected
    },
    abortUpload: async () => {
      throw new Error('abort failed')
    },
  })
  await assert.rejects(uploadMultipart(options), (error) => error === expected)
})
```

- [ ] **Step 2: Run the scheduler tests and verify the expected red state**

Run: `pnpm test -- test/multipart-uploader.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/js/multipart-uploader.js`.

- [ ] **Step 3: Implement the minimal scheduler**

Create `src/js/multipart-uploader.js`:

```js
/** @param {number} delay */
const defaultSleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

/** @param {number} size @param {number} threshold */
export function shouldUseMultipart(size, threshold) {
  return size > threshold
}

/**
 * @param {{
 *   blob: Blob,
 *   partSize: number,
 *   concurrency: number,
 *   maxRetries: number,
 *   retryBaseDelay: number,
 *   createUpload: () => Promise<string>,
 *   uploadPart: (part: {uploadId: string, partNumber: number, body: Blob}) => Promise<string>,
 *   completeUpload: (value: {uploadId: string, parts: {partNumber: number, etag: string}[]}) => Promise<void>,
 *   abortUpload: (value: {uploadId: string}) => Promise<void>,
 *   onProgress?: (value: {loaded: number, total: number, percent: number}) => void,
 *   sleep?: (delay: number) => Promise<void>,
 *   random?: () => number,
 * }} options
 */
export async function uploadMultipart({
  blob,
  partSize,
  concurrency,
  maxRetries,
  retryBaseDelay,
  createUpload,
  uploadPart,
  completeUpload,
  abortUpload,
  onProgress = () => {},
  sleep = defaultSleep,
  random = Math.random,
}) {
  const uploadId = await createUpload()
  const count = Math.ceil(blob.size / partSize)
  const parts = new Array(count)
  let nextIndex = 0
  let loaded = 0
  /** @type {any} */
  let failure = null

  /** @param {number} partNumber @param {Blob} body */
  const uploadWithRetry = async (partNumber, body) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await uploadPart({ uploadId, partNumber, body })
      } catch (/** @type {any} */ error) {
        if (error?.retryable === false || attempt >= maxRetries) throw error
        const delay = retryBaseDelay * 2 ** attempt + random() * retryBaseDelay
        await sleep(delay)
      }
    }
  }

  const worker = async () => {
    while (!failure) {
      const index = nextIndex++
      if (index >= count) return
      const start = index * partSize
      const body = blob.slice(start, Math.min(start + partSize, blob.size))
      try {
        const partNumber = index + 1
        const etag = await uploadWithRetry(partNumber, body)
        parts[index] = { partNumber, etag }
        loaded += body.size
        onProgress({ loaded, total: blob.size, percent: Math.round((loaded / blob.size) * 100) })
      } catch (/** @type {any} */ error) {
        failure = error
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker))
    if (failure) throw failure
    await completeUpload({ uploadId, parts: parts.toSorted((a, b) => a.partNumber - b.partNumber) })
  } catch (/** @type {any} */ error) {
    try {
      await abortUpload({ uploadId })
    } catch {}
    throw error
  }
}
```

- [ ] **Step 4: Run the scheduler tests and verify green**

Run: `pnpm test -- test/multipart-uploader.test.js`

Expected: all scheduler tests PASS.

- [ ] **Step 5: Commit the scheduler**

```bash
git add package.json src/js/multipart-uploader.js test/multipart-uploader.test.js
git commit -m "feat: add multipart upload scheduler"
```

---

### Task 2: R2 multipart protocol client

**Files:**
- Modify: `src/js/r2-client.js:8-24,85-94`
- Create: `test/r2-client-multipart.test.js`

**Interfaces:**
- Consumes: `ConfigManager.getBucketUrl()`, `encodeS3Key()`, an `AwsClient`-compatible signer, and a fetch-compatible function.
- Produces: `createMultipartUpload(key, contentType): Promise<string>`, `uploadPart(key, uploadId, partNumber, body): Promise<string>`, `completeMultipartUpload(key, uploadId, parts): Promise<void>`, and `abortMultipartUpload(key, uploadId): Promise<void>`.

- [ ] **Step 1: Write failing protocol tests**

Create `test/r2-client-multipart.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { R2Client } from '../src/js/r2-client.js'

function setup(responses) {
  const requests = []
  const signer = { sign: async (url, init) => new Request(url, init) }
  const client = new R2Client({
    clientFactory: () => signer,
    fetchImpl: async (request) => {
      requests.push(request)
      return responses.shift()
    },
  })
  client.init({
    get: () => ({ accessKeyId: 'key', secretAccessKey: 'secret' }),
    getBucketUrl: () => 'https://account.r2.cloudflarestorage.com/bucket',
  })
  return { client, requests }
}

test('creates a multipart upload and parses UploadId', async () => {
  const { client, requests } = setup([
    new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>'),
  ])
  assert.equal(await client.createMultipartUpload('folder/a b.bin', 'application/octet-stream'), 'upload-1')
  assert.equal(requests[0].method, 'POST')
  assert.equal(new URL(requests[0].url).searchParams.has('uploads'), true)
  assert.match(requests[0].url, /folder\/a%20b\.bin/)
})

test('uploads a part and returns its exposed ETag', async () => {
  const { client, requests } = setup([new Response('', { headers: { ETag: '"etag-1"' } })])
  const etag = await client.uploadPart('a.bin', 'upload id', 2, new Blob(['part']))
  assert.equal(etag, '"etag-1"')
  assert.equal(requests[0].method, 'PUT')
  const url = new URL(requests[0].url)
  assert.equal(url.searchParams.get('uploadId'), 'upload id')
  assert.equal(url.searchParams.get('partNumber'), '2')
})

test('marks a missing ETag as a non-retryable CORS configuration error', async () => {
  const { client } = setup([new Response('')])
  await assert.rejects(client.uploadPart('a.bin', 'id', 1, new Blob(['part'])), (error) => {
    assert.equal(error.code, 'MULTIPART_ETAG_MISSING')
    assert.equal(error.retryable, false)
    return true
  })
})

test('completes with escaped, ordered part XML', async () => {
  const { client, requests } = setup([new Response('')])
  await client.completeMultipartUpload('a.bin', 'id', [
    { partNumber: 1, etag: '"a&b"' },
    { partNumber: 2, etag: '"etag-2"' },
  ])
  assert.equal(requests[0].method, 'POST')
  assert.equal(new URL(requests[0].url).searchParams.get('uploadId'), 'id')
  const body = await requests[0].text()
  assert.match(body, /<PartNumber>1<\/PartNumber><ETag>&quot;a&amp;b&quot;<\/ETag>/)
})

test('aborts with DELETE and classifies retryable HTTP responses', async () => {
  const retryable = setup([new Response('', { status: 503 })]).client
  await assert.rejects(retryable.abortMultipartUpload('a.bin', 'id'), (error) => error.retryable === true)

  const rejected = setup([new Response('', { status: 403 })]).client
  await assert.rejects(rejected.abortMultipartUpload('a.bin', 'id'), (error) => error.retryable === false)
})
```

- [ ] **Step 2: Run the protocol tests and verify the expected red state**

Run: `pnpm test -- test/r2-client-multipart.test.js`

Expected: FAIL because the constructor injection and multipart methods do not exist.

- [ ] **Step 3: Add one-shot signed fetch support and the multipart methods**

Add the following typed helpers before `R2Client`:

```js
class R2RequestError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, retryable?: boolean}} [options]
   */
  constructor(message, { status = 0, code = '', retryable = false } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/** @param {string | number} value */
const escapeXml = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** @param {string} value */
const decodeXml = (value) =>
  value.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')

/** @param {string} xml @param {string} tag */
const readXmlTag = (xml, tag) => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return decodeXml(match?.[1] ?? '')
}

/** @param {Response} response */
const requestError = (response) =>
  new R2RequestError(`HTTP ${response.status}`, {
    status: response.status,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
  })
```

Add these fields and initialize them from optional constructor arguments:

```js
/** @type {(options: any) => AwsClient} */
#clientFactory
/** @type {typeof fetch} */
#fetchImpl

/** @param {{clientFactory?: (options: any) => AwsClient, fetchImpl?: typeof fetch}} [options] */
constructor({
  clientFactory = (options) => new AwsClient(options),
  fetchImpl = (input, init) => fetch(input, init),
} = {}) {
  this.#clientFactory = clientFactory
  this.#fetchImpl = fetchImpl
}

// Inside init(configManager), replace `new AwsClient(...)` with:
this.#client = this.#clientFactory({
  accessKeyId: cfg.accessKeyId,
  secretAccessKey: cfg.secretAccessKey,
  service: 's3',
  region: 'auto',
})

/** @param {string | URL} url @param {RequestInit} init */
async #signedFetchOnce(url, init) {
  const request = await /** @type {AwsClient} */ (this.#client).sign(url, init)
  return this.#fetchImpl(request)
}
```

Implement the four operations:

```js
/** @param {string} key @param {string} contentType */
async createMultipartUpload(key, contentType) {
  const url = new URL(`${this.#config.getBucketUrl()}/${encodeS3Key(key)}`)
  url.searchParams.set('uploads', '')
  const res = await this.#signedFetchOnce(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
  })
  if (!res.ok) throw requestError(res)
  const uploadId = readXmlTag(await res.text(), 'UploadId')
  if (!uploadId) {
    throw new R2RequestError('Missing UploadId', { code: 'MULTIPART_UPLOAD_ID_MISSING' })
  }
  return uploadId
}

/** @param {string} key @param {string} uploadId @param {number} partNumber @param {Blob} body */
async uploadPart(key, uploadId, partNumber, body) {
  const url = new URL(`${this.#config.getBucketUrl()}/${encodeS3Key(key)}`)
  url.searchParams.set('partNumber', String(partNumber))
  url.searchParams.set('uploadId', uploadId)
  const res = await this.#signedFetchOnce(url, { method: 'PUT', body })
  if (!res.ok) throw requestError(res)
  const etag = res.headers.get('etag')
  if (!etag) {
    throw new R2RequestError('Multipart ETag is not exposed by CORS', {
      code: 'MULTIPART_ETAG_MISSING',
      retryable: false,
    })
  }
  return etag
}

/**
 * @param {string} key
 * @param {string} uploadId
 * @param {{partNumber: number, etag: string}[]} parts
 */
async completeMultipartUpload(key, uploadId, parts) {
  const url = new URL(`${this.#config.getBucketUrl()}/${encodeS3Key(key)}`)
  url.searchParams.set('uploadId', uploadId)
  const body = `<CompleteMultipartUpload>${parts
    .map(({ partNumber, etag }) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`
  const res = await this.#signedFetchOnce(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body,
  })
  if (!res.ok) throw requestError(res)
}

/** @param {string} key @param {string} uploadId */
async abortMultipartUpload(key, uploadId) {
  const url = new URL(`${this.#config.getBucketUrl()}/${encodeS3Key(key)}`)
  url.searchParams.set('uploadId', uploadId)
  const res = await this.#signedFetchOnce(url, { method: 'DELETE' })
  if (!res.ok) throw requestError(res)
}
```

- [ ] **Step 4: Run protocol and scheduler tests**

Run: `pnpm test -- test/r2-client-multipart.test.js test/multipart-uploader.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the protocol client**

```bash
git add src/js/r2-client.js test/r2-client-multipart.test.js
git commit -m "feat: add R2 multipart protocol operations"
```

---

### Task 3: Upload policy and UI integration

**Files:**
- Modify: `src/js/constants.js:12`
- Modify: `src/js/multipart-uploader.js`
- Modify: `src/js/upload-manager.js:7,340-530`
- Modify: `src/js/i18n.js:41-44,101-108,293-296,353-360,546-549,606-614,805-808,865-873`
- Create: `test/upload-policy.test.js`

**Interfaces:**
- Consumes: the Task 1 scheduler, Task 2 R2 methods, existing `filesize`, UI elements, and translation helper.
- Produces: automatic single/multipart selection, determinate multipart progress, and localized `MULTIPART_ETAG_MISSING` guidance.

- [ ] **Step 1: Write failing upload policy tests**

Create `test/upload-policy.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_UPLOAD_SIZE,
  MULTIPART_THRESHOLD,
  MULTIPART_PART_SIZE,
  MULTIPART_CONCURRENCY,
  MULTIPART_MAX_RETRIES,
  MULTIPART_RETRY_BASE_DELAY,
} from '../src/js/constants.js'
import { shouldUseMultipart } from '../src/js/multipart-uploader.js'

test('defines the approved upload policy values', () => {
  assert.equal(MAX_UPLOAD_SIZE, 5 * 1024 ** 3)
  assert.equal(MULTIPART_THRESHOLD, 100 * 1024 ** 2)
  assert.equal(MULTIPART_PART_SIZE, 16 * 1024 ** 2)
  assert.equal(MULTIPART_CONCURRENCY, 3)
  assert.equal(MULTIPART_MAX_RETRIES, 3)
  assert.equal(MULTIPART_RETRY_BASE_DELAY, 500)
})

test('uses multipart only above the threshold', () => {
  assert.equal(shouldUseMultipart(MULTIPART_THRESHOLD, MULTIPART_THRESHOLD), false)
  assert.equal(shouldUseMultipart(MULTIPART_THRESHOLD + 1, MULTIPART_THRESHOLD), true)
})
```

- [ ] **Step 2: Run the upload policy test and verify red**

Run: `pnpm test -- test/upload-policy.test.js`

Expected: FAIL because the multipart constants are not exported and `MAX_UPLOAD_SIZE` is still 300 MiB.

- [ ] **Step 3: Add the exact policy constants**

Replace the current upload constant in `src/js/constants.js` with:

```js
export const MAX_UPLOAD_SIZE = 5 * 1024 ** 3 // 5 GiB
export const MULTIPART_THRESHOLD = 100 * 1024 ** 2 // 100 MiB
export const MULTIPART_PART_SIZE = 16 * 1024 ** 2 // 16 MiB
export const MULTIPART_CONCURRENCY = 3
export const MULTIPART_MAX_RETRIES = 3
export const MULTIPART_RETRY_BASE_DELAY = 500
```

- [ ] **Step 4: Integrate transport selection and progress into `UploadManager`**

Import the new constants plus `shouldUseMultipart` and `uploadMultipart`. Keep the existing pre-compression 5 GiB rejection. After compression, select the transport:

```js
const result = shouldUseMultipart(compressed.size, MULTIPART_THRESHOLD)
  ? await this.#uploadMultipartFile(u.id, u.key, compressed, u.contentType, u.updateStatus)
  : await this.#uploadSingleFile(u.id, u.key, compressed, u.contentType)
```

Add the multipart adapter method:

```js
async #uploadMultipartFile(id, key, file, contentType, updateStatus) {
  const bar = $(`#${id}-bar`)
  try {
    await uploadMultipart({
      blob: file,
      partSize: MULTIPART_PART_SIZE,
      concurrency: MULTIPART_CONCURRENCY,
      maxRetries: MULTIPART_MAX_RETRIES,
      retryBaseDelay: MULTIPART_RETRY_BASE_DELAY,
      createUpload: () => this.#r2.createMultipartUpload(key, contentType),
      uploadPart: ({ uploadId, partNumber, body }) => this.#r2.uploadPart(key, uploadId, partNumber, body),
      completeUpload: ({ uploadId, parts }) => this.#r2.completeMultipartUpload(key, uploadId, parts),
      abortUpload: ({ uploadId }) => this.#r2.abortMultipartUpload(key, uploadId),
      onProgress: ({ loaded, total, percent }) => {
        if (bar) bar.style.width = `${percent}%`
        updateStatus(t('multipartUploading', {
          percent,
          loaded: filesize(loaded),
          total: filesize(total),
        }))
      },
    })
    if (bar) {
      bar.classList.add('done')
      bar.style.width = '100%'
    }
  } catch (error) {
    if (bar) bar.classList.add('error')
    throw error
  }
}
```

In each file task's catch block, retain the actionable ETag message instead of clearing the row:

```js
} catch (error) {
  if (error?.code === 'MULTIPART_ETAG_MISSING') {
    u.updateStatus(t('multipartEtagMissing'))
  } else {
    u.updateStatus('')
  }
  throw error
}
```

After the settled results are available, replace the existing success/partial-failure toast branch with:

```js
const etagMissing = results.some(
  (result) => result.status === 'rejected' && result.reason?.code === 'MULTIPART_ETAG_MISSING',
)
if (fail === 0) {
  this.#ui.toast(t('uploadSuccess', { count: success }), 'success')
} else if (etagMissing) {
  this.#ui.toast(t('multipartEtagMissing'), 'error')
} else {
  this.#ui.toast(t('uploadPartialFail', { success, fail }), 'error')
}
```

- [ ] **Step 5: Add localized copy in all four dictionaries**

Add these exact keys next to the existing upload strings in every dictionary:

```js
// Simplified Chinese
multipartUploading: '分片上传中 {percent}%（{loaded}/{total}）',
multipartEtagMissing: '无法读取分片 ETag，请在 R2 存储桶 CORS 的 ExposeHeaders 中添加 ETag',
fileTooLarge: '文件“{name}”超过 5 GiB 上传上限',

// English
multipartUploading: 'Multipart upload {percent}% ({loaded}/{total})',
multipartEtagMissing: 'Cannot read part ETag. Add ETag to ExposeHeaders in the R2 bucket CORS policy.',
fileTooLarge: '"{name}" exceeds the 5 GiB upload limit',

// Traditional Chinese
multipartUploading: '分片上傳中 {percent}%（{loaded}/{total}）',
multipartEtagMissing: '無法讀取分片 ETag，請在 R2 儲存桶 CORS 的 ExposeHeaders 中加入 ETag',
fileTooLarge: '檔案「{name}」超過 5 GiB 上傳上限',

// Japanese
multipartUploading: 'マルチパートアップロード中 {percent}%（{loaded}/{total}）',
multipartEtagMissing: 'パートの ETag を読み取れません。R2 バケットの CORS ポリシーで ExposeHeaders に ETag を追加してください',
fileTooLarge: '"{name}" は 5 GiB のアップロード上限を超えています',
```

- [ ] **Step 6: Run policy, scheduler, and client tests**

Run: `pnpm test`

Expected: all tests PASS.

- [ ] **Step 7: Commit upload integration**

```bash
git add src/js/constants.js src/js/multipart-uploader.js src/js/upload-manager.js src/js/i18n.js test/upload-policy.test.js
git commit -m "feat: upload large files in multipart chunks"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `readme.md:93-110,199-201`
- Modify: `readme-en.md:91-108,195-197`

**Interfaces:**
- Consumes: the final upload policy and runtime CORS error from Task 3.
- Produces: accurate setup and troubleshooting instructions for browser multipart upload.

- [ ] **Step 1: Update both README files**

Keep the existing allowed methods. Normalize English `ExposeHeaders` to `"ETag"`, explicitly state that multipart completion requires JavaScript to read that header, and replace the obsolete troubleshooting answers with:

```md
A: 检查 CORS 配置、凭证和文件大小。浏览器支持上传最大 5 GiB 的文件；超过 100 MiB 时会自动分片上传。如果大文件提示无法读取 ETag，请确认 CORS 的 `ExposeHeaders` 包含 `ETag`。
```

```md
A: Check the CORS policy, credentials, and file size. Browser uploads support files up to 5 GiB and automatically use multipart upload above 100 MiB. If a large upload reports that ETag cannot be read, ensure `ExposeHeaders` contains `ETag`.
```

- [ ] **Step 2: Run automated tests**

Run: `pnpm test`

Expected: all tests PASS with no skipped or cancelled tests.

- [ ] **Step 3: Run JavaScript type checking**

Run: `pnpm exec tsc --noEmit --project tsconfig.json`

Expected: exit code 0.

- [ ] **Step 4: Run formatting verification**

Run: `pnpm exec prettier --check "src/**/*.{js,json,css,md,html}" "test/**/*.js" "readme*.md"`

Expected: all matched files use Prettier formatting. If the check reports changed feature files, run the repository formatter on only those files and repeat the check.

- [ ] **Step 5: Inspect the final diff and run targeted source checks**

Run:

```bash
git diff --check
rg -n "300 ?MB|MAX_UPLOAD_SIZE|MULTIPART_|multipartEtagMissing|ExposeHeaders" src test readme.md readme-en.md
```

Expected: no whitespace errors, no remaining 300 MB upload guidance, exact policy values, four localized ETag messages, and `ExposeHeaders` present in both READMEs.

- [ ] **Step 6: Perform browser smoke tests with an R2 test bucket**

Verify these exact cases without using production-only credentials:

1. Upload a file below 100 MiB and confirm one object `PUT` occurs.
2. Upload a file above 100 MiB and confirm create, multiple part `PUT`s, and complete requests occur.
3. Confirm multipart progress advances and reaches 100%.
4. Temporarily use a test-bucket CORS policy without `ExposeHeaders: ["ETag"]`, confirm the localized guidance appears, then restore the policy.
5. Confirm the failed incomplete upload is aborted.

- [ ] **Step 7: Commit documentation and verification fixes**

```bash
git add readme.md readme-en.md
git commit -m "docs: explain browser multipart upload requirements"
```
