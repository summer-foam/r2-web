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
