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
  assert.deepEqual(
    received.map((part) => part.partNumber),
    [1, 2, 3],
  )
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

test('does not retry an unannotated non-network failure', async () => {
  let attempts = 0
  const expected = new Error('programming failure')
  const options = baseOptions({
    blob: new Blob([new Uint8Array(5)]),
    uploadPart: async () => {
      attempts++
      throw expected
    },
  })
  await assert.rejects(uploadMultipart(options), (error) => error === expected)
  assert.equal(attempts, 1)
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
