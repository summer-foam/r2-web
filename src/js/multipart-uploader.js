/** @param {number} delay */
const defaultSleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

/** @param {number} size @param {number} threshold */
export function shouldUseMultipart(size, threshold) {
  return size > threshold
}

/** @param {number} size @param {number} maxSize */
export function isUploadSizeAllowed(size, maxSize) {
  return size <= maxSize
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
        if (error?.retryable !== true || attempt >= maxRetries) throw error
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
        failure ??= error
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
