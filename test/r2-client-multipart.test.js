import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
}

const { R2Client } = await import('../src/js/r2-client.js')

function setup(responses) {
  const requests = []
  const signer = { sign: async (url, init) => new Request(url, init) }
  const client = new R2Client({
    clientFactory: () => signer,
    fetchImpl: async (request) => {
      requests.push(request)
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
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

test('marks fetch network failures as retryable', async () => {
  const networkError = new TypeError('fetch failed')
  const { client } = setup([networkError])
  await assert.rejects(client.createMultipartUpload('a.bin', 'application/octet-stream'), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.retryable, true)
    assert.equal(error.cause, networkError)
    return true
  })
})
