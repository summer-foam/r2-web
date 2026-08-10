import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_UPLOAD_SIZE, MULTIPART_THRESHOLD } from '../src/js/constants.js'
import { isUploadSizeAllowed, shouldUseMultipart } from '../src/js/multipart-uploader.js'

test('accepts exactly 5 GiB and rejects the next byte', () => {
  const fiveGiB = 5 * 1024 ** 3
  assert.equal(isUploadSizeAllowed(fiveGiB, MAX_UPLOAD_SIZE), true)
  assert.equal(isUploadSizeAllowed(fiveGiB + 1, MAX_UPLOAD_SIZE), false)
})

test('uses multipart only above the threshold', () => {
  const oneHundredMiB = 100 * 1024 ** 2
  assert.equal(shouldUseMultipart(oneHundredMiB, MULTIPART_THRESHOLD), false)
  assert.equal(shouldUseMultipart(oneHundredMiB + 1, MULTIPART_THRESHOLD), true)
})
