import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
}

const utils = await import('../src/js/utils.js')

test('does not read file bytes when the filename template has no hash token', async () => {
  const file = {
    name: 'photo.jpg',
    arrayBuffer: async () => {
      throw new Error('file bytes should not be read')
    },
  }

  assert.equal(await utils.applyFilenameTemplate('[name].[ext]', file), 'photo.jpg')
})

test('identifies only hash templates above the multipart threshold as unsafe', () => {
  const threshold = 100

  assert.equal(utils.isFilenameHashTooLarge?.('[name]-[hash].[ext]', threshold, threshold), false)
  assert.equal(utils.isFilenameHashTooLarge?.('[hash:12].[ext]', threshold + 1, threshold), true)
  assert.equal(utils.isFilenameHashTooLarge?.('[name].[ext]', threshold + 1, threshold), false)
  assert.equal(utils.isFilenameHashTooLarge?.('[hash:abc].[ext]', threshold + 1, threshold), false)
})

test('bypasses filename templates when an explicit upload key is provided', () => {
  const hashTemplate = '[name]-[hash].[ext]'
  const threshold = 100

  for (const [scope, name] of [
    ['all', 'archive.bin'],
    ['images', 'photo.jpg'],
  ]) {
    const shouldApply = utils.shouldApplyFilenameTemplate?.(scope, name, true)
    assert.equal(shouldApply, false)
    assert.equal(shouldApply && utils.isFilenameHashTooLarge(hashTemplate, threshold + 1, threshold), false)
  }
})

test('keeps normal filename template scope behavior without an explicit upload key', () => {
  assert.equal(utils.shouldApplyFilenameTemplate?.('all', 'archive.bin', false), true)
  assert.equal(utils.shouldApplyFilenameTemplate?.('images', 'photo.jpg', false), true)
  assert.equal(utils.shouldApplyFilenameTemplate?.('images', 'archive.bin', false), false)
})
