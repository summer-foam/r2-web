import test from 'node:test'
import assert from 'node:assert/strict'
import { MULTIPART_THRESHOLD } from '../src/js/constants.js'

class FakeElement {
  constructor(register) {
    this.hidden = false
    this.textContent = ''
    this.style = {}
    this.classList = {
      add() {},
      remove() {},
    }
    this.#register = register
  }

  #register
  #nameElement = null

  set innerHTML(value) {
    if (!value) return

    this.#nameElement = new FakeElement(this.#register)
    for (const id of value.matchAll(/id="([^"]+)"/g)) {
      this.#register(id[1], new FakeElement(this.#register))
    }
  }

  querySelector(selector) {
    return selector === '.upload-item-name' ? this.#nameElement : null
  }

  appendChild(element) {
    if (element.id) this.#register(element.id, element)
  }

  setAttribute() {}
}

test('keeps the generic upload status while multipart progress changes', async () => {
  const elements = new Map()
  const register = (id, element) => elements.set(id, element)
  for (const id of ['upload-panel', 'upload-panel-body', 'upload-panel-title']) {
    register(id, new FakeElement(register))
  }

  globalThis.document = {
    createElement: () => new FakeElement(register),
    querySelector: (selector) => elements.get(selector.slice(1)) ?? null,
  }
  globalThis.localStorage = {
    getItem: () => 'en',
    setItem() {},
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'en' },
  })

  const { UploadManager } = await import('../src/js/upload-manager.js')
  let initialStatus
  let statusAfterProgress
  const currentStatus = () => [...elements.entries()].find(([id]) => id.endsWith('-status'))?.[1].textContent
  const r2 = {
    fileExists: async () => false,
    createMultipartUpload: async () => {
      initialStatus = currentStatus()
      return 'upload-1'
    },
    uploadPart: async (_key, _uploadId, partNumber) => `etag-${partNumber}`,
    completeMultipartUpload: async () => {
      statusAfterProgress = currentStatus()
    },
    abortMultipartUpload: async () => {},
  }
  const ui = { toast() {} }
  const explorer = { currentPrefix: '', refresh: async () => {} }
  const config = {
    get: () => ({
      filenameTpl: '',
      filenameTplScope: 'images',
      compressMode: 'none',
      uploadConcurrency: 1,
    }),
  }
  const file = {
    name: 'large.bin',
    type: 'application/octet-stream',
    size: MULTIPART_THRESHOLD + 1,
    slice: (start, end) => ({ size: end - start }),
  }

  await new UploadManager(r2, ui, explorer, config).uploadFiles([file])

  assert.equal(initialStatus, 'Uploading...')
  assert.equal(statusAfterProgress, initialStatus)
})
